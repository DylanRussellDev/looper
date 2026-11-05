import { toAudioErrorCode } from './audio-errors';

describe('toAudioErrorCode', () => {
  it('maps a blocked permission', () => {
    expect(toAudioErrorCode(new DOMException('denied', 'NotAllowedError'))).toBe(
      'permission-denied',
    );
  });

  it('maps a missing device', () => {
    expect(toAudioErrorCode(new DOMException('missing', 'NotFoundError'))).toBe('no-input-device');
    expect(toAudioErrorCode(new DOMException('gone', 'OverconstrainedError'))).toBe(
      'no-input-device',
    );
  });

  it('treats anything else as an unavailable device', () => {
    expect(toAudioErrorCode(new DOMException('busy', 'NotReadableError'))).toBe(
      'device-unavailable',
    );
    expect(toAudioErrorCode(new Error('unknown'))).toBe('device-unavailable');
  });
});
