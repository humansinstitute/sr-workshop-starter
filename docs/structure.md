# Code Structure

Overview of the current layout so you can find the right place for changes quickly.

## Layout
- `src/server.ts`: Bun entry point; wires routes, serves static assets from `public/`, and delegates to renderers.
- `src/config.ts`: Central constants (port, app name, cookie names, timeouts, paths).
- `src/http.ts`: Response helpers (`jsonResponse`, `redirect`, `withErrorHandling`, cookie parsing/serialization).
- `src/logger.ts`: Small logging helpers.
- `src/types.ts`: Shared primitives for sessions and todo enums.
- `src/domain/`: Domain helpers/constants (`todos.ts` for state/priorities/transitions).
- `src/utils/`: Generic helpers (dates, HTML escaping).
- `src/services/`: Business logic. `auth.ts` handles session validation/creation; `todos.ts` handles todo mutations/listing/summaries.
- `src/routes/`: Route handlers grouped by feature (`auth.ts`, `ai.ts`, `home.ts`, `todos.ts`).
- `src/render/home.ts`: Server-rendered HTML template for the app shell.
- `src/static.ts`: Static asset responder (maps known files + falls back to `public/`).
- `public/`: Static assets, including `app.css` (styles), `app.js` (entry), and feature modules (`auth.js`, `avatar.js`, `ui.js`, etc).
- `tests/`: Bun tests covering auth and todo flows.

## Patterns
- **Thin server**: `src/server.ts` only wires routes; handlers live in `src/routes/*` and delegate to services/validation.
- **Pure helpers**: Domain helpers enforce allowed transitions; validation normalizes inputs before hitting services.
- **Rendering**: HTML lives in `src/render/home.ts`; styles live in `public/app.css`; inline `<script>` only seeds `window.__NOSTR_SESSION__`.
- **Client script**: `public/app.js` bootstraps small modules (state, auth, avatar, UI, tag inputs). Client state mutations should use the helpers in `public/state.js` so `onRefresh` listeners fire.

## When adding features
- Add business logic to `src/services/*`.
- Add validation rules to `src/validation.ts`.
- Add routes/handlers under `src/routes/*` and wire them in `src/server.ts`.
- Update server-rendered markup in `src/render/home.ts` and styles in `public/app.css`.
- Update UI behavior in the appropriate client module (e.g., `public/ui.js`, `public/auth.js`) and call state helpers as needed.
