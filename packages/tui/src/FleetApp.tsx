import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
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
import { fitFleetText, padFleetText, wrapFleetText } from "./fleet-text.ts";
import { fleetTheme, SPINNER_FRAMES } from "./fleet-theme.ts";
import {
  isDoctorKey,
  isDownKey,
  isEnterKey,
  isEscapeKey,
  isFollowBottomKey,
  isPlainKey,
  isScrollTopKey,
  isShiftedKey,
  isUpKey,
} from "./fleet-keys.ts";
import {
  fleetPaneWidths,
  resolveFleetLayout,
  servicePaneHeight,
  stackSidebarHeight,
} from "./fleet-layout.ts";
import { buildFleetLogRows } from "./fleet-log-rows.ts";
import { endpointReach, serviceEndpoints } from "./fleet-endpoints.ts";
import { buildEnvBlock, formatUptime } from "./fleet-format.ts";
import { FLEET_KEY_HINTS, fleetCapacitySummary, resolveStatusNotice } from "./fleet-status.ts";
import { StackSidebar } from "./components/StackSidebar.tsx";
import { ServicePane } from "./components/ServicePane.tsx";
import { LogPane } from "./components/LogPane.tsx";
import { FleetModal } from "./components/FleetModal.tsx";

const LOG_RING_CAPACITY = 2_000;
const TOAST_TTL_MS = 3_500;
const EMPTY_CAPACITY = { maxStacks: 0, live: 0, reserved: 0, queued: 0 };

// Kept ≤12 rows so the whole table fits a 24-line terminal's modal.
const HELP_ROWS: Array<[keys: string, action: string]> = [
  ["j k ↑↓", "move in focused pane · Tab cycles panes"],
  [", . [ ]", "previous / next stack · service"],
  ["/", "filter stacks (Esc clears, then exits)"],
  ["f · g G", "pause/resume follow · top / bottom of logs"],
  ["o", "open selected endpoint in browser"],
  ["y · Y", "yank endpoint URL · stack env block"],
  ["c l p", "yank direct / local / public URL"],
  ["s", "shared hostnames (claim, allow, deny, release)"],
  ["D · d", "doctor report · down stack (removes volumes + images)"],
  ["1 2 0", "split / stacked / auto layout"],
  ["q", "quit · mouse click and wheel work everywhere"],
];

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
  return { repoId, observedAt: new Date(0).toISOString(), capacity: EMPTY_CAPACITY, stacks: [], shared: [], warnings: [] };
}

function selectedStack(snapshot: FleetSnapshot, project?: string): FleetStackView | undefined {
  return snapshot.stacks.find((stack) => stack.project === project);
}

function fleetServiceRowCount(stack: FleetStackView | undefined): number {
  return stack?.services.reduce((count, service) =>
    count + 1 + serviceEndpoints(service).length, 0) ?? 0;
}

function selectedFleetEndpoint(
  stack: FleetStackView | undefined,
  serviceName?: string,
  endpointName?: string,
): FleetStackView["services"][number]["endpoint"] {
  const service = stack?.services.find((candidate) => candidate.name === serviceName);
  const endpoints = service === undefined ? [] : serviceEndpoints(service);
  return endpoints.find((endpoint) => endpoint.name === endpointName) ?? endpoints[0];
}

function usableEndpoint(
  stack: FleetStackView | undefined,
  serviceName?: string,
  endpointName?: string,
): string | undefined {
  const endpoint = selectedFleetEndpoint(stack, serviceName, endpointName);
  return endpoint === undefined ? undefined : endpointReach(endpoint);
}

/** The confirmed incarnation no longer matches the live snapshot row. */
function downTargetChanged(confirmed: FleetStackView, snapshot: FleetSnapshot): boolean {
  const current = snapshot.stacks.find((candidate) => candidate.project === confirmed.project);
  return current?.repoId !== confirmed.repoId ||
    current.worktree !== confirmed.worktree ||
    current.createdAt !== confirmed.createdAt;
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

export interface DoctorReportEntry {
  row: DoctorRow;
  detailLines: string[];
}

/**
 * Fit doctor rows into the modal by RENDERED line count (head + wrapped
 * detail), so the omission summary always stays inside the box.
 */
export function budgetDoctorReport(
  rows: DoctorRow[],
  width: number,
  lineBudget: number,
): { entries: DoctorReportEntry[]; shown: number } {
  const entries: DoctorReportEntry[] = [];
  let used = 0;
  for (const row of rows) {
    const detail = sanitizeFleetTerminalText(row.detail);
    const detailLines = detail === "" ? [] : wrapFleetText(detail, Math.max(8, width - 6), 2);
    const cost = 1 + detailLines.length;
    if (used + cost > lineBudget) break;
    entries.push({ row, detailLines });
    used += cost;
  }
  return { entries, shown: entries.length };
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
  const [connectionNotice, setConnectionNotice] = useState<string | undefined>("connecting to hestiad…");
  const [toast, setToast] = useState<string | undefined>(undefined);
  const [doctorRows, setDoctorRows] = useState<DoctorRow[]>([]);
  const [doctorRunning, setDoctorRunning] = useState(false);
  const [sharedBusy, setSharedBusy] = useState(false);
  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const lastFrameAt = useRef(Date.now());
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stateRef = useRef(state);
  stateRef.current = state;

  // hunk-style transient notice: newer toasts survive older toasts' timers.
  const showToast = (text: string, ttl = TOAST_TTL_MS): void => {
    if (toastTimer.current !== undefined) clearTimeout(toastTimer.current);
    setToast(text);
    toastTimer.current = setTimeout(() => {
      setToast((current) => (current === text ? undefined : current));
    }, ttl);
  };
  useEffect(() => () => {
    if (toastTimer.current !== undefined) clearTimeout(toastTimer.current);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      for await (const frame of source.fleet(controller.signal)) {
        lastFrameAt.current = Date.now();
        if (frame.type === "snapshot") {
          setConnected(true);
          setConnectionNotice(undefined);
          setSnapshot(frame.snapshot);
          dispatch({ type: "reconcile", snapshot: frame.snapshot, preferredProject });
        } else if (frame.sequence === -1) {
          setConnected(false);
          setConnectionNotice(frame.at);
        } else {
          setConnected(true);
          setConnectionNotice(undefined);
        }
      }
    })();
    const staleTimer = setInterval(() => {
      if (Date.now() - lastFrameAt.current > 20_000) {
        setConnected(false);
        setConnectionNotice("hestiad heartbeat is stale; reconnecting…");
      }
    }, 5_000);
    return () => {
      clearInterval(staleTimer);
      controller.abort();
    };
  }, [preferredProject, source]);

  const selectedLogStack = selectedStack(snapshot, state.selection.project);
  const selectionKey = fleetLogSelectionKey(selectedLogStack, state.selection.service);
  const appendedLines = useRef(0);
  const seenAppendedLines = useRef(0);
  useEffect(() => {
    setLogs([]);
    appendedLines.current = 0;
    seenAppendedLines.current = 0;
    if (selectionKey === undefined) return;
    const [project, service] = selectionKey.split("\0") as [string, string];
    const controller = new AbortController();
    void (async () => {
      // React 19 batches these microtask-spaced appends into one render per
      // flush, and row wrapping is cached per line — no per-line re-wrap storm.
      for await (const line of source.logs(project, service, controller.signal)) {
        const sanitized: LogLine = {
          ...line,
          project: sanitizeFleetTerminalText(line.project),
          service: sanitizeFleetTerminalText(line.service),
          text: sanitizeFleetTerminalText(line.text),
        };
        appendedLines.current += 1;
        setLogs((current) => [...current, sanitized].slice(-LOG_RING_CAPACITY));
      }
    })();
    return () => controller.abort();
  }, [selectionKey, source]);

  const stacks = useMemo(
    () => visibleFleetStacks(snapshot, state.filter),
    [snapshot, state.filter],
  );
  const stack = selectedStack(snapshot, state.selection.project);
  const context = useMemo(() => ({
    repo: sanitizeFleetTerminalText(stack?.repo ?? invokingRepository.repo),
    branch: sanitizeFleetTerminalText(stack?.branch ?? invokingRepository.branch),
    worktree: sanitizeFleetTerminalText(stack?.worktree ?? invokingRepository.worktree),
    project: sanitizeFleetTerminalText(stack?.project ?? "—"),
  }), [stack, invokingRepository]);
  const endpointView = selectedFleetEndpoint(stack, state.selection.service, state.selection.endpoint);
  const endpoint = usableEndpoint(stack, state.selection.service, state.selection.endpoint);

  const effectiveLayout = resolveFleetLayout(state.layout, terminal.width);
  const paneWidths = fleetPaneWidths(effectiveLayout, terminal.width);
  const headerRows = 1;
  const contextRows = 2;
  const footerRows = 1;
  const warningRows = stack?.warning === undefined ? 0 : 1;
  const svcRows = fleetServiceRowCount(stack) + warningRows;
  const stackedSidebarHeight = stackSidebarHeight(stacks.length);
  const svcPaneH = servicePaneHeight(svcRows, effectiveLayout === "split" ? 14 : 12);
  const logHeight = Math.max(
    5,
    terminal.height - headerRows - contextRows - footerRows - svcPaneH -
      (effectiveLayout === "stack" ? stackedSidebarHeight : 0),
  );
  const logWidth = effectiveLayout === "split" ? paneWidths.main : terminal.width;
  const logViewportRows = Math.max(1, logHeight - 3);
  const logRows = useMemo(
    () => buildFleetLogRows(logs, Math.max(1, logWidth - 4)),
    [logs, logWidth],
  );
  const maxLogOffset = Math.max(0, logRows.length - logViewportRows);

  // Hold a paused viewport in place as fresh lines land below it. Counting
  // ARRIVALS (not row-count deltas) stays correct when ring eviction keeps
  // the length flat and ignores rewrap-only changes from a resize.
  useEffect(() => {
    const appended = appendedLines.current - seenAppendedLines.current;
    seenAppendedLines.current = appendedLines.current;
    if (appended > 0 && !stateRef.current.follow) {
      const fresh = buildFleetLogRows(
        logs.slice(-Math.min(appended, logs.length)),
        Math.max(1, logWidth - 4),
      ).length;
      dispatch({ type: "new-lines", count: fresh, maxOffset: maxLogOffset });
    }
  }, [logs, logWidth, maxLogOffset]);

  const anyStarting = snapshot.stacks.some((candidate) => candidate.phase === "starting");
  useEffect(() => {
    if (!anyStarting) return;
    const timer = setInterval(
      () => setSpinnerFrame((frame) => (frame + 1) % SPINNER_FRAMES.length),
      120,
    );
    return () => clearInterval(timer);
  }, [anyStarting]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const confirmed = state.confirmDown;
    if (confirmed !== undefined && !state.downPending && downTargetChanged(confirmed, snapshot)) {
      dispatch({ type: "confirm-down" });
      showToast(`${confirmed.project} changed; down cancelled`);
    }
  }, [snapshot, state.confirmDown, state.downPending]);

  const copyToClipboard = (value: string, label?: string): void => {
    const copied = renderer.copyToClipboardOSC52(value);
    showToast(copied ? `copied ${label ?? value}` : `copy unavailable: ${label ?? value}`);
  };

  useKeyboard((key) => {
    const current = stateRef.current;

    if (current.confirmDown !== undefined) {
      key.preventDefault();
      key.stopPropagation();
      if (isEscapeKey(key) && !current.downPending) {
        dispatch({ type: "confirm-down" });
      } else if (
        !current.downPending &&
        (isPlainKey(key, "d") || isEnterKey(key))
      ) {
        const confirmed = current.confirmDown;
        if (downTargetChanged(confirmed, snapshot)) {
          dispatch({ type: "confirm-down" });
          showToast(`${confirmed.project} changed; down cancelled`);
          return;
        }
        // The modal's "Tearing down…" line is the durable busy indicator.
        const project = confirmed.project;
        dispatch({ type: "down-pending", pending: true });
        showToast(`tearing down ${project}…`);
        void source.down(confirmed).then(() => {
          dispatch({ type: "down-pending", pending: false });
          dispatch({ type: "confirm-down" });
          showToast(`${project} is down; volumes and project images removed`);
        }).catch((error) => {
          dispatch({ type: "down-pending", pending: false });
          showToast(`down failed: ${(error as Error).message}`);
        });
      }
      return;
    }

    if (current.helpOpen || current.doctorOpen) {
      key.preventDefault();
      key.stopPropagation();
      if (isEscapeKey(key) || isPlainKey(key, "?")) {
        dispatch({ type: current.helpOpen ? "help" : "doctor", open: false });
      }
      return;
    }

    if (current.sharedOpen) {
      key.preventDefault();
      key.stopPropagation();
      if (isEscapeKey(key) || isPlainKey(key, "s")) return dispatch({ type: "shared", open: false });
      const list = snapshot.shared;
      if (list.length === 0) return;
      if (isDownKey(key)) return dispatch({ type: "move-shared", delta: 1, count: list.length });
      if (isUpKey(key)) return dispatch({ type: "move-shared", delta: -1, count: list.length });
      const selected = list[Math.min(current.sharedSelection, list.length - 1)];
      if (selected === undefined || sharedBusy) return;
      // The modal's "working…" footer is the durable busy indicator.
      const runShared = (label: string, action: Promise<void>): void => {
        setSharedBusy(true);
        showToast(`${label} ${selected.name}…`);
        void action
          .then(() => showToast(`${label} ${selected.name}: done`))
          .catch((error) => showToast(`${label} ${selected.name} failed: ${(error as Error).message}`))
          .finally(() => setSharedBusy(false));
      };
      // allow/deny/release act AS the holder (must be one of this repo's stacks).
      if (isPlainKey(key, "a") || isPlainKey(key, "x") || isPlainKey(key, "r")) {
        if (selected.holder?.mine !== true) {
          showToast(`this worktree does not hold ${selected.name}`);
          return;
        }
        const worktree = selected.holder.worktree;
        if (isPlainKey(key, "a")) runShared("allowing", source.allowShared(worktree, selected.name));
        else if (isPlainKey(key, "x")) runShared("denying", source.denyShared(worktree, selected.name));
        else runShared("releasing", source.releaseShared(worktree, selected.name));
        return;
      }
      // claim acts AS the currently-selected stack in the fleet list.
      if (isPlainKey(key, "c")) {
        const acting = selectedStack(snapshot, current.selection.project);
        if (acting === undefined) {
          showToast("select a stack (in the fleet list) to claim as");
          return;
        }
        if (selected.holder?.project === acting.project) {
          showToast(`${acting.project} already holds ${selected.name}`);
          return;
        }
        runShared(`claiming as ${acting.project},`, source.claimShared(acting.worktree, selected.name));
        return;
      }
      return;
    }

    if (current.focus === "filter") {
      if (isEscapeKey(key)) {
        key.preventDefault();
        key.stopPropagation();
        // First Esc clears the filter; the second leaves the field (hunk's filter UX).
        if (current.filter !== "") dispatch({ type: "filter", filter: "", snapshot });
        else dispatch({ type: "focus", focus: "stacks" });
        return;
      }
      if (isEnterKey(key)) {
        key.preventDefault();
        key.stopPropagation();
        dispatch({ type: "focus", focus: "stacks" });
      }
      return;
    }

    if (isPlainKey(key, "q")) return onQuit();
    if (isPlainKey(key, "?")) return dispatch({ type: "help", open: true });
    if (isPlainKey(key, "s")) return dispatch({ type: "shared", open: true });
    if (isPlainKey(key, "/")) return dispatch({ type: "focus", focus: "filter" });
    if (isPlainKey(key, "0")) return dispatch({ type: "layout", layout: "auto" });
    if (isPlainKey(key, "1")) return dispatch({ type: "layout", layout: "split" });
    if (isPlainKey(key, "2")) return dispatch({ type: "layout", layout: "stack" });
    if (key.name === "tab") {
      const focusOrder: FleetFocus[] = ["stacks", "services", "logs"];
      const index = focusOrder.indexOf(current.focus);
      const delta = key.shift ? -1 : 1;
      const next = (index + delta + focusOrder.length) % focusOrder.length;
      return dispatch({ type: "focus", focus: focusOrder[next]! });
    }
    if (isPlainKey(key, ",")) return dispatch({ type: "move-stack", delta: -1, snapshot });
    if (isPlainKey(key, ".")) return dispatch({ type: "move-stack", delta: 1, snapshot });
    if (isPlainKey(key, "[")) return dispatch({ type: "move-service", delta: -1, snapshot });
    if (isPlainKey(key, "]")) return dispatch({ type: "move-service", delta: 1, snapshot });
    if (isPlainKey(key, "f")) return dispatch({ type: "follow", follow: !current.follow });
    if (isFollowBottomKey(key)) return dispatch({ type: "follow", follow: true });
    if (isScrollTopKey(key)) {
      return dispatch({ type: "scroll-logs", delta: -logRows.length, maxOffset: maxLogOffset });
    }
    if (isDoctorKey(key)) {
      if (doctorRunning) return;
      dispatch({ type: "doctor", open: true });
      setDoctorRunning(true);
      setDoctorRows([]);
      const worktree = stack !== undefined && existsSync(stack.worktree)
        ? stack.worktree
        : process.cwd();
      void source.diagnose(worktree).then(setDoctorRows).catch((error) => {
        showToast(`doctor failed: ${(error as Error).message}`);
      }).finally(() => setDoctorRunning(false));
      return;
    }
    if (isPlainKey(key, "d")) {
      if (stack?.phase === "queued" || stack?.phase === "reserved") {
        showToast(`${stack.project} is ${stack.phase}; down is available after startup begins`);
      } else if (stack !== undefined) {
        dispatch({ type: "confirm-down", stack });
      }
      return;
    }
    if (isPlainKey(key, "o") && endpoint !== undefined) {
      openFleetUrl(endpoint);
      showToast(endpoint);
      return;
    }
    // Shift-Y before plain y: some keyboard protocols report the uppercase
    // sequence with the lowercase name and no shift flag.
    if (isShiftedKey(key, "y")) {
      if (stack === undefined) return;
      const env = buildEnvBlock(stack);
      if (env === "") showToast(`no env surface recorded for ${stack.project}`);
      else copyToClipboard(env, `env block (${env.split("\n").length} keys)`);
      return;
    }
    if (isPlainKey(key, "y") && endpoint !== undefined) {
      copyToClipboard(endpoint);
      return;
    }
    const copySurfaces: Array<[name: string, value: string | undefined]> = [
      ["c", endpointView?.url],
      ["l", endpointView?.localUrl],
      ["p", endpointView?.publicUrl],
    ];
    const copySurface = copySurfaces.find(([name]) => isPlainKey(key, name));
    if (copySurface !== undefined) {
      if (copySurface[1] !== undefined) copyToClipboard(copySurface[1]);
      else showToast("selected URL surface is unavailable");
      return;
    }
    const delta = isDownKey(key) ? 1 : isUpKey(key) ? -1 : 0;
    if (delta === 0) return;
    if (current.focus === "stacks") dispatch({ type: "move-stack", delta, snapshot });
    else if (current.focus === "services") dispatch({ type: "move-service", delta, snapshot });
    else dispatch({ type: "scroll-logs", delta, maxOffset: maxLogOffset });
  });

  const uptime = stack?.createdAt !== undefined &&
      (stack.phase === "up" || stack.phase === "degraded" || stack.phase === "starting")
    ? formatUptime(stack.createdAt, now)
    : undefined;
  const logLabel = state.selection.service ?? "select a service";
  const statusNotice = resolveStatusNotice(connectionNotice, toast);
  const doctorWidth = Math.min(72, Math.max(30, terminal.width - 6));
  const wideFooter = terminal.width >= 100;

  const onSelectProject = useCallback(
    (project: string) => dispatch({ type: "select-stack", project, snapshot }),
    [snapshot],
  );
  const onSelectService = useCallback(
    (service: string) => dispatch({ type: "select-service", service, snapshot }),
    [snapshot],
  );
  const onSelectEndpoint = useCallback(
    (service: string, endpointName: string) =>
      dispatch({ type: "select-endpoint", service, endpoint: endpointName, snapshot }),
    [snapshot],
  );

  const servicePane = (
    <ServicePane
      stack={stack}
      uptime={uptime}
      selectedService={state.selection.service}
      selectedEndpoint={state.selection.endpoint}
      width={logWidth}
      focused={state.focus === "services"}
      onSelectService={onSelectService}
      onSelectEndpoint={onSelectEndpoint}
    />
  );
  const sidebar = (width: number) => (
    <StackSidebar
      stacks={stacks}
      capacity={snapshot.capacity}
      selectedProject={state.selection.project}
      width={width}
      focused={state.focus === "stacks"}
      spinnerFrame={spinnerFrame}
      onSelectProject={onSelectProject}
    />
  );
  const logPane = (
    <LogPane
      rows={logRows}
      height={logHeight}
      width={logWidth}
      offset={state.logOffset}
      follow={state.follow}
      unseen={state.unseenLines}
      label={logLabel}
      focused={state.focus === "logs"}
      onScroll={(delta) => dispatch({ type: "scroll-logs", delta, maxOffset: maxLogOffset })}
    />
  );

  return (
    <box style={{ width: "100%", height: "100%", flexDirection: "column", backgroundColor: fleetTheme.background }}>
      <box style={{ height: 1, paddingLeft: 1, paddingRight: 1, flexDirection: "row", backgroundColor: fleetTheme.panelAlt }}>
        <text fg={fleetTheme.accent}>Hestia Fleet</text>
        <text fg={fleetTheme.faint}> · </text>
        <text fg={fleetTheme.text}>{fitFleetText(context.repo, Math.max(8, terminal.width - 30))}</text>
        <box style={{ flexGrow: 1 }} />
        <text fg={connected ? fleetTheme.healthy : fleetTheme.warning}>
          {connected ? "● connected" : "○ reconnecting"}
        </text>
      </box>

      {/* Contract: repository, branch, worktree, and project stay visible. */}
      <box style={{ height: 2, paddingLeft: 1, flexDirection: "column", backgroundColor: fleetTheme.background }}>
        <box style={{ height: 1, flexDirection: "row" }}>
          <text fg={fleetTheme.muted}>{fitFleetText(context.repo, 24)}</text>
          <text fg={fleetTheme.faint}> / </text>
          <text fg={fleetTheme.text}>{context.branch}</text>
          <text fg={fleetTheme.faint}> · </text>
          <text fg={fleetTheme.muted}>{context.project}</text>
        </box>
        <box style={{ height: 1, flexDirection: "row" }}>
          <text fg={fleetTheme.faint}>worktree </text>
          <text fg={fleetTheme.muted}>
            {middleTruncateWorktreePath(context.worktree, Math.max(16, terminal.width - 11))}
          </text>
        </box>
      </box>

      {effectiveLayout === "split" ? (
        <box style={{ flexGrow: 1, flexDirection: "row" }}>
          {sidebar(paneWidths.sidebar)}
          <box style={{ flexGrow: 1, flexDirection: "column" }}>
            <box style={{ height: svcPaneH }}>{servicePane}</box>
            <box style={{ flexGrow: 1 }}>{logPane}</box>
          </box>
        </box>
      ) : (
        <box style={{ flexGrow: 1, flexDirection: "column" }}>
          <box style={{ height: stackedSidebarHeight }}>{sidebar(terminal.width)}</box>
          <box style={{ height: svcPaneH }}>{servicePane}</box>
          <box style={{ flexGrow: 1 }}>{logPane}</box>
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
        ) : statusNotice !== undefined ? (
          <>
            <text fg={connectionNotice !== undefined ? fleetTheme.warning : fleetTheme.text}>
              {fitFleetText(statusNotice, Math.max(8, terminal.width - 20))}
            </text>
            <box style={{ flexGrow: 1 }} />
            <text fg={connected ? fleetTheme.muted : fleetTheme.warning}>
              {fleetCapacitySummary(snapshot.capacity, connected)}
            </text>
          </>
        ) : (
          <>
            {wideFooter ? (
              <text>
                {FLEET_KEY_HINTS.map((hint) => (
                  <span key={hint.keys}>
                    <span fg={fleetTheme.bright} bg={fleetTheme.keycapBg}>{` ${hint.keys} `}</span>
                    <span fg={fleetTheme.muted}>{` ${hint.label}  `}</span>
                  </span>
                ))}
              </text>
            ) : (
              <text fg={fleetTheme.muted}>? help · q quit</text>
            )}
            <box style={{ flexGrow: 1 }} />
            {state.filter !== "" ? (
              <text fg={fleetTheme.accent}>{`filter=${fitFleetText(state.filter, 16)} `}</text>
            ) : null}
            <text fg={connected ? fleetTheme.muted : fleetTheme.warning}>
              {fleetCapacitySummary(snapshot.capacity, connected)}
            </text>
          </>
        )}
      </box>

      {state.helpOpen ? (
        <FleetModal title="Fleet help" terminalWidth={terminal.width} terminalHeight={terminal.height}>
          {HELP_ROWS.map(([keys, action]) => (
            <box key={keys} style={{ height: 1, flexDirection: "row" }}>
              <text fg={fleetTheme.accent}>{padFleetText(keys, 9)}</text>
              <text fg={fleetTheme.muted}>{action}</text>
            </box>
          ))}
        </FleetModal>
      ) : null}

      {state.doctorOpen ? (
        <FleetModal title="hestia doctor" terminalWidth={terminal.width} terminalHeight={terminal.height}>
          {doctorRunning ? <text fg={fleetTheme.muted}>Running diagnostics…</text> : (() => {
            // Modal chrome: 2 border + 1 padding + 1 title + 1 spacer + 1 summary.
            const modalHeight = Math.min(22, Math.max(8, terminal.height - 4));
            const report = budgetDoctorReport(doctorRows, doctorWidth, Math.max(3, modalHeight - 6));
            const summary = doctorOmissionSummary(doctorRows, report.shown);
            return [
              ...report.entries.flatMap(({ row, detailLines }) => {
                const mark = row.level === "ok" ? "✓" : row.level === "error" ? "✗" : row.level === "warn" ? "!" : "?";
                const color = row.level === "error"
                  ? fleetTheme.danger
                  : row.level === "warn"
                    ? fleetTheme.warning
                    : row.level === "ok"
                      ? fleetTheme.healthy
                      : fleetTheme.muted;
                const head = `${mark} ${sanitizeFleetTerminalText(row.check)}`;
                return [
                  <text key={`${row.check}:head`} fg={color}>{fitFleetText(head, doctorWidth - 4)}</text>,
                  ...detailLines.map((part, index) => (
                    <text key={`${row.check}:detail:${index}`} fg={fleetTheme.muted}>{`  ${part}`}</text>
                  )),
                ];
              }),
              summary === undefined
                ? null
                : <text key="doctor:omitted" fg={fleetTheme.warning}>{summary}</text>,
            ];
          })()}
        </FleetModal>
      ) : null}

      {state.sharedOpen ? (
        <FleetModal title="Shared hostnames" terminalWidth={terminal.width} terminalHeight={terminal.height}>
          {snapshot.shared.length === 0 ? (
            <text fg={fleetTheme.muted}>No shared hostnames declared. `hestia expose &lt;svc&gt; --shared &lt;name&gt;` creates one.</text>
          ) : snapshot.shared.map((entry, index) => {
            const active = index === Math.min(state.sharedSelection, snapshot.shared.length - 1);
            const holder = entry.holder === undefined
              ? "unclaimed"
              : `held by ${entry.holder.project}${entry.holder.mine ? " (yours)" : ""}`;
            return (
              <box key={entry.name} style={{ flexDirection: "column" }}>
                <text fg={active ? fleetTheme.accent : fleetTheme.text}>
                  {`${active ? "▎" : " "} ${sanitizeFleetTerminalText(entry.name)}  ${sanitizeFleetTerminalText(entry.url)}  ${holder}`}
                </text>
                {entry.queue.map((waiter, position) => (
                  <text key={`${entry.name}:${waiter.project}`} fg={fleetTheme.muted}>
                    {`      ${position + 1}. ${sanitizeFleetTerminalText(waiter.project)}${waiter.mine ? " (yours)" : ""}${waiter.denied ? " — denied, still queued" : ""}`}
                  </text>
                ))}
              </box>
            );
          })}
          <box style={{ height: 1 }} />
          <text fg={fleetTheme.muted}>
            {sharedBusy ? "working…" : "j/k select · c claim (as selected stack) · a allow · x deny · r release · Esc/s close"}
          </text>
        </FleetModal>
      ) : null}

      {state.confirmDown !== undefined ? (
        <FleetModal title="Confirm stack down" terminalWidth={terminal.width} terminalHeight={terminal.height}>
          <box style={{ height: 1, flexDirection: "row" }}>
            <text fg={fleetTheme.faint}>{padFleetText("Branch", 12)}</text>
            <text fg={fleetTheme.bright}>{sanitizeFleetTerminalText(state.confirmDown.branch)}</text>
          </box>
          <box style={{ height: 1, flexDirection: "row" }}>
            <text fg={fleetTheme.faint}>{padFleetText("Repository", 12)}</text>
            <text fg={fleetTheme.text}>{sanitizeFleetTerminalText(state.confirmDown.repo)}</text>
          </box>
          <box style={{ height: 1, flexDirection: "row" }}>
            <text fg={fleetTheme.faint}>{padFleetText("Worktree", 12)}</text>
            <text fg={fleetTheme.text}>{sanitizeFleetTerminalText(state.confirmDown.worktree)}</text>
          </box>
          <box style={{ height: 1, flexDirection: "row" }}>
            <text fg={fleetTheme.faint}>{padFleetText("Project", 12)}</text>
            <text fg={fleetTheme.text}>{sanitizeFleetTerminalText(state.confirmDown.project)}</text>
          </box>
          <box style={{ height: 1 }} />
          <text fg={fleetTheme.warning}>Removes named volumes and project-built images (data loss).</text>
          <text fg={fleetTheme.danger}>
            {state.downPending ? "Tearing down…" : "Press Enter or d to confirm; Esc cancels."}
          </text>
        </FleetModal>
      ) : null}
    </box>
  );
}
