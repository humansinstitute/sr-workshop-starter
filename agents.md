# Agents

- My preference is for you to answer quickly. Do the research you need but don't get carried away doing long tasks.
- If you have multiple steps, ask a question to ensure you keep on track.

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

## Guidelines

- Do not start servers yourself; the user manages them outside the agent
- Always check for syntax errors before submitting changes
- Ensure you always review links to images when presented in a prompt
- Run lint before shipping: `bun run lint`
- Commit every change with a clear message so rollbacks stay easy
- Make a note of current commit before starting and after a change has completed
- **ALWAYS read type definitions (`.d.ts` files) before using any library, SDK, or API** - never assume function signatures based on naming conventions. Check `node_modules/<package>/dist/*.d.ts` for the actual interface.
