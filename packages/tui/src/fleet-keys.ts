/**
 * Named key predicates for the Fleet keyboard scope chain (hunk's model:
 * central predicates normalize terminal quirks; handlers stay declarative).
 */

export interface FleetKeyEvent {
  name: string;
  sequence?: string;
  shift?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  option?: boolean;
  super?: boolean;
  hyper?: boolean;
}

export function isEscapeKey(key: FleetKeyEvent): boolean {
  const name = key.name.toLowerCase();
  return name === "escape" || name === "esc" || key.sequence === "\x1b";
}

export function isEnterKey(key: FleetKeyEvent): boolean {
  return key.name === "return" || key.name === "enter";
}

/** Bare printable key with no modifier chords held. */
export function isPlainKey(key: FleetKeyEvent, value: string): boolean {
  return !key.ctrl && !key.meta && !key.option && !key.super && !key.hyper &&
    (key.name === value || key.sequence === value);
}

export function isUpKey(key: FleetKeyEvent): boolean {
  return key.name === "up" || isPlainKey(key, "k");
}

export function isDownKey(key: FleetKeyEvent): boolean {
  return key.name === "down" || isPlainKey(key, "j");
}

/**
 * Shifted printable, robust across keyboard protocols: some report only the
 * uppercase sequence, others only the lowercase name plus a shift flag.
 */
export function isShiftedKey(key: FleetKeyEvent, lower: string): boolean {
  return key.sequence === lower.toUpperCase() ||
    (isPlainKey(key, lower) && key.shift === true);
}

export function isFollowBottomKey(key: FleetKeyEvent): boolean {
  return isShiftedKey(key, "g");
}

export function isScrollTopKey(key: FleetKeyEvent): boolean {
  return !isShiftedKey(key, "g") && (key.sequence === "g" || isPlainKey(key, "g"));
}

export function isDoctorKey(key: FleetKeyEvent): boolean {
  return isShiftedKey(key, "d");
}

/** Full-page upward log scroll. */
export function isPageUpKey(key: FleetKeyEvent): boolean {
  return key.name.toLowerCase() === "pageup";
}

/** Full-page downward log scroll. */
export function isPageDownKey(key: FleetKeyEvent): boolean {
  return key.name.toLowerCase() === "pagedown";
}

/** Half-page upward log scroll, matching common terminal viewers. */
export function isHalfPageUpKey(key: FleetKeyEvent): boolean {
  return key.ctrl === true && key.name.toLowerCase() === "u";
}

/** Half-page downward log scroll, matching common terminal viewers. */
export function isHalfPageDownKey(key: FleetKeyEvent): boolean {
  return key.ctrl === true && key.name.toLowerCase() === "d";
}
