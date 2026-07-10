import { spawn } from "node:child_process";

export type ComposeLogEvent =
  | { kind: "line"; text: string }
  | { kind: "meta"; text: string };

export interface ComposeLogOptions {
  follow?: boolean;
  tail?: number;
  signal?: AbortSignal;
}

/** Stream one compose service incrementally without requiring compose files or a cwd. */
export async function* composeLogLines(
  project: string,
  service: string,
  options: ComposeLogOptions = {},
): AsyncGenerator<ComposeLogEvent> {
  const args = [
    "compose",
    "-p",
    project,
    "logs",
    "--no-color",
    "--no-log-prefix",
    "--tail",
    String(Math.max(0, options.tail ?? 50)),
  ];
  if (options.follow) args.push("--follow");
  args.push(service);

  const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
  const completion = new Promise<number | null>((resolve) => child.once("close", resolve));
  let stderr = "";
  let spawnErrorMessage: string | undefined;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4096);
  });
  child.once("error", (error) => {
    spawnErrorMessage = error.message;
  });
  const abort = () => child.kill("SIGTERM");
  options.signal?.addEventListener("abort", abort, { once: true });

  try {
    let pending = "";
    child.stdout.setEncoding("utf8");
    for await (const chunk of child.stdout) {
      pending += chunk as string;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const text of lines) yield { kind: "line", text };
    }
    if (pending !== "") yield { kind: "line", text: pending };
    const exitCode = await completion;
    if (spawnErrorMessage !== undefined) {
      yield { kind: "meta", text: `docker logs unavailable: ${spawnErrorMessage}` };
    } else if (exitCode !== 0 && !options.signal?.aborted) {
      const detail = stderr.trim().split("\n").at(-1) ?? `exit ${exitCode}`;
      yield { kind: "meta", text: `docker logs failed: ${detail}` };
    } else if (options.follow && !options.signal?.aborted) {
      yield { kind: "meta", text: "docker log stream ended" };
    }
  } finally {
    options.signal?.removeEventListener("abort", abort);
    if (child.exitCode === null) child.kill("SIGTERM");
  }
}
