# UI Guide

How the UI is structured, how data refreshes, and how to adjust styles quickly.

## Structure
- Single HTML page rendered server-side in `src/render/home.ts`, served by `src/server.ts`.
- Styles live in `public/app.css`; markup is plain HTML; a tiny inline `<script>` only sets `window.__NOSTR_SESSION__`.
- Primary sections:
  - Header (title + session controls)
  - Auth panel (sign-in options)
  - Hero entry (add todo form)
  - Work list + archive toggle
  - Archive list (optional)
  - Summaries panel (hidden unless data exists)

## Components & Refresh Flow
- `public/state.js` holds `{ session, summaries }` and exposes `setSession`, `setSummaries`, `onRefresh`, `refreshUI`.
- `public/ui.js` registers refresh listeners to update panels and hero state; `public/avatar.js` and `public/summary.js` also register refresh work.
- Session changes:
  - On login: `completeLogin()` (in `public/auth.js`) sets session, fetches summaries, calls `refreshUI()`, then reloads the page to pull todo lists.
  - On logout: clears session and summaries via state helpers and calls `refreshUI()`.
- Summaries:
  - `public/summary.js` calls `/ai/summary/latest?owner=npub…` and stores `{ day, week }` via `setSummaries`.
  - `updateSummaryUI()` shows/hides the summaries panel based on presence of day/week/suggestions and session.
- Todos:
  - Server renders active and archive lists; after login the page reload ensures the latest todos.
  - Form submissions post to server routes and redirect.
- Avatar menu:
  - Toggle via button; closes on outside click; loads profile picture via nostr libs.

## Styling
- All CSS lives in `public/app.css`.
- To update colors/spacing:
  - Modify existing selectors directly in `app.css`.
  - Keep component class names: `.summary-panel`, `.summary-card`, `.todo-body`, `.auth-panel`, etc.
- Layout:
  - Page constrained to `max-width: 640px` with padding.
  - Flex/grid used in small areas (e.g., `.summary-grid`).
- Adding new components:
  - Add markup in `renderHomePage` in `src/render/home.ts`.
  - Add matching styles in `public/app.css`.
  - Wire data via client modules; hook into `state`/`refreshUI()` for dynamic pieces.

## Refresh Patterns (when to call what)
- After any state mutation on the client (login/logout, summaries fetched): call `refreshUI()`.
- For todo changes, server posts redirect to `/`; page reload handles state; no client mutation needed.
- Summaries data loads on login and when `fetchSummaries()` is invoked; call `updateSummaryUI()` afterward (already done in `fetchSummaries()`).

## Quick Style Tweaks Checklist
1) Edit `public/app.css` (colors, radius, spacing, typography).
2) Keep CSS selectors stable; avoid adding new fonts unless necessary.
3) Run `bun run lint` to ensure inline script parses.
4) Use `bun dev --hot` for live reload when tweaking styles.

## Visibility Rules
- Auth panel: hidden when `state.session` exists.
- Session controls: shown when `state.session` exists.
- Summaries panel: hidden unless session exists AND at least one of day/week/suggestions is present.
- Hero input: disabled without session.
