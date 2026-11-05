// Inside these, keys belong to the control: typing a number into the latency field or
// arrowing through the device list must not press a footswitch.
const FORM_CONTROL_SELECTOR =
  'input, select, textarea, [contenteditable]:not([contenteditable="false"])';

/**
 * Whether a key event may trigger a looper shortcut: not from a form control, and not
 * part of a browser or OS shortcut (Ctrl+Z, Cmd+Y, Alt+1...). Key repeat is checked by
 * the caller, because a key-up must still end a hold.
 */
export function isShortcutKeyEvent(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return false;
  }
  const { target } = event;
  return !(target instanceof Element && target.closest(FORM_CONTROL_SELECTOR) !== null);
}
