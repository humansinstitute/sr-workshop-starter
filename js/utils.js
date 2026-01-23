// State machine and formatting utilities

export const TODO_STATES = ['new', 'ready', 'in_progress', 'done'];
export const TODO_PRIORITIES = ['rock', 'pebble', 'sand'];

export const ALLOWED_STATE_TRANSITIONS = {
  new: ['ready'],
  ready: ['in_progress', 'done'],
  in_progress: ['done'],
  done: ['ready'],
};

export function isAllowedTransition(current, next) {
  return ALLOWED_STATE_TRANSITIONS[current]?.includes(next) ?? false;
}

export function formatStateLabel(state) {
  if (state === 'in_progress') return 'In Progress';
  return state.charAt(0).toUpperCase() + state.slice(1);
}

export function formatPriorityLabel(priority) {
  return priority.charAt(0).toUpperCase() + priority.slice(1);
}

export function formatTransitionLabel(current, next) {
  if (current === 'done' && next === 'ready') return 'Reopen';
  if (current === 'ready' && next === 'in_progress') return 'Start Work';
  if (next === 'done') return 'Complete';
  if (next === 'ready') return 'Mark Ready';
  return formatStateLabel(next);
}

export function normalizePriority(input) {
  const value = (input || '').toLowerCase();
  if (TODO_PRIORITIES.includes(value)) return value;
  return 'sand';
}

export function normalizeState(input) {
  const value = (input || '').toLowerCase();
  if (TODO_STATES.includes(value)) return value;
  return 'new';
}

// Tag utilities
export function parseTags(tagsString) {
  if (!tagsString) return [];
  return tagsString.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
}

export function formatTags(tagsArray) {
  return tagsArray.filter(Boolean).join(',');
}

// Date utilities
export function formatDate(dateString) {
  if (!dateString) return '';
  return dateString;
}

export function isOverdue(scheduledFor) {
  if (!scheduledFor) return false;
  const today = new Date().toISOString().split('T')[0];
  return scheduledFor < today;
}

// Avatar fallback
export function formatAvatarFallback(npub) {
  if (!npub) return '...';
  return npub.replace(/^npub1/, '').slice(0, 2).toUpperCase();
}
