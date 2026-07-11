import { Component, type ErrorInfo, type ReactNode } from "react";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { HestiaError, projectName } from "@hestia/core";
import { getRepoInfo } from "@hestia/engine";
import { DaemonFleetSource } from "./fleet-source.ts";
import { FleetApp } from "./FleetApp.tsx";
import { installFleetInterrupt, installFleetSuspend } from "./job-control.ts";

class FleetErrorBoundary extends Component<
  { children: ReactNode; onError: (error: Error) => void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    this.props.onError(error);
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

/** Run the alternate-screen Fleet TUI and restore the primary terminal on every exit path. */
export async function runFleetTui(cwd = process.cwd()): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new HestiaError("usage", "hestia tui requires interactive stdin and stdout");
  }
  const repo = await getRepoInfo(cwd);
  const preferredProject = projectName(repo.repoId, repo.repo, repo.branch, repo.worktreeRoot);
  const source = new DaemonFleetSource(repo.repoId);
  const renderer = await createCliRenderer({
    stdin: process.stdin,
    stdout: process.stdout,
    screenMode: "alternate-screen",
    useMouse: true,
    useThread: false,
    exitOnCtrlC: false,
    openConsoleOnError: false,
  });
  const root = createRoot(renderer);

  await new Promise<void>((resolve, reject) => {
    let shuttingDown = false;
    let removeInterrupt = () => {};
    let removeSuspend = () => {};
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
    const shutdown = (error?: Error) => {
      if (shuttingDown) return;
      shuttingDown = true;
      for (const signal of signals) process.off(signal, shutdown);
      removeInterrupt();
      removeSuspend();
      source.stop();
      try {
        root.unmount();
      } finally {
        renderer.destroy();
      }
      if (error !== undefined) reject(error);
      else resolve();
    };
    for (const signal of signals) process.once(signal, shutdown);
    removeInterrupt = installFleetInterrupt(renderer, shutdown);
    removeSuspend = installFleetSuspend(renderer);
    root.render(
      <FleetErrorBoundary onError={(error) => shutdown(error)}>
        <FleetApp
          source={source}
          preferredProject={preferredProject}
          invokingRepository={{
            repo: repo.repo,
            branch: repo.branch,
            worktree: repo.worktreeRoot,
          }}
          onQuit={shutdown}
        />
      </FleetErrorBoundary>,
    );
  });
}
