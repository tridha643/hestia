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
