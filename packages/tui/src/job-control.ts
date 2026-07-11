import type { CliRenderer, KeyEvent } from "@opentui/core";

type FleetJobRenderer = Pick<CliRenderer, "isDestroyed" | "resume" | "suspend"> & {
  keyInput: {
    on(event: "keypress", listener: (key: KeyEvent) => void): unknown;
    off(event: "keypress", listener: (key: KeyEvent) => void): unknown;
  };
};

export interface FleetSuspendDependencies {
  platform?: string;
  kill?: (pid: number, signal: NodeJS.Signals) => unknown;
  once?: (signal: NodeJS.Signals, listener: () => void) => unknown;
  off?: (signal: NodeJS.Signals, listener: () => void) => unknown;
}

/** Route raw-mode Ctrl-C through the TUI's complete renderer shutdown path. */
export function installFleetInterrupt(
  renderer: Pick<FleetJobRenderer, "isDestroyed" | "keyInput">,
  shutdown: () => void,
): () => void {
  const listener = (key: KeyEvent) => {
    if (renderer.isDestroyed || !key.ctrl || key.name !== "c") return;
    key.preventDefault();
    key.stopPropagation();
    shutdown();
  };
  renderer.keyInput.on("keypress", listener);
  return () => renderer.keyInput.off("keypress", listener);
}

/** Restore the terminal around Ctrl-Z so shell job control behaves like a native TUI. */
export function installFleetSuspend(
  renderer: FleetJobRenderer,
  dependencies: FleetSuspendDependencies = {},
): () => void {
  if ((dependencies.platform ?? process.platform) === "win32") return () => {};
  const kill = dependencies.kill ?? process.kill.bind(process);
  const once = dependencies.once ?? process.once.bind(process);
  const off = dependencies.off ?? process.off.bind(process);
  let resume: (() => void) | undefined;
  const listener = (key: KeyEvent) => {
    if (renderer.isDestroyed || !key.ctrl || key.name !== "z") return;
    key.preventDefault();
    key.stopPropagation();
    renderer.suspend();
    resume = () => {
      resume = undefined;
      if (!renderer.isDestroyed) renderer.resume();
    };
    once("SIGCONT", resume);
    try {
      kill(0, "SIGTSTP");
    } catch {
      if (resume !== undefined) off("SIGCONT", resume);
      resume = undefined;
      if (!renderer.isDestroyed) renderer.resume();
    }
  };
  renderer.keyInput.on("keypress", listener);
  return () => {
    renderer.keyInput.off("keypress", listener);
    if (resume !== undefined) off("SIGCONT", resume);
  };
}
