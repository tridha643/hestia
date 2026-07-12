import stringWidth from "string-width";

/** Crop terminal text by display cells rather than JavaScript code-unit length. */
export function fitFleetText(text: string, width: number): string {
  if (width <= 0) return "";
  if (stringWidth(text) <= width) return text;
  const suffix = width > 1 ? "…" : "";
  let result = "";
  for (const character of Array.from(text)) {
    if (stringWidth(result + character + suffix) > width) break;
    result += character;
  }
  return result + suffix;
}

/** Pad terminal text to an exact display-cell width. */
export function padFleetText(text: string, width: number): string {
  const fitted = fitFleetText(text, width);
  return fitted + " ".repeat(Math.max(0, width - stringWidth(fitted)));
}

/**
 * Wrap text into display-cell rows. The final row is ellipsis-truncated when the
 * source still has more content — keeps log panes readable without horizontal bleed.
 */
export function wrapFleetText(text: string, width: number, maxLines = 3): string[] {
  if (width <= 0) return [];
  if (text === "") return [""];
  if (stringWidth(text) <= width) return [text];

  const characters = Array.from(text);
  const lines: string[] = [];
  let index = 0;
  while (index < characters.length && lines.length < maxLines) {
    const last = lines.length === maxLines - 1;
    if (last) {
      lines.push(fitFleetText(characters.slice(index).join(""), width));
      break;
    }
    let line = "";
    let taken = 0;
    while (index + taken < characters.length) {
      const next = characters[index + taken]!;
      if (stringWidth(line + next) > width) break;
      line += next;
      taken += 1;
    }
    if (taken === 0) {
      // A single glyph wider than the pane still has to move the cursor,
      // or the rest of the line silently vanishes.
      lines.push(characters[index]!);
      index += 1;
      continue;
    }
    lines.push(line);
    index += taken;
  }
  return lines;
}
