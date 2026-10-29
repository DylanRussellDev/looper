export type AudioErrorCode =
  | 'unsupported'
  | 'start-failed'
  | 'permission-denied'
  | 'no-input-device'
  | 'device-unavailable'
  | 'device-unplugged'
  | 'recorder-failed';

export const AUDIO_ERROR_MESSAGES: Record<AudioErrorCode, string> = {
  unsupported: 'This browser cannot record live audio. Use the latest desktop Chrome or Edge.',
  'start-failed': 'The audio engine could not start. Reload the page and try again.',
  'permission-denied':
    'Microphone access is blocked. Allow microphone access for this site from the icon in the address bar, then try again.',
  'no-input-device':
    'No audio input was found. Connect an audio interface or microphone, then try again.',
  'device-unavailable':
    'The selected input could not be opened. Another app may be using it. Choose another input or try again.',
  'device-unplugged':
    'The input device was disconnected. Reconnect it or choose another input. Your loops are still playing.',
  'recorder-failed':
    'The recorder stopped working, so nothing new can be recorded and your input is no longer heard. Your loops are still playing. Reload the page to record again.',
};

/** Maps a getUserMedia rejection to a user-facing error code. */
export function toAudioErrorCode(error: unknown): AudioErrorCode {
  if (error instanceof DOMException) {
    switch (error.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'permission-denied';
      case 'NotFoundError':
      case 'OverconstrainedError':
        return 'no-input-device';
    }
  }
  return 'device-unavailable';
}
