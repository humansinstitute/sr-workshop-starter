# Functional Changes Guide

This guide explains how data flows through the application and how to make changes that compile and work correctly.

## Architecture Overview

```
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│   index.html    │ ──▶  │  Alpine Store   │ ──▶  │    Dexie DB     │
│  (UI/Markup)    │ ◀──  │   (app.js)      │ ◀──  │    (db.js)      │
└─────────────────┘      └─────────────────┘      └─────────────────┘
                                │
                                ▼
                         ┌─────────────────┐
                         │  SuperBased     │
                         │  (sync.js)      │
                         └─────────────────┘
```

- **No backend server** - All data in browser IndexedDB
- **ESM imports only** - Dependencies via esm.sh CDN
- **Vite for dev/build** - Hot reload, bundling

## Data Flow

### Read Path

1. User logs in → `loadTodos()` called
2. `getTodosByOwner(npub)` reads from IndexedDB
3. Records deserialized (JSON payload → object)
4. Store's `todos` array updated
5. Alpine.js reactivity renders UI

### Write Path

1. User edits form → `localTodo` updated
2. User clicks Save → component's `save()` called
3. `$store.app.updateTodoField()` called
4. `updateTodo(id, changes)` writes to IndexedDB
5. `loadTodos()` refreshes store
6. UI re-renders with new data

## Database Layer (db.js)

### Schema

```javascript
const db = new Dexie('TodoAppV2');
db.version(1).stores({
  todos: 'id, owner',  // Indexed fields only
});
```

### Data Structure

**Plaintext fields** (queryable, stored directly):
- `id` - 16-char hex UUID
- `owner` - npub (Nostr public key)

**Encrypted payload** (JSON string):
```javascript
const ENCRYPTED_FIELDS = [
  'title', 'description', 'priority', 'state', 'tags',
  'scheduled_for', 'done', 'deleted', 'created_at',
  'updated_at', 'assigned_to'
];
```

### CRUD Operations

```javascript
// Create
await createTodo({ title, description, priority, owner, tags, ... })

// Read
const todos = await getTodosByOwner(owner)
const todo = await getTodoById(id)

// Update (read-modify-write pattern)
await updateTodo(id, { title: newTitle, state: newState })
// ↳ Automatically updates `updated_at`

// Delete
await deleteTodo(id)        // Soft delete (deleted: 1)
await deleteTodo(id, true)  // Hard delete
```

### Adding a New Field

1. **Add to ENCRYPTED_FIELDS in db.js**:
```javascript
const ENCRYPTED_FIELDS = [
  // ... existing fields
  'my_new_field',
];
```

2. **Set default in createTodo()**:
```javascript
export async function createTodo(data) {
  const todo = {
    // ... existing defaults
    my_new_field: data.my_new_field || null,
  };
}
```

3. **No schema migration needed** - Fields are in JSON payload, not indexed

## Alpine Store (app.js)

### Store Structure

```javascript
Alpine.store('app', {
  // Auth state
  session: null,
  isLoggedIn: false,
  profile: null,

  // Data
  todos: [],
  filterTags: [],
  showArchive: false,

  // Computed (getters)
  get activeTodos() { return this.todos.filter(...); },
  get doneTodos() { return this.todos.filter(...); },
  get allTags() { return [...new Set(...)]; },

  // Methods
  async loadTodos() { ... },
  async addTodo() { ... },
  async updateTodoField(id, field, value) { ... },
  async transitionState(id, newState) { ... },
  async deleteTodoItem(id) { ... },
});
```

### Adding Store Methods

```javascript
// In Alpine.store('app', { ... })

async myNewMethod(param) {
  try {
    // Call DB function
    await someDbOperation(param);
    // Refresh data
    await this.loadTodos();
  } catch (err) {
    console.error('myNewMethod:', err);
    this.someError = err.message;
  }
},
```

### Adding Computed Properties

```javascript
get myFilteredList() {
  return this.todos.filter(t => t.some_condition);
},
```

## Component Pattern (todoItem)

The `todoItem` component handles individual todo editing:

```javascript
Alpine.data('todoItem', (todo) => ({
  // Local copy for editing
  localTodo: { ...todo },
  tagInput: '',

  // Computed
  get tagsArray() {
    return parseTags(this.localTodo.tags);
  },

  // Watch for external changes (sync)
  init() {
    this.$watch('todo.updated_at', () => {
      this.localTodo = { ...this.todo };
    });
  },

  // Methods
  async save() {
    for (const [key, value] of Object.entries(this.localTodo)) {
      if (value !== this.todo[key]) {
        await this.$store.app.updateTodoField(this.todo.id, key, value);
      }
    }
  },
}));
```

### Two-Level Binding

**Critical pattern** - Don't skip this:

| Context | Use | Why |
|---------|-----|-----|
| Summary display | `todo.*` | Always shows current store data |
| Edit form | `localTodo.*` | Isolated edits until save |
| Tag display (summary) | `$store.app.parseTags(todo.tags)` | Live from store |
| Tag display (edit) | `tagsArray` | From localTodo |

## Adding a New Feature Checklist

### New Field on Todos

- [ ] Add to `ENCRYPTED_FIELDS` in `db.js`
- [ ] Add default value in `createTodo()`
- [ ] Add to `localTodo` sync in component's `init()` watcher
- [ ] Add form input with `x-model="localTodo.fieldName"`
- [ ] Add summary display with `x-text="todo.fieldName"`
- [ ] Run tests: `bun run test`

### New Store Method

- [ ] Add method to `Alpine.store('app', {...})`
- [ ] Call `await this.loadTodos()` after DB mutations
- [ ] Add error handling with `this.someError = err.message`
- [ ] Add UI trigger (`@click="$store.app.myMethod()"`)

### New Modal

- [ ] Add `showXxxModal: false` to store
- [ ] Add `openXxxModal()` method to set it true
- [ ] Copy modal HTML pattern to `index.html`
- [ ] Test escape key and outside click close

### New Component

- [ ] Define with `Alpine.data('componentName', (props) => ({...}))`
- [ ] Use in HTML with `x-data="componentName(data)"`
- [ ] Access store via `this.$store.app`

## Build System

### Development

```bash
bun dev  # Vite dev server on port 5173
```

Changes hot-reload automatically.

### Production Build

```bash
bun build  # Output to dist/
```

### Vite Configuration

Key settings in `vite.config.js`:

```javascript
export default defineConfig({
  // Buffer polyfill for nostr-tools
  resolve: { alias: { buffer: 'buffer' } },
  define: { global: 'globalThis' },

  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        superbased: 'src/superbased-bundle.js',
      },
    },
  },
});
```

## Testing

### Running Tests

```bash
bun run test              # All tests once
bun run test:watch        # Watch mode
bun run test -- --reporter=verbose  # Detailed output
```

### Test Structure

```
tests/
├── setup.js              # Fake IndexedDB, mocks
├── mock-superbased.js    # Mock sync server
└── sync.test.js          # Integration tests
```

### When to Add Tests

- Fixing sync/db bugs → Add regression test first
- New sync features → Test happy path + edge cases
- Modifying `db.js`, `superbased.js`, or `nostr.js`

### Test Example

```javascript
it('should preserve local edits over stale server data', async () => {
  // Setup
  const localTodo = await createTodo({ title: 'Local edit', ... });

  // Simulate sync with older server data
  const serverRecord = { ...localTodo, title: 'Old server', updated_at: olderTimestamp };

  // Verify local wins
  await mergeRemoteRecords(owner, [serverRecord]);
  const result = await getTodoById(localTodo.id);
  expect(result.title).toBe('Local edit');
});
```

## Common Patterns

### Error Handling

```javascript
async someMethod() {
  try {
    await riskyOperation();
  } catch (err) {
    console.error('Context:', err);
    this.errorField = err.message || 'Operation failed';
  }
}
```

### Loading States

```javascript
async fetchData() {
  this.isLoading = true;
  try {
    await loadData();
  } finally {
    this.isLoading = false;
  }
}
```

```html
<button :disabled="$store.app.isLoading">
  <span x-show="!$store.app.isLoading">Submit</span>
  <span x-show="$store.app.isLoading">Loading...</span>
</button>
```

### Refresh After Mutation

Always call `loadTodos()` after modifying data:

```javascript
async updateSomething(id, value) {
  await updateTodo(id, { field: value });
  await this.loadTodos();  // <-- Don't forget!
}
```

## File Reference

| File | Purpose |
|------|---------|
| `public/js/db.js` | Dexie database, CRUD operations |
| `public/js/app.js` | Alpine store, component definitions |
| `public/js/utils.js` | State machine, formatters |
| `public/js/nostr.js` | Auth, encryption helpers |
| `public/js/superbased.js` | Sync client |
| `vite.config.js` | Build configuration |
| `tests/*.test.js` | Integration tests |

## Debugging

### Check Browser IndexedDB

1. Open DevTools → Application → IndexedDB
2. Find `TodoAppV2` database
3. Inspect `todos` table

### Check Console Logs

All errors log to console with context. Enable verbose logging:

```javascript
console.log('Debug:', variable);
```

### Check Test Output

```bash
bun run test -- --reporter=verbose
```

## Do NOT

- **Skip `loadTodos()`** after mutations - UI won't update
- **Mutate store data directly** - Always use methods
- **Forget `await`** on async operations
- **Add fields without updating ENCRYPTED_FIELDS** - Data won't persist
- **Start servers** - User manages those externally
