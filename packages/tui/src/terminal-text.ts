const ESCAPE_CONTROL_SEQUENCE = /\x1b(?:\][\s\S]*?(?:\x07|\x1b\\)|[PX^_][\s\S]*?\x1b\\|\[[0-?]*[ -/]*[@-~])/g;
const C1_CONTROL_SEQUENCE = /(?:[\x90\x98\x9d\x9e\x9f][\s\S]*?(?:\x07|\x9c)|\x9b[0-?]*[ -/]*[@-~])/g;

/** Strip terminal control sequences from untrusted stack names and application logs. */
export function sanitizeFleetTerminalText(text: string, preserveNewlines = false): string {
  const controls = preserveNewlines
    ? /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g
    : /[\x00-\x1f\x7f-\x9f]/g;
  return text
    .replace(ESCAPE_CONTROL_SEQUENCE, "")
    .replace(C1_CONTROL_SEQUENCE, "")
    .replace(controls, "");
}
