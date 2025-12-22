# Code Structure

Overview of the current layout so you can find the right place for changes quickly.

## Layout
- `src/server.ts`: Bun entry point; registers routes, serves static assets from `public/`, and renders the HTML page.
- `src/config.ts`: Central constants (port, app name, cookie names, timeouts, paths).
- `src/http.ts`: Response helpers (`jsonResponse`, `redirect`, `withErrorHandling`, cookie parsing/serialization).
- `src/logger.ts`: Small logging helpers.
- `src/types.ts`: Shared primitives for sessions and todo enums.
- `src/domain/`: Domain helpers/constants (`todos.ts` for state/priorities/transitions).
- `src/utils/`: Generic helpers (dates, HTML escaping).
- `src/services/`: Business logic. `auth.ts` handles session validation/creation; `todos.ts` handles todo mutations/listing/summaries.
- `public/`: Static assets, including `app.js` (client module) and icons.
- `tests/`: Bun tests covering auth and todo flows.

## Patterns
- **Thin server**: Route handlers delegate to services for mutations/queries and to validation helpers for input checks.
- **Pure helpers**: Domain helpers enforce allowed transitions; validation normalizes inputs before hitting services.
- **Client script**: The heavy inline script is now `public/app.js`; the page only sets `window.__NOSTR_SESSION__` and loads the module. Client state mutations must call `refreshUI()` in `app.js` to keep panels in sync.

## When adding features
- Add business logic to `src/services/*`.
- Add validation rules to `src/validation.ts`.
- Update UI behavior in `public/app.js` and server-rendered markup in `src/server.ts`.
