/**
 * Text without terminal control: a session's tool output in colour (`\x1b[31m`), a title pasted
 * with a bell. Escape sequences (CSI, OSC and the other strings (DCS, APC, …), in their 7-bit and
 * C1 forms, the two-byte ones) go whole; any other C0 or C1
 * control but newline and tab becomes `\ufffd`; a CRLF is a newline. What the snapshot writes to
 * git, and the excerpts a search answers, carry none: a pane drawing them would be refused.
 */
export function withoutControls(text: string): string {
  return text.replace(ESCAPES, '').replace(/\r\n/g, '\n').replace(CONTROLS, '\ufffd');
}

const ESCAPES =
  // eslint-disable-next-line no-control-regex
  /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|(?:\x1b[P\]X^_]|[\x90\x98\x9d-\x9f])[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?|\x1b[ -/]*[0-~]/g;
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
