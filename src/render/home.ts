import { APP_NAME } from "../config";
import { ALLOWED_STATE_TRANSITIONS, formatPriorityLabel, formatStateLabel } from "../domain/todos";

import type { Todo } from "../db";
import type { Session, TodoPriority, TodoState } from "../types";

type RenderArgs = {
  showArchive: boolean;
  session: Session | null;
  filterTags?: string[];
  todos?: Todo[];
};

export function renderHomePage({ showArchive, session, filterTags = [], todos = [] }: RenderArgs) {
  const filteredTodos = filterTodos(todos, filterTags);
  const activeTodos = filteredTodos.filter((t) => t.state !== "done");
  const doneTodos = filteredTodos.filter((t) => t.state === "done");
  const remaining = session ? activeTodos.length : 0;
  const archiveHref = showArchive ? "/" : "/?archive=1";
  const archiveLabel = showArchive ? "Hide archive" : `Archive (${doneTodos.length})`;
  const tagFilterBar = session ? renderTagFilterBar(todos, filterTags, showArchive) : "";
  const emptyActiveMessage = session ? "No active work. Add something new!" : "Sign in to view your todos.";
  const emptyArchiveMessage = session ? "Nothing archived yet." : "Sign in to view your archive.";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${APP_NAME}</title>
  <meta name="theme-color" content="#111111" />
  <meta name="application-name" content="${APP_NAME}" />
  <link rel="icon" type="image/png" href="/favicon.png" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <link rel="manifest" href="/manifest.webmanifest" />
  <link rel="stylesheet" href="/app.css" />
</head>
<body>
  <main class="app-shell">
    <header class="page-header">
      <h1>${APP_NAME}</h1>
      <div class="session-controls" data-session-controls ${session ? "" : "hidden"}>
        <button
          class="avatar-chip"
          type="button"
          data-avatar
          ${session ? "" : "hidden"}
          title="Account menu"
        >
          <span class="avatar-fallback" data-avatar-fallback>
            ${session ? formatAvatarFallback(session.npub) : "•••"}
          </span>
          <img data-avatar-img alt="Profile photo" loading="lazy" ${session ? "" : "hidden"} />
        </button>
        <div class="avatar-menu" data-avatar-menu hidden>
          <button type="button" data-export-secret ${session?.method === "ephemeral" ? "" : "hidden"}>Export Secret</button>
          <button type="button" data-show-login-qr ${session?.method === "ephemeral" ? "" : "hidden"}>Show Login QR</button>
          <button type="button" data-copy-id ${session ? "" : "hidden"}>Copy ID</button>
          <button type="button" data-logout>Log out</button>
        </div>
      </div>
    </header>
    <section class="auth-panel" data-login-panel ${session ? "hidden" : ""}>
      <h2>Sign in with Nostr to get started</h2>
      <p class="auth-description">Start with a quick Ephemeral ID or bring your own signer.</p>
      <div class="auth-actions">
        <button class="auth-option" type="button" data-login-method="ephemeral">Sign Up</button>
      </div>
      <details class="auth-advanced">
        <summary>Advanced options</summary>
        <p>Use a browser extension or connect to a remote bunker.</p>
        <button class="auth-option" type="button" data-login-method="extension">Browser extension</button>
        <form data-bunker-form>
          <input name="bunker" placeholder="nostrconnect://… or name@example.com" autocomplete="off" />
          <button class="bunker-submit" type="submit">Connect bunker</button>
        </form>
        <form data-secret-form>
          <input name="secret" placeholder="nsec1…" autocomplete="off" />
          <button class="bunker-submit" type="submit">Sign in with secret</button>
        </form>
      </details>
      <p class="auth-error" data-login-error hidden></p>
    </section>
    <section class="hero-entry">
      <form class="todo-form" method="post" action="/todos">
        <label for="title" class="sr-only">Add a task</label>
        <div class="hero-input-wrapper">
          <input class="hero-input" data-hero-input id="title" name="title" placeholder="${session ? "Add something else…" : "Add a task"}" autocomplete="off" autofocus required ${session ? "" : "disabled"} />
        </div>
        <p class="hero-hint" data-hero-hint hidden>Sign in above to add tasks.</p>
      </form>
    </section>
    <div class="work-header">
      <h2>Work</h2>
      <a class="archive-toggle" href="${archiveHref}">${archiveLabel}</a>
    </div>
    <p class="remaining-summary" ${session ? "" : "hidden"}>${
      session ? (remaining === 0 ? "All clear." : `${remaining} left to go.`) : ""
    }</p>
    ${tagFilterBar}
    ${renderTodoList(activeTodos, emptyActiveMessage)}
    ${showArchive ? renderArchiveSection(doneTodos, emptyArchiveMessage) : ""}
    <section class="summary-panel" data-summary-panel hidden>
      <div class="section-heading">
        <h2>Summaries</h2>
        <span class="summary-meta" data-summary-updated></span>
      </div>
      <div class="summary-grid">
        <article class="summary-card" data-summary-day hidden>
          <h3>Today</h3>
          <p class="summary-text" data-summary-day-text></p>
        </article>
        <article class="summary-card" data-summary-week hidden>
          <h3>This Week</h3>
          <p class="summary-text" data-summary-week-text></p>
        </article>
        <article class="summary-card summary-suggestions" data-summary-suggestions hidden>
          <h3>Suggestions</h3>
          <p class="summary-text" data-summary-suggestions-text></p>
        </article>
      </div>
    </section>
    <div class="qr-modal-overlay" data-qr-modal hidden>
      <div class="qr-modal">
        <button class="qr-modal-close" type="button" data-qr-close aria-label="Close">&times;</button>
        <h2>Login QR Code</h2>
        <p>Scan this code with your mobile device to log in</p>
        <div class="qr-canvas-container" data-qr-container></div>
      </div>
    </div>
  </main>
  <script>
    window.__NOSTR_SESSION__ = ${JSON.stringify(session ?? null)};
  </script>
  <script type="module" src="/app.js"></script>

</body>
</html>`;
}

function filterTodos(allTodos: Todo[], filterTags: string[]) {
  if (filterTags.length === 0) return allTodos;
  return allTodos.filter((todo) => {
    const todoTags = todo.tags ? todo.tags.split(",").map((t) => t.trim().toLowerCase()) : [];
    return filterTags.some((ft) => todoTags.includes(ft.toLowerCase()));
  });
}

function renderTagFilterBar(allTodos: Todo[], activeTags: string[], showArchive: boolean) {
  const baseUrl = showArchive ? "/?archive=1" : "/";
  const tags = collectTags(allTodos);
  if (tags.length === 0) return "";

  const chips = tags
    .sort()
    .map((tag) => {
      const isActive = activeTags.some((t) => t.toLowerCase() === tag.toLowerCase());
      const nextTags = toggleTag(activeTags, tag, isActive);
      const href = nextTags.length > 0 ? `${baseUrl}${showArchive ? "&" : "?"}tags=${nextTags.join(",")}` : baseUrl;
      return `<a href="${href}" class="tag-chip${isActive ? " active" : ""}">${escapeHtml(tag)}</a>`;
    })
    .join("");

  const clearLink = activeTags.length > 0 ? `<a href="${baseUrl}" class="clear-filters">Clear filters</a>` : "";
  return `<div class="tag-filter-bar"><span class="label">Filter by tag:</span>${chips}${clearLink}</div>`;
}

function toggleTag(activeTags: string[], tag: string, isActive: boolean) {
  if (isActive) return activeTags.filter((t) => t.toLowerCase() !== tag.toLowerCase());
  return [...activeTags, tag];
}

function collectTags(todos: Todo[]) {
  const allTags = new Set<string>();
  for (const todo of todos) {
    if (!todo.tags) continue;
    todo.tags
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean)
      .forEach((t) => allTags.add(t));
  }
  return Array.from(allTags);
}

function renderTodoList(todos: Todo[], emptyMessage: string) {
  if (todos.length === 0) {
    return `<ul class="todo-list"><li>${emptyMessage}</li></ul>`;
  }
  return `<ul class="todo-list">${todos.map(renderTodoItem).join("")}</ul>`;
}

function renderArchiveSection(todos: Todo[], emptyMessage: string) {
  return `
    <section class="archive-section">
      <div class="section-heading"><h2>Archive</h2></div>
      ${renderTodoList(todos, emptyMessage)}
    </section>`;
}

function formatAvatarFallback(npub: string) {
  if (!npub) return "•••";
  return npub.replace(/^npub1/, "").slice(0, 2).toUpperCase();
}

function renderTodoItem(todo: Todo) {
  const description = todo.description ? `<p class="todo-description">${escapeHtml(todo.description)}</p>` : "";
  const scheduled = todo.scheduled_for
    ? `<p class="todo-description"><strong>Scheduled for:</strong> ${escapeHtml(todo.scheduled_for)}</p>`
    : "";
  const tagsDisplay = renderTagsDisplay(todo.tags);
  return `
    <li>
      <details>
        <summary>
          <span class="todo-title">${escapeHtml(todo.title)}</span>
          <span class="badges">
            <span class="badge priority-${todo.priority}">${formatPriorityLabel(todo.priority)}</span>
            <span class="badge state-${todo.state}">${formatStateLabel(todo.state)}</span>
            ${tagsDisplay}
          </span>
        </summary>
        <div class="todo-body">
          ${description}
          ${scheduled}
          <form class="edit-form" method="post" action="/todos/${todo.id}/update">
            <label>Title
              <input name="title" value="${escapeHtml(todo.title)}" required />
            </label>
            <label>Description
              <textarea name="description" rows="3">${escapeHtml(todo.description ?? "")}</textarea>
            </label>
            <label>Priority
              <select name="priority">
                ${renderPriorityOption("rock", todo.priority)}
                ${renderPriorityOption("pebble", todo.priority)}
                ${renderPriorityOption("sand", todo.priority)}
              </select>
            </label>
            <label>State
              <select name="state">
                ${renderStateOption("new", todo.state)}
                ${renderStateOption("ready", todo.state)}
                ${renderStateOption("in_progress", todo.state)}
                ${renderStateOption("done", todo.state)}
              </select>
            </label>
            <label>Scheduled For
              <input type="date" name="scheduled_for" value="${todo.scheduled_for ? escapeHtml(todo.scheduled_for) : ""}" />
            </label>
            ${renderTagsInput(todo.tags)}
            <button type="submit">Update</button>
          </form>
          ${renderLifecycleActions(todo)}
        </div>
      </details>
    </li>`;
}

function renderLifecycleActions(todo: Todo) {
  const transitions = ALLOWED_STATE_TRANSITIONS[todo.state] ?? [];
  const transitionForms = transitions.map((next) =>
    renderStateActionForm(todo.id, next, formatTransitionLabel(todo.state, next))
  );

  return `
    <div class="todo-actions">
      ${transitionForms.join("")}
      ${renderDeleteForm(todo.id)}
    </div>`;
}

function formatTransitionLabel(current: TodoState, next: TodoState) {
  if (current === "done" && next === "ready") return "Reopen";
  if (current === "ready" && next === "in_progress") return "Start Work";
  if (next === "done") return "Complete";
  if (next === "ready") return "Mark Ready";
  return formatStateLabel(next);
}

function renderStateActionForm(id: number, nextState: TodoState, label: string) {
  return `
    <form method="post" action="/todos/${id}/state">
      <input type="hidden" name="state" value="${nextState}" />
      <button type="submit">${label}</button>
    </form>`;
}

function renderDeleteForm(id: number) {
  return `
    <form method="post" action="/todos/${id}/delete">
      <button type="submit">Delete</button>
    </form>`;
}

function renderPriorityOption(value: TodoPriority, current: string) {
  const isSelected = value === current ? "selected" : "";
  return `<option value="${value}" ${isSelected}>${formatPriorityLabel(value)}</option>`;
}

function renderStateOption(value: TodoState, current: string) {
  const isSelected = value === current ? "selected" : "";
  return `<option value="${value}" ${isSelected}>${formatStateLabel(value)}</option>`;
}

function renderTagsDisplay(tags: string) {
  if (!tags) return "";
  const tagList = tags.split(",").map((t) => t.trim()).filter(Boolean);
  if (tagList.length === 0) return "";
  return `<span class="tags-display">${tagList.map((t) => `<span class="tag-chip">${escapeHtml(t)}</span>`).join("")}</span>`;
}

function renderTagsInput(tags: string) {
  const tagList = tags ? tags.split(",").map((t) => t.trim()).filter(Boolean) : [];
  const chips = tagList
    .map((t) => `<span class="tag-chip" data-tag="${escapeHtml(t)}">${escapeHtml(t)}<span class="remove-tag">&times;</span></span>`)
    .join("");
  return `
    <label>Tags
      <div class="tag-input-wrapper">
        ${chips}
        <input type="text" placeholder="Type and press comma..." />
        <input type="hidden" name="tags" value="${escapeHtml(tags)}" />
      </div>
    </label>`;
}

function escapeHtml(input: string) {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
