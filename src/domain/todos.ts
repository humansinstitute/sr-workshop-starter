import type { TodoPriority, TodoState } from "../types";

export const TODO_STATES: TodoState[] = ["new", "ready", "in_progress", "done"];
export const TODO_PRIORITIES: TodoPriority[] = ["rock", "pebble", "sand"];

export const ALLOWED_STATE_TRANSITIONS: Record<TodoState, TodoState[]> = {
  new: ["ready"],
  ready: ["in_progress", "done"],
  in_progress: ["done"],
  done: ["ready"],
};

export function normalizePriority(input: string): TodoPriority {
  const value = input.toLowerCase();
  if (TODO_PRIORITIES.includes(value as TodoPriority)) {
    return value as TodoPriority;
  }
  return "sand";
}

export function normalizeState(input: string): TodoState {
  const value = input.toLowerCase();
  if (TODO_STATES.includes(value as TodoState)) {
    return value as TodoState;
  }
  return "ready";
}

export function isAllowedTransition(current: TodoState, next: TodoState) {
  return ALLOWED_STATE_TRANSITIONS[current]?.includes(next) ?? false;
}

export function formatStateLabel(state: TodoState) {
  if (state === "in_progress") return "In Progress";
  return state.charAt(0).toUpperCase() + state.slice(1);
}

export function formatPriorityLabel(priority: TodoPriority) {
  return priority.charAt(0).toUpperCase() + priority.slice(1);
}
