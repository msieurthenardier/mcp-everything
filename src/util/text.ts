/** Text hygiene for content that originates inside a sandbox (untrusted). */

// CSI / OSC escape sequences, then any stray single-char escapes.
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** Remove man-page style overstrike (`x\bx`, `_\bx`) and other control chars. */
export function cleanTerminalText(text: string): string {
  return stripAnsi(text)
    .replace(/.\u0008/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "        ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "");
}

/** Collapse to one line and cap length; used for tool descriptions. */
export function oneLine(text: string, max: number): string {
  const flat = cleanTerminalText(text).replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
