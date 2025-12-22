import { extname, join } from "path";

import { ALLOWED_STATE_TRANSITIONS, formatPriorityLabel, formatStateLabel } from "./domain/todos";
import { jsonResponse, redirect, safeJson, unauthorized, withErrorHandling } from "./http";
import { logError } from "./logger";
import { AuthService, parseSessionCookie } from "./services/auth";
import {
  createTodosFromTasks,
  latestSummaries,
  listOwnerScheduled,
  listOwnerTodos,
  listOwnerUnscheduled,
  normalizeSummaryText,
  persistSummary,
  quickAddTodo,
  removeTodo,
  transitionTodoState,
  updateTodoFromForm,
} from "./services/todos";
import { formatLocalDate } from "./utils/date";
import {
  MAX_TASKS_PER_REQUEST,
  isValidDateString,
  normalizeStateInput,
  validateLoginMethod,
} from "./validation";

import type { Todo } from "./db";
import type { Session, TodoPriority, TodoState } from "./types";

const PORT = Number(Bun.env.PORT ?? 3000);
const SESSION_COOKIE = "nostr_session";
const LOGIN_EVENT_KIND = 27235;
const LOGIN_MAX_AGE_SECONDS = 60;
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const COOKIE_SECURE = Bun.env.NODE_ENV === "production";
const APP_NAME = "Other Stuff To Do";
const APP_TAG = "other-stuff-to-do";
const PUBLIC_DIR = join(import.meta.dir, "../public");

const authService = new AuthService(
  SESSION_COOKIE,
  APP_TAG,
  LOGIN_EVENT_KIND,
  LOGIN_MAX_AGE_SECONDS,
  COOKIE_SECURE,
  SESSION_MAX_AGE_SECONDS
);

const STATIC_FILES = new Map<string, string>([
  ["/favicon.ico", "favicon.png"],
  ["/favicon.png", "favicon.png"],
  ["/apple-touch-icon.png", "apple-touch-icon.png"],
  ["/icon-192.png", "icon-192.png"],
  ["/icon-512.png", "icon-512.png"],
  ["/manifest.webmanifest", "manifest.webmanifest"],
  ["/app.js", "app.js"],
]);

type LoginMethod = "ephemeral" | "extension" | "bunker" | "secret";

type Session = {
  token: string;
  pubkey: string;
  npub: string;
  method: LoginMethod;
  createdAt: number;
};

type LoginRequestBody = {
  method?: LoginMethod;
  event?: {
    id: string;
    pubkey: string;
    sig: string;
    kind: number;
    content: string;
    created_at: number;
    tags: string[][];
  };
};

const server = Bun.serve({
  port: PORT,
  fetch: withErrorHandling(async (req) => {
    const url = new URL(req.url);
    const { pathname } = url;
    const session = getSessionFromRequest(req);

    if (req.method === "GET") {
      const staticResponse = await serveStatic(pathname);
      if (staticResponse) return staticResponse;
    }

    if (req.method === "GET") {
      const aiTasksMatch = pathname.match(/^\/ai\/tasks\/(\d+)(?:\/(yes|no))?$/);
      if (aiTasksMatch) return handleAiTasks(url, aiTasksMatch);
      if (pathname === "/ai/summary/latest") return handleLatestSummary(url);
      if (pathname === "/") return handleHome(url, session);
    }

    if (req.method === "POST") {
      if (pathname === "/auth/login") return handleLogin(req);
      if (pathname === "/auth/logout") return handleLogout(req);
      if (pathname === "/ai/summary") return handleSummaryPost(req);
      if (pathname === "/ai/tasks") return handleAiTasksPost(req);
      if (pathname === "/todos") return handleTodoCreate(req, session);
      const updateMatch = pathname.match(/^\/todos\/(\d+)\/update$/);
      if (updateMatch) return handleTodoUpdate(req, session, Number(updateMatch[1]));
      const stateMatch = pathname.match(/^\/todos\/(\d+)\/state$/);
      if (stateMatch) return handleTodoState(req, session, Number(stateMatch[1]));
      const deleteMatch = pathname.match(/^\/todos\/(\d+)\/delete$/);
      if (deleteMatch) return handleTodoDelete(session, Number(deleteMatch[1]));
    }

    return new Response("Not found", { status: 404 });
  }, (error) => logError("Request failed", error)),
});

console.log(`${APP_NAME} ready on http://localhost:${server.port}`);

async function serveStatic(pathname: string) {
  const fileName = STATIC_FILES.get(pathname);
  if (!fileName) return null;
  const file = Bun.file(join(PUBLIC_DIR, fileName));
  if (!(await file.exists())) return null;
  return new Response(file, { headers: { "Content-Type": contentTypeFor(fileName) } });
}

function contentTypeFor(fileName: string) {
  const ext = extname(fileName).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".ico":
      return "image/x-icon";
    case ".webmanifest":
    case ".json":
      return "application/manifest+json";
    case ".js":
      return "text/javascript; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function redirect(path: string) {
  return new Response(null, { status: 303, headers: { Location: path } });
}

function unauthorized() {
  return new Response("Unauthorized", { status: 401 });
}

function renderPage({ showArchive, session, filterTags = [], todos = [] as Todo[] }: { showArchive: boolean; session: Session | null; filterTags?: string[]; todos?: Todo[] }) {
  const allTodos = todos;
  const filteredTodos = filterTags.length > 0 ? allTodos.filter((todo) => {
    const todoTags = todo.tags ? todo.tags.split(",").map((t) => t.trim().toLowerCase()) : [];
    return filterTags.some((ft) => todoTags.includes(ft.toLowerCase()));
  }) : allTodos;
  const activeTodos = filteredTodos.filter((t) => t.state !== "done");
  const doneTodos = filteredTodos.filter((t) => t.state === "done");
  const remaining = session ? activeTodos.length : 0;
  const archiveHref = showArchive ? "/" : "/?archive=1";
  const archiveLabel = showArchive ? "Hide archive" : `Archive (${doneTodos.length})`;
  // Collect all unique tags from all todos
  const allTags = new Set<string>();
  for (const todo of allTodos) {
    if (todo.tags) {
      todo.tags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean).forEach((t) => allTags.add(t));
    }
  }
  const tagFilterBar = session && allTags.size > 0 ? renderTagFilterBar(Array.from(allTags), filterTags, showArchive) : "";
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
  <style>
    :root {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f4f4f4;
      color: #111;
    }
    body {
      margin: 0 auto;
      padding: 2rem;
      max-width: 640px;
    }
    h1 {
      margin-bottom: 0.25rem;
      font-size: clamp(2rem, 5vw, 3rem);
    }
    .page-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
    }
    .session-controls {
      position: relative;
      min-height: 48px;
      min-width: 48px;
      display: flex;
      justify-content: flex-end;
      align-items: center;
      padding-top: 0.65rem;
    }
    .avatar-chip {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      border: none;
      background: #111;
      color: #fff;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      padding: 0;
      box-shadow: 0 6px 18px rgba(15, 23, 42, 0.2);
      cursor: pointer;
      transition: transform 150ms ease, box-shadow 150ms ease;
    }
    .avatar-chip:hover {
      transform: translateY(-1px);
      box-shadow: 0 10px 24px rgba(15, 23, 42, 0.25);
    }
    .avatar-chip img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .avatar-fallback {
      font-weight: 600;
      letter-spacing: 0.02em;
    }
    .avatar-menu {
      position: absolute;
      top: calc(100% + 0.5rem);
      right: 0;
      background: #fff;
      border: 1px solid #e5e5e5;
      border-radius: 12px;
      padding: 0.25rem;
      box-shadow: 0 12px 30px rgba(15, 23, 42, 0.2);
      min-width: 140px;
      z-index: 20;
    }
    .avatar-menu button {
      width: 100%;
      background: transparent;
      border: none;
      padding: 0.5rem 0.75rem;
      text-align: left;
      cursor: pointer;
      border-radius: 8px;
      font-size: 0.9rem;
      color: #111;
    }
    .avatar-menu button:hover {
      background: #f3f4f6;
    }
    .subtitle {
      margin-top: 0;
      color: #666;
      font-size: 0.95rem;
    }
    .hero-entry {
      width: 100%;
      padding: 0;
      background: transparent;
      border: none;
      border-radius: 0;
      margin-top: 1.5rem;
      margin-bottom: 2rem;
      box-shadow: none;
    }
    .todo-form {
      margin: 0;
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      max-width: 820px;
    }
    .hero-input-wrapper {
      width: 100%;
    }
    .hero-input {
      display: block;
      padding: 0.85rem 1rem;
      width: 100%;
      font-size: 1rem;
      border: 1px solid #0f172a;
      border-radius: 10px;
      box-sizing: border-box;
      line-height: 1.3;
      background: #fff;
      box-shadow: none;
    }
    .hero-submit:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 14px rgba(15, 23, 42, 0.25);
    }
    .remaining-summary {
      margin: 0 0 1rem;
      color: #333;
      font-weight: 500;
    }
    button {
      border: none;
      background: #111;
      color: #fff;
      padding: 0.4rem 0.8rem;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.9rem;
    }
    ul {
      list-style: none;
      padding: 0;
      margin: 1rem 0;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }
    li {
      background: #fff;
      border-radius: 10px;
      border: 1px solid #e5e5e5;
    }
    details {
      padding: 0.6rem 0.9rem;
    }
    details[open] {
      border-top-left-radius: 10px;
      border-top-right-radius: 10px;
    }
    summary {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      cursor: pointer;
      list-style: none;
    }
    summary::-webkit-details-marker {
      display: none;
    }
    .todo-title {
      font-weight: 600;
      flex: 1;
    }
    .badges {
      display: flex;
      gap: 0.4rem;
      flex-wrap: wrap;
      font-size: 0.8rem;
    }
    .badge {
      border-radius: 999px;
      padding: 0.1rem 0.6rem;
      text-transform: capitalize;
      border: 1px solid #ddd;
    }
    .badge.priority-rock {
      background: #ffe3e3;
      border-color: #f5b5b5;
    }
    .badge.priority-pebble {
      background: #fff1d6;
      border-color: #f5c97c;
    }
    .badge.priority-sand {
      background: #e9f4ff;
      border-color: #b5d8ff;
    }
    .badge.state-done {
      background: #e7f8e9;
      border-color: #b0e2b8;
    }
    .badge.state-in_progress {
      background: #f0e8ff;
      border-color: #cdbdff;
    }
    .badge.state-ready {
      background: #fff2f0;
      border-color: #ffcfc3;
    }
    .tag-chip {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      background: #f3f0ff;
      border: 1px solid #d4c9ff;
      border-radius: 999px;
      padding: 0.1rem 0.5rem;
      font-size: 0.75rem;
      color: #5b4b8a;
    }
    .tag-chip .remove-tag {
      cursor: pointer;
      font-size: 0.9rem;
      line-height: 1;
      opacity: 0.6;
    }
    .tag-chip .remove-tag:hover {
      opacity: 1;
    }
    .tags-display {
      display: flex;
      gap: 0.3rem;
      flex-wrap: wrap;
    }
    .tag-input-wrapper {
      display: flex;
      flex-wrap: wrap;
      gap: 0.3rem;
      padding: 0.4rem;
      border: 1px solid #ccc;
      border-radius: 6px;
      background: #fff;
      min-height: 2.2rem;
      align-items: center;
      cursor: text;
    }
    .tag-input-wrapper:focus-within {
      border-color: #666;
      outline: none;
    }
    .tag-input-wrapper input {
      border: none;
      outline: none;
      flex: 1;
      min-width: 60px;
      font-size: 0.9rem;
      padding: 0.2rem;
    }
    .tag-filter-bar {
      display: flex;
      gap: 0.5rem;
      align-items: center;
      flex-wrap: wrap;
      margin-bottom: 0.75rem;
      padding: 0.5rem;
      background: #fafafa;
      border-radius: 6px;
    }
    .tag-filter-bar .label {
      font-size: 0.85rem;
      color: #666;
    }
    .tag-filter-bar .tag-chip {
      cursor: pointer;
    }
    .tag-filter-bar .tag-chip.active {
      background: #5b4b8a;
      color: #fff;
      border-color: #5b4b8a;
    }
    .tag-filter-bar .clear-filters {
      font-size: 0.8rem;
      color: #666;
      text-decoration: underline;
      cursor: pointer;
    }
    .todo-body {
      margin-top: 0.75rem;
      border-top: 1px solid #f0f0f0;
      padding-top: 0.75rem;
      display: grid;
      gap: 0.75rem;
    }
    .todo-description {
      margin: 0;
      color: #444;
      white-space: pre-wrap;
    }
    .todo-actions {
      display: flex;
      gap: 0.5rem;
      flex-wrap: wrap;
    }
    .todo-actions form {
      margin: 0;
    }
    .edit-form {
      display: grid;
      gap: 0.5rem;
    }
    .edit-form label {
      display: flex;
      flex-direction: column;
      font-size: 0.85rem;
      color: #333;
      gap: 0.25rem;
    }
    .edit-form input,
    .edit-form textarea,
    .edit-form select {
      padding: 0.35rem 0.45rem;
      font-size: 0.9rem;
      border-radius: 6px;
      border: 1px solid #ccc;
      font-family: inherit;
    }
    .work-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 2rem;
      border-top: 1px solid #ddd;
      padding-top: 1rem;
    }
    .section-heading {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .archive-section {
      margin-top: 2rem;
    }
    .archive-toggle {
      text-decoration: none;
      font-size: 0.9rem;
      color: #111;
      border: 1px solid #ddd;
      padding: 0.25rem 0.75rem;
      border-radius: 999px;
      background: #fff;
    }
    .auth-panel {
      border: 1px solid #e5e5e5;
      border-radius: 14px;
      padding: 1.25rem;
      margin-bottom: 1.5rem;
      background: #fff;
      box-shadow: 0 6px 20px rgba(15, 23, 42, 0.08);
    }
    .auth-panel h2 {
      margin: 0 0 0.5rem;
      font-size: 1.2rem;
    }
    .auth-description {
      margin: 0 0 1rem;
      color: #555;
    }
    .auth-actions {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }
    .auth-option {
      padding: 0.75rem 1rem;
      border: 1px solid #111;
      background: #fff;
      color: #111;
      border-radius: 8px;
      font-size: 1rem;
      cursor: pointer;
      transition: background 120ms ease, color 120ms ease;
    }
    .auth-option:hover:not(:disabled) {
      background: #111;
      color: #fff;
    }
    .auth-option:disabled {
      opacity: 0.6;
      cursor: progress;
    }
    .auth-advanced {
      margin-top: 0.5rem;
      padding-top: 0.75rem;
      border-top: 1px dashed #ddd;
    }
    .auth-advanced summary {
      cursor: pointer;
      color: #333;
      font-weight: 600;
    }
    .auth-advanced form {
      margin-top: 0.75rem;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .auth-advanced input {
      padding: 0.6rem 0.75rem;
      border-radius: 8px;
      border: 1px solid #ccc;
      font-size: 0.95rem;
    }
    .bunker-submit {
      align-self: flex-start;
      padding: 0.5rem 1rem;
      border-radius: 999px;
      background: #111;
      color: #fff;
      border: none;
      cursor: pointer;
    }
    .auth-error {
      margin-top: 0.75rem;
      color: #b91c1c;
      font-size: 0.9rem;
    }
    .qr-modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.7);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 100;
      backdrop-filter: blur(4px);
    }
    .qr-modal-overlay[hidden] {
      display: none;
    }
    .qr-modal {
      background: #fff;
      border-radius: 16px;
      padding: 2rem;
      max-width: 340px;
      width: 90%;
      text-align: center;
      position: relative;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.3);
    }
    .qr-modal-close {
      position: absolute;
      top: 0.75rem;
      right: 0.75rem;
      background: transparent;
      border: none;
      font-size: 1.5rem;
      cursor: pointer;
      color: #666;
      padding: 0.25rem;
      line-height: 1;
    }
    .qr-modal-close:hover {
      color: #111;
    }
    .qr-modal h2 {
      margin: 0 0 0.5rem;
      font-size: 1.25rem;
    }
    .qr-modal p {
      margin: 0 0 1.25rem;
      color: #555;
      font-size: 0.9rem;
    }
    .qr-canvas-container {
      display: flex;
      justify-content: center;
    }
    .qr-canvas-container canvas {
      border-radius: 8px;
    }
    .auth-status {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 0.75rem;
    }
    .auth-status button {
      padding: 0.4rem 0.9rem;
      border-radius: 999px;
      border: 1px solid #111;
      background: transparent;
      cursor: pointer;
    }
    details summary {
      cursor: pointer;
      font-weight: 600;
    }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    .hero-hint {
      margin: 0.5rem 0 0;
      color: #555;
      font-size: 0.9rem;
    }
    .hero-input:disabled {
      background: #f5f5f5;
      border-color: #ddd;
      cursor: not-allowed;
    }
    .summary-panel {
      margin-top: 1.5rem;
      padding: 1rem;
      border-radius: 12px;
      border: 1px solid #e5e5e5;
      background: #fff;
      box-shadow: 0 8px 20px rgba(15, 23, 42, 0.08);
    }
    .summary-panel h2 {
      margin: 0;
    }
    .summary-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 0.75rem;
      margin-top: 0.75rem;
    }
    .summary-card {
      border: 1px solid #f0f0f0;
      border-radius: 10px;
      padding: 0.75rem 0.9rem;
      background: #fafafa;
    }
    .summary-card h3 {
      margin: 0 0 0.35rem;
      font-size: 1rem;
    }
    .summary-text {
      margin: 0;
      white-space: pre-wrap;
      color: #333;
      line-height: 1.45;
    }
    .summary-meta {
      margin-top: 0.4rem;
      font-size: 0.85rem;
      color: #666;
    }
    .summary-suggestions {
      border-top: 1px dashed #e0e0e0;
      padding-top: 0.6rem;
      margin-top: 0.6rem;
    }
  </style>
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

function handleHome(url: URL, session: Session | null) {
  const tagsParam = url.searchParams.get("tags");
  const filterTags = tagsParam ? tagsParam.split(",").map((t) => t.trim()).filter(Boolean) : [];
  const showArchive = url.searchParams.get("archive") === "1";
  const todos = session ? listOwnerTodos(session.npub) : [];
  const page = renderPage({ showArchive, session, filterTags, todos });
  return new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function renderTagFilterBar(allTags: string[], activeTags: string[], showArchive: boolean) {
  const baseUrl = showArchive ? "/?archive=1" : "/";
  const chips = allTags.sort().map((tag) => {
    const isActive = activeTags.some((t) => t.toLowerCase() === tag.toLowerCase());
    // Toggle: if active, remove from filter; if not, add to filter
    let newTags: string[];
    if (isActive) {
      newTags = activeTags.filter((t) => t.toLowerCase() !== tag.toLowerCase());
    } else {
      newTags = [...activeTags, tag];
    }
    const href = newTags.length > 0 ? `${baseUrl}${showArchive ? "&" : "?"}tags=${newTags.join(",")}` : baseUrl;
    return `<a href="${href}" class="tag-chip${isActive ? " active" : ""}">${escapeHtml(tag)}</a>`;
  }).join("");
  const clearHref = baseUrl;
  const clearLink = activeTags.length > 0 ? `<a href="${clearHref}" class="clear-filters">Clear filters</a>` : "";
  return `<div class="tag-filter-bar"><span class="label">Filter by tag:</span>${chips}${clearLink}</div>`;
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

async function handleLogin(req: Request) {
  const body = (await safeJson(req)) as LoginRequestBody | null;
  if (!body?.method || !body.event || !validateLoginMethod(body.method)) {
    return jsonResponse({ message: "Invalid payload." }, 400);
  }
  return authService.login(body.method, body.event);
}

function handleLogout(req: Request) {
  const token = parseSessionCookie(req, SESSION_COOKIE);
  return authService.logout(token);
}

function getSessionFromRequest(req: Request): Session | null {
  const token = parseSessionCookie(req, SESSION_COOKIE);
  return authService.getSession(token);
}

async function handleTodoCreate(req: Request, session: Session | null) {
  if (!session) return unauthorized();
  const form = await req.formData();
  const title = String(form.get("title") ?? "");
  const tags = String(form.get("tags") ?? "");
  quickAddTodo(session.npub, title, tags);
  return redirect("/");
}

async function handleTodoUpdate(req: Request, session: Session | null, id: number) {
  if (!session) return unauthorized();
  const form = await req.formData();
  updateTodoFromForm(session.npub, id, form);
  return redirect("/");
}

async function handleTodoState(req: Request, session: Session | null, id: number) {
  if (!session) return unauthorized();
  const form = await req.formData();
  const nextState = normalizeStateInput(String(form.get("state") ?? "ready"));
  transitionTodoState(session.npub, id, nextState);
  return redirect("/");
}

function handleTodoDelete(session: Session | null, id: number) {
  if (!session) return unauthorized();
  removeTodo(session.npub, id);
  return redirect("/");
}

function handleAiTasks(url: URL, match: RegExpMatchArray) {
  const owner = url.searchParams.get("owner");
  if (!owner) return jsonResponse({ message: "Missing owner." }, 400);

  const days = Number(match[1]);
  if (!Number.isFinite(days) || days <= 0) return jsonResponse({ message: "Invalid day range." }, 400);

  const includeUnscheduled = (match[2] || "yes").toLowerCase() !== "no";
  const endDate = formatLocalDate(addDays(new Date(), Math.max(days - 1, 0)));

  const scheduled = listOwnerScheduled(owner, endDate);
  const unscheduled = includeUnscheduled ? listOwnerUnscheduled(owner) : [];

  return jsonResponse({
    owner,
    range_days: days,
    generated_at: new Date().toISOString(),
    scheduled,
    unscheduled: includeUnscheduled ? unscheduled : [],
  });
}

async function handleSummaryPost(req: Request) {
  const body = (await safeJson(req)) as Partial<{
    owner: string;
    summary_date: string;
    day_ahead: string | null;
    week_ahead: string | null;
    suggestions: string | null;
  }> | null;
  if (!body?.owner || !body.summary_date) {
    return jsonResponse({ message: "Missing owner or summary_date." }, 400);
  }

  if (!isValidDateString(body.summary_date)) {
    return jsonResponse({ message: "Invalid summary_date format. Use YYYY-MM-DD." }, 422);
  }

  const payload = {
    owner: body.owner,
    summary_date: body.summary_date,
    day_ahead: normalizeSummaryText(body.day_ahead),
    week_ahead: normalizeSummaryText(body.week_ahead),
    suggestions: normalizeSummaryText(body.suggestions),
  };

  if (!payload.day_ahead && !payload.week_ahead && !payload.suggestions) {
    return jsonResponse({ message: "Provide at least one of day_ahead, week_ahead, or suggestions." }, 422);
  }

  const summary = persistSummary(payload);

  if (!summary) return jsonResponse({ message: "Unable to save summary." }, 500);

  return jsonResponse({
    owner: summary.owner,
    summary_date: summary.summary_date,
    updated_at: summary.updated_at,
  });
}

function handleLatestSummary(url: URL) {
  const owner = url.searchParams.get("owner");
  if (!owner) return jsonResponse({ message: "Missing owner." }, 400);
  const { day, week } = latestSummaries(owner, new Date());
  return jsonResponse({
    owner,
    day,
    week,
  });
}

type TaskInput = {
  title?: string;
  description?: string;
  priority?: string;
  state?: string;
  scheduled_for?: string | null;
  tags?: string;
};

type AiTasksPostBody = {
  owner?: string;
  tasks?: TaskInput[];
};

async function handleAiTasksPost(req: Request) {
  const body = (await safeJson(req)) as AiTasksPostBody | null;

  if (!body?.owner) {
    return jsonResponse({ message: "Missing owner." }, 400);
  }

  if (!Array.isArray(body.tasks) || body.tasks.length === 0) {
    return jsonResponse({ message: "Missing or empty tasks array." }, 400);
  }

  if (body.tasks.length > MAX_TASKS_PER_REQUEST) {
    return jsonResponse({ message: `Maximum ${MAX_TASKS_PER_REQUEST} tasks per request.` }, 400);
  }

  const { created, failed } = createTodosFromTasks(body.owner, body.tasks);

  return jsonResponse({
    owner: body.owner,
    created_at: new Date().toISOString(),
    created,
    failed,
  });
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function escapeHtml(input: string) {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderTagsDisplay(tags: string) {
  if (!tags) return "";
  const tagList = tags.split(",").map((t) => t.trim()).filter(Boolean);
  if (tagList.length === 0) return "";
  return `<span class="tags-display">${tagList.map((t) => `<span class="tag-chip">${escapeHtml(t)}</span>`).join("")}</span>`;
}

function renderTagsInput(tags: string) {
  const tagList = tags ? tags.split(",").map((t) => t.trim()).filter(Boolean) : [];
  const chips = tagList.map((t) => `<span class="tag-chip" data-tag="${escapeHtml(t)}">${escapeHtml(t)}<span class="remove-tag">&times;</span></span>`).join("");
  return `
    <label>Tags
      <div class="tag-input-wrapper">
        ${chips}
        <input type="text" placeholder="Type and press comma..." />
        <input type="hidden" name="tags" value="${escapeHtml(tags)}" />
      </div>
    </label>`;
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
