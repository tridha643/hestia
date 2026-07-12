const ESCAPE_CONTROL_SEQUENCE = /\x1b(?:\][\s\S]*?(?:\x07|\x1b\\)|[PX^_][\s\S]*?\x1b\\|\[[0-?]*[ -/]*[@-~])/g;
const C1_CONTROL_SEQUENCE = /(?:[\x90\x98\x9d\x9e\x9f][\s\S]*?(?:\x07|\x9c)|\x9b[0-?]*[ -/]*[@-~])/g;

/**
 * Collapse TTY carriage-return overwrites so wrangler/vite progress lines do not
 * garble into interleaved fragments in the log pane.
 */
function collapseCarriageReturns(text: string): string {
  if (!text.includes("\r")) return text;
  return text
    .split("\n")
    .map((line) => {
      // A trailing \r (CRLF sources) is a line terminator, not an overwrite.
      const parts = line.replace(/\r+$/, "").split("\r");
      return parts[parts.length - 1] ?? "";
    })
    .join("\n");
}

/** Strip terminal control sequences from untrusted stack names and application logs. */
export function sanitizeFleetTerminalText(text: string, preserveNewlines = false): string {
  const withoutEscapes = text
    .replace(ESCAPE_CONTROL_SEQUENCE, "")
    .replace(C1_CONTROL_SEQUENCE, "");
  const collapsed = collapseCarriageReturns(withoutEscapes);
  const controls = preserveNewlines
    ? /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g
    : /[\x00-\x1f\x7f-\x9f]/g;
  return collapsed.replace(controls, "");
}
