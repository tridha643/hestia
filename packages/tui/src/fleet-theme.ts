/**
 * Fixed github-dark palette per the TUI spec (`hestia-tui.html`) — one theme,
 * no selector. Semantic tokens are blended from the two anchors (hunk-style)
 * instead of hand-picking every surface, so related surfaces stay in tune.
 */

/** Blend `fg` into `bg` by `amount` (0..1) in sRGB space. */
export function blendHex(fg: string, bg: string, amount: number): string {
  const parse = (hex: string): [number, number, number] => [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
  const [fr, fg2, fb] = parse(fg);
  const [br, bg2, bb] = parse(bg);
  const channel = (f: number, b: number) => Math.round(b + (f - b) * amount);
  const hex = (value: number) => value.toString(16).padStart(2, "0");
  return `#${hex(channel(fr, br))}${hex(channel(fg2, bg2))}${hex(channel(fb, bb))}`;
}

const background = "#0d1117";
const text = "#c9d1d9";
const accent = "#58a6ff";

export const fleetTheme = {
  background,
  panel: blendHex(text, background, 0.04),
  panelAlt: blendHex(text, background, 0.1),
  border: blendHex(text, background, 0.18),
  text,
  bright: "#e6edf3",
  muted: "#8b949e",
  faint: "#6e7681",
  accent,
  /** Subtle selected-row wash; row text keeps its semantic colors on top. */
  selectedBg: blendHex(accent, background, 0.16),
  /** One-cell selection stripe at the row edge (hunk's selection affordance). */
  stripe: accent,
  keycapBg: blendHex(text, background, 0.22),
  healthy: "#3fb950",
  warning: "#d29922",
  danger: "#f85149",
  queued: "#bc8cff",
  backendDocker: "#58a6ff",
  backendProc: "#bc8cff",
  backendWrangler: "#bc8cff",
  backendTunnel: "#ffa657",
  publicBadge: "#ffa657",
} as const;

export function backendColor(backend: string): string {
  if (backend === "docker") return fleetTheme.backendDocker;
  if (backend === "tunnel") return fleetTheme.backendTunnel;
  if (backend === "wrangler" || backend === "proc") return fleetTheme.backendProc;
  return fleetTheme.muted;
}

export function serviceStateColor(state: string): string {
  if (state === "healthy") return fleetTheme.healthy;
  if (state === "unknown" || state === "unhealthy" || state === "starting") return fleetTheme.warning;
  return fleetTheme.danger;
}

export function serviceStateGlyph(state: string): string {
  if (state === "healthy") return "●";
  if (state === "unhealthy") return "◆";
  if (state === "starting") return "◌";
  return "○";
}

export function stackPhaseColor(phase: string): string {
  if (phase === "up") return fleetTheme.healthy;
  if (phase === "degraded" || phase === "unknown" || phase === "starting") return fleetTheme.warning;
  if (phase === "queued" || phase === "reserved") return fleetTheme.queued;
  if (phase === "stopped") return fleetTheme.faint;
  return fleetTheme.accent;
}

/** Braille frames for live `starting` phases; static glyphs everywhere else. */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export function stackPhaseGlyph(phase: string, spinnerFrame = 0): string {
  if (phase === "up") return "●";
  if (phase === "degraded") return "◆";
  if (phase === "starting") return SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]!;
  if (phase === "queued" || phase === "reserved") return "◌";
  if (phase === "stopped") return "○";
  return "○";
}
