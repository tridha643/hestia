import type { FleetSnapshot, FleetStackView } from "@hestia/core";

export type FleetFocus = "stacks" | "services" | "logs" | "filter";
export type FleetLayoutMode = "auto" | "split" | "stack";

export interface FleetSelection {
  project?: string;
  service?: string;
}

export interface FleetUiState {
  selection: FleetSelection;
  focus: FleetFocus;
  layout: FleetLayoutMode;
  filter: string;
  follow: boolean;
  logOffset: number;
  unseenLines: number;
  helpOpen: boolean;
  doctorOpen: boolean;
  confirmDown?: FleetStackView;
  downPending: boolean;
}

export type FleetUiAction =
  | { type: "reconcile"; snapshot: FleetSnapshot; preferredProject?: string }
  | { type: "move-stack"; delta: number; snapshot: FleetSnapshot }
  | { type: "move-service"; delta: number; snapshot: FleetSnapshot }
  | { type: "select-stack"; project: string; snapshot: FleetSnapshot }
  | { type: "select-service"; service: string; snapshot: FleetSnapshot }
  | { type: "focus"; focus: FleetFocus }
  | { type: "layout"; layout: FleetLayoutMode }
  | { type: "filter"; filter: string; snapshot?: FleetSnapshot }
  | { type: "follow"; follow: boolean }
  | { type: "scroll-logs"; delta: number }
  | { type: "new-lines"; count: number; maxOffset?: number }
  | { type: "help"; open: boolean }
  | { type: "doctor"; open: boolean }
  | { type: "confirm-down"; stack?: FleetStackView }
  | { type: "down-pending"; pending: boolean };

/** Create deterministic Fleet UI state before the first daemon snapshot arrives. */
export function createFleetUiState(): FleetUiState {
  return {
    selection: {},
    focus: "stacks",
    layout: "auto",
    filter: "",
    follow: true,
    logOffset: 0,
    unseenLines: 0,
    helpOpen: false,
    doctorOpen: false,
    downPending: false,
  };
}

/** Filter only Hestia-managed snapshot rows; Git worktrees are never discovered here. */
export function visibleFleetStacks(snapshot: FleetSnapshot, filter: string): FleetStackView[] {
  const needle = filter.trim().toLowerCase();
  if (needle === "") return snapshot.stacks;
  return snapshot.stacks.filter((stack) =>
    `${stack.project}\n${stack.branch}\n${stack.services.map((service) => service.name).join("\n")}`
      .toLowerCase()
      .includes(needle),
  );
}

function nearestItem<T>(items: T[], currentIndex: number): T | undefined {
  return items[Math.min(Math.max(currentIndex, 0), Math.max(0, items.length - 1))];
}

/** Preserve stable project/service selection and clamp only when snapshot rows disappear. */
export function reconcileFleetSelection(
  previous: FleetSelection,
  snapshot: FleetSnapshot,
  preferredProject?: string,
): FleetSelection {
  if (snapshot.stacks.length === 0) return {};
  const previousIndex = snapshot.stacks.findIndex((stack) => stack.project === previous.project);
  const stack = snapshot.stacks.find((candidate) => candidate.project === previous.project)
    ?? snapshot.stacks.find((candidate) => candidate.project === preferredProject)
    ?? nearestItem(snapshot.stacks, previousIndex < 0 ? 0 : previousIndex)
    ?? snapshot.stacks[0]!;
  const service = stack.services.find((candidate) => candidate.name === previous.service)
    ?? stack.services[0];
  return { project: stack.project, service: service?.name };
}

function moveSelection<T>(items: T[], currentIndex: number, delta: number): T | undefined {
  if (items.length === 0) return undefined;
  const start = currentIndex < 0 ? 0 : currentIndex;
  const index = Math.min(items.length - 1, Math.max(0, start + delta));
  return items[index];
}

/** Reduce keyboard and stream events without coupling selection logic to React rendering. */
export function reduceFleetUiState(state: FleetUiState, action: FleetUiAction): FleetUiState {
  switch (action.type) {
    case "reconcile":
      const visibleSnapshot = state.filter === ""
        ? action.snapshot
        : { ...action.snapshot, stacks: visibleFleetStacks(action.snapshot, state.filter) };
      return {
        ...state,
        selection: reconcileFleetSelection(state.selection, visibleSnapshot, action.preferredProject),
      };
    case "move-stack": {
      const stacks = visibleFleetStacks(action.snapshot, state.filter);
      const currentIndex = stacks.findIndex((stack) => stack.project === state.selection.project);
      const stack = moveSelection(stacks, currentIndex, action.delta);
      return stack === undefined
        ? state
        : {
            ...state,
            selection: { project: stack.project, service: stack.services[0]?.name },
            follow: true,
            logOffset: 0,
            unseenLines: 0,
          };
    }
    case "move-service": {
      const stack = action.snapshot.stacks.find((candidate) => candidate.project === state.selection.project);
      if (stack === undefined) return state;
      const currentIndex = stack.services.findIndex((service) => service.name === state.selection.service);
      const service = moveSelection(stack.services, currentIndex, action.delta);
      return service === undefined
        ? state
        : {
            ...state,
            selection: { ...state.selection, service: service.name },
            follow: true,
            logOffset: 0,
            unseenLines: 0,
          };
    }
    case "select-stack": {
      const stack = visibleFleetStacks(action.snapshot, state.filter).find(
        (candidate) => candidate.project === action.project,
      );
      return stack === undefined ? state : {
        ...state,
        focus: "stacks",
        selection: { project: stack.project, service: stack.services[0]?.name },
        follow: true,
        logOffset: 0,
        unseenLines: 0,
      };
    }
    case "select-service": {
      const stack = action.snapshot.stacks.find(
        (candidate) => candidate.project === state.selection.project,
      );
      if (!stack?.services.some((service) => service.name === action.service)) return state;
      return {
        ...state,
        focus: "services",
        selection: { ...state.selection, service: action.service },
        follow: true,
        logOffset: 0,
        unseenLines: 0,
      };
    }
    case "focus": return { ...state, focus: action.focus };
    case "layout": return { ...state, layout: action.layout };
    case "filter": {
      if (action.snapshot === undefined) return { ...state, filter: action.filter };
      const visibleSnapshot = {
        ...action.snapshot,
        stacks: visibleFleetStacks(action.snapshot, action.filter),
      };
      return {
        ...state,
        filter: action.filter,
        selection: reconcileFleetSelection(state.selection, visibleSnapshot),
      };
    }
    case "follow": return {
      ...state,
      follow: action.follow,
      logOffset: action.follow ? 0 : state.logOffset,
      unseenLines: action.follow ? 0 : state.unseenLines,
    };
    case "scroll-logs": return {
      ...state,
      follow: action.delta > 0 ? state.follow : false,
      logOffset: Math.max(0, state.logOffset - action.delta),
    };
    case "new-lines": return state.follow
      ? state
      : {
          ...state,
          logOffset: Math.min(action.maxOffset ?? Number.MAX_SAFE_INTEGER, state.logOffset + action.count),
          unseenLines: state.unseenLines + action.count,
        };
    case "help": return { ...state, helpOpen: action.open };
    case "doctor": return { ...state, doctorOpen: action.open };
    case "confirm-down": return {
      ...state,
      confirmDown: action.stack,
    };
    case "down-pending": return { ...state, downPending: action.pending };
  }
}
