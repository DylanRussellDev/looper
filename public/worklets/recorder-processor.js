/**
 * Recorder processor: runs on the audio rendering thread, not the main thread.
 *
 * The browser calls `process()` once per "render quantum" (128 frames, about 2.7 ms at
 * 48 kHz). Anything slow here (allocating memory, triggering garbage collection, posting
 * lots of messages) can make the audio thread miss its deadline, which you hear as a
 * crackle. So this file follows a few rules:
 *
 * - Recording buffers are allocated up front and reused through a small pool.
 * - Full buffers are handed to the main thread as *transferables*: ownership of the
 *   memory moves across threads instead of being copied.
 * - The main thread copies the audio out and sends the buffer back ("recycle"), so in
 *   steady state nothing new is allocated while recording.
 *
 * Timing uses the worklet global `currentFrame`: the sample index of the first frame in
 * the current quantum, on the same clock as `AudioContext.currentTime * sampleRate`.
 * Every take carries an exact start and stop frame, which is what lets the looper line
 * recordings up with the loop to the sample.
 *
 * Pre-roll history: every input sample also goes into a ring buffer holding the last
 * second of audio. Takes are copied out of that history rather than straight from the
 * input, so a start frame that is already a few milliseconds in the past when its message
 * arrives (the main thread is never perfectly in step) is still honoured exactly.
 *
 * Several takes can run at once (e.g. two tracks armed for the same loop boundary).
 *
 * Message protocol (mirrored in src/app/features/looper/audio/recorder-messages.ts):
 *   in:  record { takeId, startFrame } | stop { takeId, stopFrame } | cancel { takeId }
 *        | recycle { chunk }
 *   out: started { takeId, startFrame } | chunk { takeId, chunk, length }
 *        | recorded { takeId, startFrame, lengthFrames } | level { peak, rms }
 */

// Spare chunks for all concurrent takes; the main thread returns each within milliseconds.
const CHUNK_POOL_SIZE = 8;

class RecorderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { chunkFrames, historyFrames, levelIntervalFrames } = options.processorOptions;

    this.chunkFrames = chunkFrames;
    this.chunkPool = Array.from({ length: CHUNK_POOL_SIZE }, () => new Float32Array(chunkFrames));

    this.historyFrames = historyFrames;
    this.history = new Float32Array(historyFrames);
    // Frame number just after the newest sample in the history.
    this.historyEndFrame = 0;

    this.takes = [];

    // The level meter is accumulated over several quanta and posted about 30 times per
    // second. That is smooth enough for the eye without flooding the message port.
    this.levelIntervalFrames = levelIntervalFrames;
    this.levelPeak = 0;
    this.levelSumSquares = 0;
    this.levelFrames = 0;

    this.port.onmessage = (event) => this.handleCommand(event.data);
  }

  handleCommand(command) {
    switch (command.type) {
      case 'record':
        // Commands are rare (one per footswitch press), so allocating here is fine.
        this.takes.push({
          takeId: command.takeId,
          startFrame: command.startFrame,
          stopFrame: Infinity,
          nextFrame: command.startFrame,
          recordedFrames: 0,
          hasStarted: false,
          chunk: null,
          chunkIndex: 0,
        });
        break;
      case 'stop': {
        const take = this.findTake(command.takeId);
        if (take) {
          take.stopFrame = command.stopFrame;
        }
        break;
      }
      case 'cancel': {
        const index = this.takes.findIndex((take) => take.takeId === command.takeId);
        if (index !== -1) {
          const [take] = this.takes.splice(index, 1);
          if (take.chunk !== null) {
            this.chunkPool.push(take.chunk);
          }
        }
        break;
      }
      case 'recycle':
        if (command.chunk.length === this.chunkFrames) {
          this.chunkPool.push(command.chunk);
        }
        break;
    }
  }

  process(inputs) {
    // With no source connected (e.g. the device was unplugged) the input has zero
    // channels. We treat that as silence so the timeline keeps moving.
    const samples = inputs[0]?.[0];
    const blockFrames = samples?.length ?? 128;

    this.writeHistory(samples, blockFrames);
    this.measureLevel(samples, blockFrames);
    // Backwards so finished takes can be removed while iterating.
    for (let i = this.takes.length - 1; i >= 0; i--) {
      this.serviceTake(this.takes[i], i);
    }

    // Returning true keeps the processor alive even when its input goes silent.
    return true;
  }

  writeHistory(samples, blockFrames) {
    const blockStart = currentFrame;
    for (let i = 0; i < blockFrames; i++) {
      this.history[(blockStart + i) % this.historyFrames] = samples ? samples[i] : 0;
    }
    this.historyEndFrame = blockStart + blockFrames;
  }

  serviceTake(take, index) {
    const availableEnd = this.historyEndFrame;
    if (take.startFrame >= availableEnd) {
      return;
    }

    if (!take.hasStarted) {
      // A start older than the whole history should never happen; if it does, start from
      // the oldest audio we still have and report the real start frame.
      take.startFrame = Math.max(take.startFrame, availableEnd - this.historyFrames);
      take.nextFrame = take.startFrame;
      take.hasStarted = true;
      this.port.postMessage({ type: 'started', takeId: take.takeId, startFrame: take.startFrame });
    }

    const copyEnd = Math.min(take.stopFrame, availableEnd);
    if (copyEnd > take.nextFrame) {
      this.copyHistory(take, take.nextFrame, copyEnd);
      take.nextFrame = copyEnd;
    }

    if (take.stopFrame <= availableEnd) {
      this.finishTake(take, index);
    }
  }

  copyHistory(take, fromFrame, toFrame) {
    let frame = fromFrame;
    while (frame < toFrame) {
      if (take.chunk === null) {
        // Pool exhausted (main thread busy): allocating is better than dropping audio.
        take.chunk = this.chunkPool.pop() ?? new Float32Array(this.chunkFrames);
        take.chunkIndex = 0;
      }

      // Copy the largest run that fits the chunk and doesn't cross the ring's wrap point.
      const ringIndex = frame % this.historyFrames;
      const count = Math.min(
        toFrame - frame,
        this.chunkFrames - take.chunkIndex,
        this.historyFrames - ringIndex,
      );
      take.chunk.set(this.history.subarray(ringIndex, ringIndex + count), take.chunkIndex);
      take.chunkIndex += count;
      take.recordedFrames += count;
      frame += count;

      if (take.chunkIndex === this.chunkFrames) {
        this.postChunk(take);
      }
    }
  }

  postChunk(take) {
    const chunk = take.chunk;
    // The second argument transfers the ArrayBuffer: zero-copy, but `chunk` becomes
    // unusable here until the main thread sends it back.
    this.port.postMessage({ type: 'chunk', takeId: take.takeId, chunk, length: take.chunkIndex }, [
      chunk.buffer,
    ]);
    take.chunk = null;
    take.chunkIndex = 0;
  }

  finishTake(take, index) {
    if (take.chunk !== null && take.chunkIndex > 0) {
      this.postChunk(take);
    }
    // A stop frame that arrived late trims the take back to that frame.
    const lengthFrames = Math.min(
      take.recordedFrames,
      Math.max(0, take.stopFrame - take.startFrame),
    );
    this.port.postMessage({
      type: 'recorded',
      takeId: take.takeId,
      startFrame: take.startFrame,
      lengthFrames,
    });
    this.takes.splice(index, 1);
  }

  findTake(takeId) {
    for (const take of this.takes) {
      if (take.takeId === takeId) {
        return take;
      }
    }
    return undefined;
  }

  measureLevel(samples, blockFrames) {
    if (samples) {
      for (let i = 0; i < samples.length; i++) {
        const sample = samples[i];
        const magnitude = sample < 0 ? -sample : sample;
        if (magnitude > this.levelPeak) {
          this.levelPeak = magnitude;
        }
        this.levelSumSquares += sample * sample;
      }
    }
    this.levelFrames += blockFrames;

    if (this.levelFrames >= this.levelIntervalFrames) {
      this.port.postMessage({
        type: 'level',
        peak: this.levelPeak,
        rms: Math.sqrt(this.levelSumSquares / this.levelFrames),
      });
      this.levelPeak = 0;
      this.levelSumSquares = 0;
      this.levelFrames = 0;
    }
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
