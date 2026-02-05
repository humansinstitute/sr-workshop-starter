# UI Changes Guide

This guide explains how to modify the application's visual appearance, styles, and Alpine.js UI components.

## Architecture Overview

- **Single-file UI**: All markup lives in `index.html`
- **Styles**: `public/css/app.css` (CSS variables for theming)
- **Reactivity**: Alpine.js 3.14.8 with a centralized store
- **No build step for CSS**: Styles are loaded directly

## CSS Theme System

All colors, spacing, and radii use CSS variables defined in `:root`:

```css
:root {
  --bg: #f4f4f4;
  --surface: #fff;
  --border: #e5e5e5;
  --text: #111;
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 14px;
}
```

**To change the theme**: Modify these variables. All components inherit from them.

## Reusable UI Patterns

### Badges (Priority & State)

Badges display priority and state with semantic colors:

```html
<span class="badge" :class="`priority-${todo.priority}`" x-text="$store.app.formatPriority(todo.priority)"></span>
<span class="badge" :class="`state-${todo.state}`" x-text="$store.app.formatState(todo.state)"></span>
```

**CSS classes**:
- `.badge.priority-rock` - Red background (urgent)
- `.badge.priority-pebble` - Orange background (medium)
- `.badge.priority-sand` - Blue background (low)
- `.badge.state-new` - Gray
- `.badge.state-ready` - Pink
- `.badge.state-in_progress` - Purple
- `.badge.state-done` - Green

**To add a new priority/state**: Add a CSS class in `app.css` following the pattern.

### Tag Chips

Tags are pill-shaped interactive elements:

```html
<span class="tag-chip" :class="{ 'active': isSelected }" x-text="tag"></span>
```

**CSS**:
```css
.tag-chip {
  display: inline-flex;
  background: #f3f0ff;
  border: 1px solid #d4c9ff;
  border-radius: 999px;
  padding: 0.1rem 0.5rem;
}
.tag-chip.active { background: #5b4b8a; color: #fff; }
```

### Modals

All modals follow this pattern:

```html
<div
  class="modal-overlay"
  x-show="$store.app.showXxxModal"
  @click.self="$store.app.showXxxModal = false"
  @keydown.escape.window="$store.app.showXxxModal = false"
>
  <div class="modal">
    <button class="modal-close" type="button" @click="$store.app.showXxxModal = false">&times;</button>
    <h2>Modal Title</h2>
    <!-- Content -->
  </div>
</div>
```

**To add a new modal**:
1. Add `showXxxModal: false` to the store in `app.js`
2. Add a method to open it: `openXxxModal() { this.showXxxModal = true; }`
3. Copy the HTML pattern above into `index.html`

### Form Inputs

Standard form styling:

```html
<label>
  Field Name
  <input x-model="localTodo.fieldName" />
</label>
```

**Key input classes**:
- `.hero-input` - Large prominent input (add todo)
- `.edit-form input` - Standard form inputs
- `.tag-input-wrapper` - Container for tag chip input

### Buttons

```css
button { /* Base button styling */ }
.auth-option { /* Authentication buttons */ }
.modal-close { /* Modal close X button */ }
.clear-filters { /* Small text button */ }
```

## Alpine.js Component Patterns

### Store Access

All state lives in the global store. Access it via `$store.app`:

```html
<!-- Read data -->
<span x-text="$store.app.displayName"></span>

<!-- Conditional display -->
<div x-show="$store.app.isLoggedIn">...</div>

<!-- Bind classes -->
<button :class="{ 'active': $store.app.showArchive }">...</button>

<!-- Call methods -->
<button @click="$store.app.logout()">Log out</button>
```

### Two-Level Binding Pattern

For editable items, we use two levels:

1. **Live data from store** (`todo.*`) - Always current, used for display
2. **Local copy** (`localTodo.*`) - Used for form editing

```html
<!-- Summary displays live data -->
<span class="todo-title" x-text="todo.title"></span>

<!-- Edit form uses local copy -->
<input x-model="localTodo.title" />
```

This prevents edits from immediately reflecting in the summary and allows cancellation.

### Creating New Components

Use `Alpine.data()` for reusable components:

```javascript
// In app.js
Alpine.data('myComponent', (initialData) => ({
  // Local state
  localState: { ...initialData },

  // Methods
  doSomething() {
    this.$store.app.someMethod(this.localState);
  },

  // Lifecycle
  init() {
    // Runs when component mounts
  }
}));
```

```html
<!-- In index.html -->
<div x-data="myComponent(dataFromStore)">
  <input x-model="localState.field" />
  <button @click="doSomething()">Save</button>
</div>
```

### x-for Loops

Always provide a `:key` for loops:

```html
<template x-for="item in $store.app.items" :key="item.id">
  <li x-text="item.name"></li>
</template>
```

### Conditional Rendering

- `x-show` - Toggles CSS display (element stays in DOM)
- `x-if` - Actually removes/adds element (use inside `<template>`)

```html
<!-- Use x-show for frequent toggles -->
<div x-show="$store.app.showMenu">...</div>

<!-- Use x-if for rarely rendered content -->
<template x-if="$store.app.items.length === 0">
  <li class="empty-state">No items</li>
</template>
```

## Adding New UI Elements

### Adding a Button to Avatar Menu

1. Find the `.avatar-menu` section in `index.html`
2. Add a button:

```html
<button type="button" @click="$store.app.myNewAction()">New Action</button>
```

3. Add the method in `app.js` store

### Adding a New Section

1. Add state to store if needed (`showNewSection: false`)
2. Add HTML section in `index.html`:

```html
<section class="new-section" x-show="$store.app.showNewSection">
  <h2>Section Title</h2>
  <!-- Content -->
</section>
```

3. Add CSS in `app.css`:

```css
.new-section {
  padding: 1rem;
  background: var(--surface);
  border-radius: var(--radius-md);
}
```

### Adding New Form Fields to Todos

See `docs/functional_changes.md` for the full checklist - UI changes require coordinating with the data layer.

## Sync Status Indicator

The avatar shows sync state via colored ring:

```html
<button class="avatar-chip"
  :class="{
    'sync-status-synced': $store.app.syncStatus === 'synced',
    'sync-status-unsynced': $store.app.syncStatus === 'unsynced',
    'sync-status-syncing': $store.app.syncStatus === 'syncing'
  }">
```

**CSS**:
```css
.avatar-chip.sync-status-synced { box-shadow: 0 0 0 3px #22c55e; }
.avatar-chip.sync-status-unsynced { box-shadow: 0 0 0 3px #f97316; }
.avatar-chip.sync-status-syncing {
  box-shadow: 0 0 0 3px #3b82f6;
  animation: sync-pulse 1.5s ease-in-out infinite;
}
```

## Best Practices

1. **Reuse existing patterns** - Check `app.css` for existing classes before creating new ones
2. **Use CSS variables** - Never hardcode colors; use `var(--variable)`
3. **Keep store methods clean** - UI logic in components, business logic in store
4. **Test on mobile** - The app is responsive; check viewport meta tag
5. **Use semantic HTML** - `<button>` for actions, `<a>` for navigation
6. **Alpine directives** - Prefer `x-show` over manual class toggling

## File Reference

| File | Purpose |
|------|---------|
| `index.html` | All markup and Alpine components |
| `public/css/app.css` | All styles, theme variables |
| `public/js/app.js` | Alpine store and component definitions |
| `public/js/utils.js` | Formatting helpers (`formatState`, `parseTags`) |
