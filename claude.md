# Agents

- My preference is for you to answer quickly. Do the research you need but don't get carried away doing long tasks.
- If you have multiple steps, ask a question to ensure you keep on track.

## Documentation

- **[UI Changes Guide](docs/ui_changes.md)** - How to modify styles, Alpine.js components, and visual patterns
- **[Functional Changes Guide](docs/functional_changes.md)** - How data flows, adding fields, making changes that compile

## Architecture

This is a **local-first, static-only** application. There is no backend server - all data lives in the browser's IndexedDB via Dexie, encrypted with NIP-44.

## Development

- No dependencies to install - all imports via ESM CDN (esm.sh)
- Run `bun dev` for Vite dev server with hot reload (uses bunx)
- Run `bun build` to generate static files in `dist/`
- The app can be deployed to any static host (Netlify, Vercel, GitHub Pages, etc.)
- You should ensure logs are written to a file in <project_dir>/tmp/logs/...log that you can read directly in the project structure.
- You should flush this before we conduct a new test.
- You should always read the logs when fixing bugs

## Testing

**IMPORTANT: Run integration tests before committing changes to sync, db, or encryption code.**

```bash
bun run test          # Run all tests once
bun run test:watch    # Watch mode for development
bun run test -- --reporter=verbose  # Detailed output
```

### Test Structure

- `tests/setup.js` - Test environment (fake IndexedDB, mocks)
- `tests/mock-superbased.js` - Mock SuperBased server for isolated testing
- `tests/sync.test.js` - Integration tests for sync scenarios

### Key Test Scenarios

1. **Local edit preservation** - Verifies local edits aren't overwritten by stale server data
2. **Remote change acceptance** - Verifies newer server changes are correctly merged
3. **Push to server** - Verifies local changes are pushed
4. **Bug regressions** - Tests for specific bugs we've fixed (server_updated_at preservation, decrypt failure handling)

### When to Add Tests

- When fixing sync-related bugs, add a regression test first
- When adding new sync features, add tests for the happy path and edge cases
- When modifying `db.js`, `superbased.js`, or encryption in `nostr.js`

## Key Files

- `index.html` - Single page app shell with Alpine.js
- `public/js/app.js` - Main application logic, Alpine.js store
- `public/js/db.js` - Dexie database with NIP-44 encrypted storage
- `public/js/nostr.js` - Nostr authentication and encryption helpers
- `public/js/nostr-cvm.js` - Nostr CVM integration
- `public/js/utils.js` - Utility functions
- `public/css/app.css` - Application styles
- `public/sw.js` - Service worker for offline PWA support
- `public/manifest.webmanifest` - PWA manifest
- `vite.config.js` - Vite configuration

## Data Storage

- All todos stored in IndexedDB via Dexie
- Sensitive fields (title, description, etc.) encrypted with NIP-44
- `owner` field stored in plaintext for querying
- No server-side database - data persists locally in the browser

## UI Patterns

- Alpine.js for reactivity (`$store.app.*`)
- Call `$store.app` methods for state mutations
- Login/auth handled via Nostr (ephemeral, extension, bunker, or nsec)

### Live Data Rendering

**IMPORTANT:** All data displayed in todo cards must be live-rendered from the store, not from stale component state.

- **Summary/badges**: Use `todo.*` directly from the x-for loop (e.g., `todo.title`, `todo.state`)
- **Tags in summary**: Use `$store.app.parseTags(todo.tags)` for live rendering
- **Edit form inputs**: Use `localTodo.*` for two-way binding during editing
- **Tag chips in edit form**: Use `tagsArray` (parsed from `localTodo.tags`)

The `todoItem` component has:
- `localTodo` - local copy for editing (synced from store on init and when `updated_at` changes)
- `tagsArray` - computed from `localTodo.tags` for edit form display

When adding new fields to todos, ensure:
1. Field is included in encrypted payload (db.js)
2. Field is synced to `localTodo` in component init
3. Summary displays use live `todo.*` from store
4. Edit form uses `localTodo.*` for binding

## Guidelines

- Do not start servers yourself; the user manages them outside the agent
- Always check for syntax errors before submitting changes
- Ensure you always review links to images when presented in a prompt
- **Run tests before shipping: `bun run test`** (especially for sync/db/encryption changes)
- Commit every change with a clear message so rollbacks stay easy
- Make a note of current commit before starting and after a change has completed
- **ALWAYS read type definitions (`.d.ts` files) before using any library, SDK, or API** - never assume function signatures based on naming conventions. Check `node_modules/<package>/dist/*.d.ts` for the actual interface.
- **Bump service worker version** when making UI or feature changes. Update `CACHE_NAME` in `public/sw.js` (e.g., `v47` → `v48`). This ensures mobile browsers fetch fresh assets instead of serving stale cached versions.
