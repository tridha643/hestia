import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { installFleetSuspend } from "../src/job-control.ts";

describe("Fleet job control", () => {
  test("Ctrl-Z suspends the renderer and SIGCONT resumes it", () => {
    let keyListener: ((key: KeyEvent) => void) | undefined;
    let continueListener: (() => void) | undefined;
    let suspended = 0;
    let resumed = 0;
    const signals: Array<[number, NodeJS.Signals]> = [];
    const renderer = {
      isDestroyed: false,
      suspend: () => { suspended += 1; },
      resume: () => { resumed += 1; },
      keyInput: {
        on: (_event: "keypress", listener: (key: KeyEvent) => void) => { keyListener = listener; },
        off: () => {},
      },
    };
    const dispose = installFleetSuspend(renderer, {
      platform: "darwin",
      kill: (pid, signal) => { signals.push([pid, signal]); },
      once: (_signal, listener) => { continueListener = listener; },
      off: () => {},
    });
    keyListener?.({
      name: "z",
      ctrl: true,
      meta: false,
      shift: false,
      preventDefault() {},
      stopPropagation() {},
    } as KeyEvent);
    expect(suspended).toBe(1);
    expect(signals).toEqual([[0, "SIGTSTP"]]);
    continueListener?.();
    expect(resumed).toBe(1);
    dispose();
  });
});
