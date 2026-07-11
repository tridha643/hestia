import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { existsSync } from "node:fs";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import type { FleetSnapshot, FleetStackView, LogLine, RepoId } from "@hestia/core";
import type { DoctorRow } from "@hestia/engine";
import { DaemonFleetSource } from "./fleet-source.ts";
import {
  createFleetUiState,
  reduceFleetUiState,
  visibleFleetStacks,
  type FleetFocus,
} from "./fleet-controller.ts";
import { sanitizeFleetTerminalText } from "./terminal-text.ts";
import { fleetTheme } from "./fleet-theme.ts";
import { StackSidebar } from "./components/StackSidebar.tsx";
import { ServicePane } from "./components/ServicePane.tsx";
import { LogPane } from "./components/LogPane.tsx";
import { FleetModal } from "./components/FleetModal.tsx";

const LOG_RING_CAPACITY = 2_000;
const EMPTY_CAPACITY = { maxStacks: 0, live: 0, reserved: 0, queued: 0 };

export interface InvokingRepositoryContext {
  repo: string;
  branch: string;
  worktree: string;
}

/** Preserve path orientation and basename while fitting narrow terminals. */
export function middleTruncateWorktreePath(path: string, width: number): string {
  if (path.length <= width) return path;
  if (width <= 3) return path.slice(0, width);
  const parts = path.split("/");
  const basename = parts.at(-1) || path;
  if (basename.length + 3 >= width) {
    const tail = basename.slice(-Math.max(1, width - 2));
    return `…/${tail}`.slice(0, width);
  }
  const prefixWidth = width - basename.length - 2;
  return `${path.slice(0, prefixWidth)}…/${basename}`;
}

function emptySnapshot(repoId: RepoId): FleetSnapshot {
  return { repoId, observedAt: new Date(0).toISOString(), capacity: EMPTY_CAPACITY, stacks: [], warnings: [] };
}

function isEscape(key: { name: string; sequence?: string }): boolean {
  const name = key.name.toLowerCase();
  return name === "escape" || name === "esc" || key.sequence === "\x1b";
}

function isFleetKey(
  key: {
    name: string;
    sequence?: string;
    ctrl?: boolean;
    meta?: boolean;
    option?: boolean;
    super?: boolean;
    hyper?: boolean;
  },
  value: string,
): boolean {
  return !key.ctrl && !key.meta && !key.option && !key.super && !key.hyper &&
    (key.name === value || key.sequence === value);
}

function selectedStack(snapshot: FleetSnapshot, project?: string): FleetStackView | undefined {
  return snapshot.stacks.find((stack) => stack.project === project);
}

function fleetServiceRowCount(stack: FleetStackView | undefined): number {
  return stack?.services.reduce((count, service) =>
    count + 1 + (service.endpoints?.length ?? (service.endpoint === undefined ? 0 : 1)), 0) ?? 0;
}

function selectedFleetEndpoint(
  stack: FleetStackView | undefined,
  serviceName?: string,
  endpointName?: string,
): FleetStackView["services"][number]["endpoint"] {
  const service = stack?.services.find((candidate) => candidate.name === serviceName);
  const endpoints = service?.endpoints ?? (service?.endpoint === undefined ? [] : [service.endpoint]);
  return endpoints.find((endpoint) => endpoint.name === endpointName) ?? endpoints[0];
}

function usableEndpoint(
  stack: FleetStackView | undefined,
  serviceName?: string,
  endpointName?: string,
): string | undefined {
  const endpoint = selectedFleetEndpoint(stack, serviceName, endpointName);
  if (endpoint === undefined) return undefined;
  return endpoint.localUrl ?? endpoint.publicUrl ?? endpoint.url ?? `${endpoint.host}:${endpoint.port}`;
}

function copyableEndpoint(
  stack: FleetStackView | undefined,
  serviceName?: string,
  endpointName?: string,
): FleetStackView["services"][number]["endpoint"] {
  return selectedFleetEndpoint(stack, serviceName, endpointName);
}

/** Reset the visible log ring whenever a stack or service incarnation changes. */
export function fleetLogSelectionKey(
  stack: FleetStackView | undefined,
  serviceName: string | undefined,
): string | undefined {
  if (stack === undefined || serviceName === undefined) return undefined;
  const service = stack.services.find((candidate) => candidate.name === serviceName);
  if (service === undefined) return undefined;
  return `${stack.project}\0${service.name}\0${stack.createdAt ?? ""}\0${service.publishedPort ?? ""}`;
}

function openFleetUrl(value: string): void {
  if (!/^https?:\/\//.test(value) || process.env.HESTIA_NO_OPEN) return;
  const command = process.platform === "darwin" ? ["open", value] : ["xdg-open", value];
  try {
    Bun.spawn(command, { stdout: "ignore", stderr: "ignore" }).unref();
  } catch {
    // The status notice still exposes the URL when no desktop opener exists.
  }
}

/** Summarize diagnostic rows that do not fit in the fixed-height report. */
export function doctorOmissionSummary(rows: DoctorRow[], visibleRows = 10): string | undefined {
  const omitted = rows.slice(visibleRows);
  if (omitted.length === 0) return undefined;
  const errors = omitted.filter((row) => row.level === "error").length;
  const warnings = omitted.filter((row) => row.level === "warn").length;
  return `… ${omitted.length} more (${errors} errors, ${warnings} warnings)`;
}

/** Compose the live Fleet panes while keeping transport and selection state in separate seams. */
export function FleetApp({
  source,
  preferredProject,
  invokingRepository,
  onQuit,
}: {
  source: DaemonFleetSource;
  preferredProject: string;
  invokingRepository: InvokingRepositoryContext;
  onQuit: () => void;
}) {
  const terminal = useTerminalDimensions();
  const renderer = useRenderer();
  const [snapshot, setSnapshot] = useState(() => emptySnapshot(source.repoId));
  const [state, dispatch] = useReducer(reduceFleetUiState, undefined, createFleetUiState);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [connected, setConnected] = useState(false);
  const [notice, setNotice] = useState("connecting to hestiad…");
  const [doctorRows, setDoctorRows] = useState<DoctorRow[]>([]);
  const [doctorRunning, setDoctorRunning] = useState(false);
  const lastFrameAt = useRef(Date.now());
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      for await (const frame of source.fleet(controller.signal)) {
        lastFrameAt.current = Date.now();
        if (frame.type === "snapshot") {
          setConnected(true);
          setNotice((current) =>
            current === "connecting to hestiad…" ||
            current.startsWith("disconnected:") ||
            current.startsWith("hestiad heartbeat")
              ? ""
              : current,
          );
          setSnapshot(frame.snapshot);
          dispatch({ type: "reconcile", snapshot: frame.snapshot, preferredProject });
        } else if (frame.sequence === -1) {
          setConnected(false);
          setNotice(frame.at);
        } else {
          setConnected(true);
        }
      }
    })();
    const staleTimer = setInterval(() => {
      if (Date.now() - lastFrameAt.current > 20_000) {
        setConnected(false);
        setNotice("hestiad heartbeat is stale; reconnecting…");
      }
    }, 1_000);
    return () => {
      clearInterval(staleTimer);
      controller.abort();
    };
  }, [preferredProject, source]);

  const selectedLogStack = selectedStack(snapshot, state.selection.project);
  const selectionKey = fleetLogSelectionKey(selectedLogStack, state.selection.service);
  useEffect(() => {
    setLogs([]);
    if (selectionKey === undefined) return;
    const [project, service] = selectionKey.split("\0") as [string, string];
    const controller = new AbortController();
    void (async () => {
      for await (const line of source.logs(project, service, controller.signal)) {
        const sanitized: LogLine = {
          ...line,
          project: sanitizeFleetTerminalText(line.project),
          service: sanitizeFleetTerminalText(line.service),
          text: sanitizeFleetTerminalText(line.text),
        };
        setLogs((current) => [...current, sanitized].slice(-LOG_RING_CAPACITY));
        dispatch({ type: "new-lines", count: 1, maxOffset: LOG_RING_CAPACITY - 1 });
      }
    })();
    return () => controller.abort();
  }, [selectionKey, source]);

  const stacks = useMemo(
    () => visibleFleetStacks(snapshot, state.filter),
    [snapshot, state.filter],
  );
  const stack = selectedStack(snapshot, state.selection.project);
  const context = {
    repo: sanitizeFleetTerminalText(stack?.repo ?? invokingRepository.repo),
    branch: sanitizeFleetTerminalText(stack?.branch ?? invokingRepository.branch),
    worktree: sanitizeFleetTerminalText(stack?.worktree ?? invokingRepository.worktree),
    project: sanitizeFleetTerminalText(stack?.project ?? "—"),
  };
  const endpointView = copyableEndpoint(stack, state.selection.service, state.selection.endpoint);
  const endpoint = usableEndpoint(stack, state.selection.service, state.selection.endpoint);
  const effectiveLayout = state.layout === "auto"
    ? terminal.width >= 110 ? "split" : "stack"
    : state.layout;
  const focusOrder: FleetFocus[] = ["stacks", "services", "logs"];

  useEffect(() => {
    const confirmed = state.confirmDown;
    const currentIncarnation = snapshot.stacks.find(
      (candidate) => candidate.project === confirmed?.project,
    );
    if (
      confirmed !== undefined &&
      !state.downPending &&
      (
        currentIncarnation?.repoId !== confirmed.repoId ||
        currentIncarnation.worktree !== confirmed.worktree ||
        currentIncarnation.createdAt !== confirmed.createdAt
      )
    ) {
      dispatch({ type: "confirm-down" });
      setNotice(`${confirmed.project} changed; down cancelled`);
    }
  }, [snapshot, state.confirmDown, state.downPending]);

  useKeyboard((key) => {
    const current = stateRef.current;
    if (current.confirmDown !== undefined) {
      key.preventDefault();
      key.stopPropagation();
      if (isEscape(key) && !current.downPending) {
        dispatch({ type: "confirm-down" });
      } else if (
        !current.downPending &&
        (isFleetKey(key, "d") || key.name === "return" || key.name === "enter")
      ) {
        const confirmed = current.confirmDown;
        const currentIncarnation = snapshot.stacks.find(
          (candidate) => candidate.project === confirmed.project,
        );
        if (
          currentIncarnation?.repoId !== confirmed.repoId ||
          currentIncarnation.worktree !== confirmed.worktree ||
          currentIncarnation.createdAt !== confirmed.createdAt
        ) {
          dispatch({ type: "confirm-down" });
          setNotice(`${confirmed.project} changed; down cancelled`);
          return;
        }
        const project = confirmed.project;
        dispatch({ type: "down-pending", pending: true });
        setNotice(`tearing down ${project}…`);
        void source.down(confirmed).then(() => {
          dispatch({ type: "down-pending", pending: false });
          dispatch({ type: "confirm-down" });
          setNotice(`${project} is down; named volumes retained`);
        }).catch((error) => {
          dispatch({ type: "down-pending", pending: false });
          setNotice(`down failed: ${(error as Error).message}`);
        });
      }
      return;
    }
    if (current.helpOpen || current.doctorOpen) {
      key.preventDefault();
      key.stopPropagation();
      if (isEscape(key) || isFleetKey(key, "?")) {
        dispatch({ type: current.helpOpen ? "help" : "doctor", open: false });
      }
      return;
    }
    if (current.focus === "filter") {
      if (isEscape(key) || key.name === "return" || key.name === "enter") {
        key.preventDefault();
        key.stopPropagation();
        dispatch({ type: "focus", focus: "stacks" });
      }
      return;
    }

    if (isFleetKey(key, "q")) return onQuit();
    if (isFleetKey(key, "?")) return dispatch({ type: "help", open: true });
    if (isFleetKey(key, "/")) return dispatch({ type: "focus", focus: "filter" });
    if (isFleetKey(key, "0")) return dispatch({ type: "layout", layout: "auto" });
    if (isFleetKey(key, "1")) return dispatch({ type: "layout", layout: "split" });
    if (isFleetKey(key, "2")) return dispatch({ type: "layout", layout: "stack" });
    if (key.name === "tab") {
      const index = focusOrder.indexOf(current.focus);
      const delta = key.shift ? -1 : 1;
      const next = (index + delta + focusOrder.length) % focusOrder.length;
      return dispatch({ type: "focus", focus: focusOrder[next]! });
    }
    if (isFleetKey(key, "[")) return dispatch({ type: "move-service", delta: -1, snapshot });
    if (isFleetKey(key, "]")) return dispatch({ type: "move-service", delta: 1, snapshot });
    if ((isFleetKey(key, "g") && key.shift) || key.sequence === "G") {
      return dispatch({ type: "follow", follow: true });
    }
    if (key.sequence === "D" || (isFleetKey(key, "d") && key.shift)) {
      if (doctorRunning) return;
      dispatch({ type: "doctor", open: true });
      setDoctorRunning(true);
      setDoctorRows([]);
      const worktree = stack !== undefined && existsSync(stack.worktree)
        ? stack.worktree
        : process.cwd();
      void source.diagnose(worktree).then(setDoctorRows).catch((error) => {
        setNotice(`doctor failed: ${(error as Error).message}`);
      }).finally(() => setDoctorRunning(false));
      return;
    }
    if (isFleetKey(key, "d")) {
      if (stack?.phase === "queued" || stack?.phase === "reserved") {
        setNotice(`${stack.project} is ${stack.phase}; down is available after startup begins`);
      } else if (stack !== undefined) {
        dispatch({ type: "confirm-down", stack });
      }
      return;
    }
    if (isFleetKey(key, "o") && endpoint !== undefined) {
      openFleetUrl(endpoint);
      setNotice(endpoint);
      return;
    }
    if (isFleetKey(key, "y") && endpoint !== undefined) {
      const copied = renderer.copyToClipboardOSC52(endpoint);
      setNotice(copied ? `copied ${endpoint}` : `copy unavailable: ${endpoint}`);
      return;
    }
    const copySurfaceRequested = ["c", "l", "p"].some((name) => isFleetKey(key, name));
    const surface = isFleetKey(key, "c")
      ? endpointView?.url
      : isFleetKey(key, "l")
        ? endpointView?.localUrl
        : isFleetKey(key, "p")
          ? endpointView?.publicUrl
          : undefined;
    if (surface !== undefined) {
      const copied = renderer.copyToClipboardOSC52(surface);
      setNotice(copied ? `copied ${surface}` : `copy unavailable: ${surface}`);
      return;
    }
    if (copySurfaceRequested) {
      setNotice("selected URL surface is unavailable");
      return;
    }
    const delta = key.name === "down" || isFleetKey(key, "j")
      ? 1
      : key.name === "up" || isFleetKey(key, "k")
        ? -1
        : 0;
    if (delta === 0) return;
    if (current.focus === "stacks") dispatch({ type: "move-stack", delta, snapshot });
    else if (current.focus === "services") dispatch({ type: "move-service", delta, snapshot });
    else dispatch({ type: "scroll-logs", delta });
  });

  const capacity = snapshot.capacity;
  const status = connected
    ? `${capacity.live}/${capacity.maxStacks} live · ${capacity.reserved} reserved · ${capacity.queued} queued`
    : "disconnected";
  const logLabel = state.selection.service ?? "select a service";

  return (
    <box style={{ width: "100%", height: "100%", flexDirection: "column", backgroundColor: fleetTheme.background }}>
      <box style={{ height: 1, paddingLeft: 1, paddingRight: 1, flexDirection: "row", backgroundColor: fleetTheme.panelAlt }}>
        <text fg={fleetTheme.accent}>Hestia Fleet — {context.repo}</text>
        <text fg={fleetTheme.muted}>  {status}</text>
      </box>

      {terminal.width >= 90 ? (
        <box style={{ height: 4, paddingLeft: 1, flexDirection: "column", backgroundColor: fleetTheme.background }}>
          <text fg={fleetTheme.text}>Repository  {context.repo}</text>
          <text fg={fleetTheme.text}>Branch      {context.branch}</text>
          <text fg={fleetTheme.text}>Worktree    {middleTruncateWorktreePath(context.worktree, Math.max(16, terminal.width - 13))}</text>
          <text fg={fleetTheme.muted}>Project     {context.project}</text>
        </box>
      ) : (
        <box style={{ height: 2, paddingLeft: 1, flexDirection: "column", backgroundColor: fleetTheme.background }}>
          <text fg={fleetTheme.text}>{context.repo} · {context.branch} · {context.project}</text>
          <text fg={fleetTheme.muted}>worktree {middleTruncateWorktreePath(context.worktree, Math.max(12, terminal.width - 10))}</text>
        </box>
      )}

      {effectiveLayout === "split" ? (
        <box style={{ flexGrow: 1, flexDirection: "row" }}>
          <StackSidebar
            stacks={stacks}
            selectedProject={state.selection.project}
            width={Math.max(28, Math.floor(terminal.width * 0.28))}
            onSelectProject={(project) => dispatch({ type: "select-stack", project, snapshot })}
          />
          <box style={{ flexGrow: 1, flexDirection: "column" }}>
            <box style={{ height: Math.min(12, Math.max(5, fleetServiceRowCount(stack) + 2)) }}>
              <ServicePane
                stack={stack}
                selectedService={state.selection.service}
                selectedEndpoint={state.selection.endpoint}
                onSelectService={(service) => dispatch({ type: "select-service", service, snapshot })}
                onSelectEndpoint={(service, endpoint) => dispatch({ type: "select-endpoint", service, endpoint, snapshot })}
              />
            </box>
            <box style={{ flexGrow: 1 }}>
              <LogPane lines={logs} height={Math.max(5, terminal.height - 13)} width={Math.max(20, Math.floor(terminal.width * 0.72))} offset={state.logOffset} follow={state.follow} unseen={state.unseenLines} label={logLabel} onScroll={(delta) => dispatch({ type: "scroll-logs", delta })} />
            </box>
          </box>
        </box>
      ) : (
        <box style={{ flexGrow: 1, flexDirection: "column" }}>
          <box style={{ height: Math.min(7, Math.max(4, stacks.length + 2)) }}>
            <StackSidebar
              stacks={stacks}
              selectedProject={state.selection.project}
              width={terminal.width}
              onSelectProject={(project) => dispatch({ type: "select-stack", project, snapshot })}
            />
          </box>
          <box style={{ height: Math.min(10, Math.max(4, fleetServiceRowCount(stack) + 2)) }}>
            <ServicePane
              stack={stack}
              selectedService={state.selection.service}
              selectedEndpoint={state.selection.endpoint}
              onSelectService={(service) => dispatch({ type: "select-service", service, snapshot })}
              onSelectEndpoint={(service, endpoint) => dispatch({ type: "select-endpoint", service, endpoint, snapshot })}
            />
          </box>
          <box style={{ flexGrow: 1 }}>
            <LogPane lines={logs} height={Math.max(5, terminal.height - 17)} width={terminal.width} offset={state.logOffset} follow={state.follow} unseen={state.unseenLines} label={logLabel} onScroll={(delta) => dispatch({ type: "scroll-logs", delta })} />
          </box>
        </box>
      )}

      <box style={{ height: 1, paddingLeft: 1, paddingRight: 1, flexDirection: "row", backgroundColor: fleetTheme.panelAlt }}>
        {state.focus === "filter" ? (
          <>
            <text fg={fleetTheme.accent}>filter: </text>
            <input
              width={Math.max(12, terminal.width - 10)}
              value={state.filter}
              focused={true}
              placeholder="branch, project, or service"
              onInput={(value) => dispatch({ type: "filter", filter: value, snapshot })}
              onSubmit={() => dispatch({ type: "focus", focus: "stacks" })}
            />
          </>
        ) : (
          <text fg={notice ? fleetTheme.warning : fleetTheme.muted}>
            {notice || "click rows · wheel logs · j/k navigate · [/] service · / filter · d down · ? help · q quit"}
          </text>
        )}
      </box>

      {state.helpOpen ? (
        <FleetModal title="Fleet help" terminalWidth={terminal.width} terminalHeight={terminal.height}>
          <text fg={fleetTheme.text}>j/k or arrows  navigate focused pane</text>
          <text fg={fleetTheme.text}>mouse  click stacks/services · wheel scroll logs</text>
          <text fg={fleetTheme.text}>Tab / Shift-Tab  change pane</text>
          <text fg={fleetTheme.text}>[ / ]  previous / next service</text>
          <text fg={fleetTheme.text}>/ filter · G follow logs · 0/1/2 layout</text>
          <text fg={fleetTheme.text}>o open · y primary · c direct · l local · p public</text>
          <text fg={fleetTheme.text}>D doctor</text>
          <text fg={fleetTheme.danger}>d confirmed down (named volumes retained)</text>
          <text fg={fleetTheme.muted}>Esc closes this dialog</text>
        </FleetModal>
      ) : null}

      {state.doctorOpen ? (
        <FleetModal title="hestia doctor" terminalWidth={terminal.width} terminalHeight={terminal.height}>
          {doctorRunning ? <text fg={fleetTheme.muted}>Running diagnostics…</text> : doctorRows.slice(0, 10).map((row) => (
            <text key={row.check} fg={row.level === "error" ? fleetTheme.danger : row.level === "warn" ? fleetTheme.warning : fleetTheme.text}>
              {`${row.level === "ok" ? "✓" : row.level === "error" ? "✗" : "!"} ${sanitizeFleetTerminalText(row.check)} — ${sanitizeFleetTerminalText(row.detail)}`}
            </text>
          ))}
          {!doctorRunning && doctorOmissionSummary(doctorRows) !== undefined ? (
            <text fg={fleetTheme.warning}>{doctorOmissionSummary(doctorRows)}</text>
          ) : null}
          <text fg={fleetTheme.muted}>Esc closes this report</text>
        </FleetModal>
      ) : null}

      {state.confirmDown !== undefined ? (
        <FleetModal title="Confirm stack down" terminalWidth={terminal.width} terminalHeight={terminal.height}>
          <text fg={fleetTheme.text}>Branch: {sanitizeFleetTerminalText(state.confirmDown.branch)}</text>
          <text fg={fleetTheme.text}>Repository: {sanitizeFleetTerminalText(state.confirmDown.repo)}</text>
          <text fg={fleetTheme.text}>Worktree: {sanitizeFleetTerminalText(state.confirmDown.worktree)}</text>
          <text fg={fleetTheme.text}>Project: {sanitizeFleetTerminalText(state.confirmDown.project)}</text>
          <box style={{ height: 1 }} />
          <text fg={fleetTheme.warning}>Named volumes are retained.</text>
          <text fg={fleetTheme.danger}>
            {state.downPending ? "Tearing down…" : "Press Enter or d to confirm; Esc cancels."}
          </text>
        </FleetModal>
      ) : null}
    </box>
  );
}
