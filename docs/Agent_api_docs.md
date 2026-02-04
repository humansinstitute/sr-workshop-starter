# Agent API Documentation

API for AI agents to read and write todos via SuperBased.

## Authentication

All requests require a Bearer token in the Authorization header:
```
Authorization: Bearer $TOKEN
```

The token will be provided in your prompt.

## Base URL

```
https://sb.otherstuff.studio
```

## Config Values

Get these from the **Agent Connect** menu in the app:

- `superbasedURL` - base URL for API calls
- `userKey` - hex pubkey of the logged-in user (use in `user_pubkey` field)
- `userNpub` - npub of the logged-in user (use in `metadata.owner` field) **IMPORTANT!**
- `superbasedAppKey` - hex pubkey of the app (use in `app_pubkey` field)

---

## Endpoints

### Read all todos

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://sb.otherstuff.studio/db/superbased_records?app_pubkey={superbasedAppKey}&collection=todos"
```

### Read todos for a specific user

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://sb.otherstuff.studio/db/superbased_records?app_pubkey={superbasedAppKey}&collection=todos&user_pubkey={userKey}"
```

### Read todos assigned to a user

Fetch all and filter by `metadata.assigned_to`:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "https://sb.otherstuff.studio/db/superbased_records?app_pubkey={superbasedAppKey}&collection=todos"
```

Then filter results where `metadata.assigned_to` equals the target hex pubkey.

### Write/Update a todo

```bash
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "record_id": "todo_{uuid}",
    "app_pubkey": "{superbasedAppKey}",
    "user_pubkey": "{userKey}",
    "collection": "todos",
    "encrypted_data": "{...escaped JSON...}",
    "metadata": {
      "local_id": "{uuid}",
      "owner": "{userNpub}",
      "updated_at": "2024-01-01T00:00:00.000Z",
      "device_id": "agent"
    }
  }' \
  https://sb.otherstuff.studio/db/superbased_records
```

**CRITICAL**:
- `record_id` must use **underscore**: `todo_abc123` (NOT `todo-abc123`)
- `metadata.owner` must be the **npub** (NOT hex pubkey) - this is how the app finds your todos!
- `encrypted_data` must be **properly escaped JSON** - see JSON Escaping section below

---

## JSON Escaping (IMPORTANT!)

The `encrypted_data` field is a **JSON string containing JSON**. You must properly escape:

| Character | Escape as |
|-----------|-----------|
| Newline | `\\n` |
| Tab | `\\t` |
| Quote | `\\"` |
| Backslash | `\\\\` |

**Emojis are OK** - they don't need escaping.

### Bad (will fail):
```json
"encrypted_data": "{\"title\":\"My Task\",\"description\":\"Line 1
Line 2\"}"
```
The literal newline breaks JSON parsing!

### Good (properly escaped):
```json
"encrypted_data": "{\"title\":\"My Task\",\"description\":\"Line 1\\nLine 2\"}"
```

### Tip: Use JSON.stringify twice

In JavaScript/Node:
```javascript
const todoData = {
  title: "📊 Summary",
  description: "Line 1\nLine 2\n**Bold**",
  priority: "sand",
  // ... other fields
};

// This handles all escaping automatically
const encrypted_data = JSON.stringify(JSON.stringify(todoData));
// Result: "\"{\\\"title\\\":\\\"📊 Summary\\\",\\\"description\\\":\\\"Line 1\\\\nLine 2\\\\n**Bold**\\\",...}\""

// Or just stringify once for the value:
const encrypted_data = JSON.stringify(todoData);
// Result: "{\"title\":\"📊 Summary\",\"description\":\"Line 1\\nLine 2\\n**Bold**\",...}"
```

### Common Mistakes

1. **Literal newlines in description** - Use `\\n` not actual line breaks
2. **Unescaped quotes** - All `"` inside the JSON must be `\"`
3. **Copy-pasting formatted text** - May contain hidden control characters

---

## Field Guide

The `encrypted_data` field contains a JSON string. Here's how to use each field:

### title (required)
The main text of the todo.
```json
"title": "Buy groceries"
```

### description
Optional longer description or notes.
```json
"description": "Need milk, eggs, and bread from the store"
```
Leave empty string if not used: `"description": ""`

### state
Controls the workflow status of the todo. Valid values:

| Value | Meaning | When to use |
|-------|---------|-------------|
| `new` | Just created | Default for new todos |
| `doing` | In progress | User has started working on it |
| `blocked` | Waiting/stuck | Something is preventing progress |
| `review` | Ready for review | Work complete, needs verification |
| `done` | Completed | Task is finished |

To change status:
```json
"state": "doing"
```

**Important**: When setting `state` to `"done"`, also set `"done": 1`. For any other state, set `"done": 0`.

### priority
Importance level. Valid values:

| Value | Meaning |
|-------|---------|
| `sand` | Low priority (default) |
| `stone` | Normal priority |
| `iron` | High priority |
| `gold` | Critical/urgent |

```json
"priority": "iron"
```

### tags
Comma-separated string of tags. No spaces around commas.

```json
"tags": "work,urgent,project-x"
```

To add a tag, append to existing: `"work,urgent"` → `"work,urgent,new-tag"`
To remove a tag, filter it out: `"work,urgent,old"` → `"work,urgent"`
Empty tags: `"tags": ""`

### scheduled_for
Optional due date/time. Use ISO8601 format or `null`.

```json
"scheduled_for": "2024-03-15T09:00:00.000Z"
```

No scheduled date:
```json
"scheduled_for": null
```

### assigned_to
Hex pubkey of the user this todo is assigned to, or `null` if unassigned.

```json
"assigned_to": "934b9c5b5d2cbca3c21b9d18da7cac94b61bf0cf57756531d08f6818227c77ce"
```

Unassigned:
```json
"assigned_to": null
```

### done
Binary flag: `0` = not done, `1` = done.

**Must match the state**: If `state` is `"done"`, set `done` to `1`. Otherwise `0`.

```json
"done": 0
```

### deleted
Soft delete flag: `0` = active, `1` = deleted.

To delete a todo, set:
```json
"deleted": 1
```

### created_at
ISO8601 timestamp when the todo was first created. **Never change this after creation.**

Format: `YYYY-MM-DDTHH:mm:ss.sssZ`

```json
"created_at": "2024-01-15T14:30:00.000Z"
```

### updated_at
ISO8601 timestamp of the last modification. **Must update this on every change.**

```json
"updated_at": "2024-01-15T16:45:00.000Z"
```

---

## Timestamp Format

All timestamps use ISO8601 format in UTC:

```
YYYY-MM-DDTHH:mm:ss.sssZ
```

Examples:
- `2024-01-15T14:30:00.000Z`
- `2024-12-25T00:00:00.000Z`
- `2025-06-01T09:15:30.000Z`

Generate in JavaScript:
```javascript
new Date().toISOString()
```

Generate in bash:
```bash
date -u +"%Y-%m-%dT%H:%M:%S.000Z"
```

---

## Common Operations

### Create a new todo

```json
{
  "record_id": "todo_a1b2c3d4e5f67890",
  "app_pubkey": "{superbasedAppKey}",
  "user_pubkey": "{userKey}",
  "collection": "todos",
  "encrypted_data": "{\"title\":\"New task\",\"description\":\"\",\"priority\":\"sand\",\"state\":\"new\",\"tags\":\"\",\"scheduled_for\":null,\"assigned_to\":null,\"done\":0,\"deleted\":0,\"created_at\":\"2024-01-15T14:30:00.000Z\",\"updated_at\":\"2024-01-15T14:30:00.000Z\"}",
  "metadata": {
    "local_id": "a1b2c3d4e5f67890",
    "owner": "{userNpub}",
    "updated_at": "2024-01-15T14:30:00.000Z",
    "device_id": "agent"
  }
}
```

### Mark a todo as in progress

Update the existing record with:
- `"state": "doing"`
- `"done": 0`
- `"updated_at": "{current timestamp}"`

### Mark a todo as complete

Update the existing record with:
- `"state": "done"`
- `"done": 1`
- `"updated_at": "{current timestamp}"`

### Add tags to a todo

If current tags are `"work"`, to add `"urgent"`:
- `"tags": "work,urgent"`
- `"updated_at": "{current timestamp}"`

### Set a due date

- `"scheduled_for": "2024-03-15T09:00:00.000Z"`
- `"updated_at": "{current timestamp}"`

### Delete a todo

- `"deleted": 1`
- `"updated_at": "{current timestamp}"`

### Assign to another user

- `"assigned_to": "{assignee_hex_pubkey}"`
- `"updated_at": "{current timestamp}"`

Also add to metadata:
- `"metadata": { ..., "assigned_to": "{assignee_hex_pubkey}" }`

---

## Record ID Format

The `record_id` must follow this format:
```
todo_{16-character-hex-uuid}
```

Example: `todo_a1b2c3d4e5f67890`

Generate a UUID:
```bash
openssl rand -hex 8
```

**Important**: When updating an existing todo, use the same `record_id` to overwrite it.

---

## Notes

- The `encrypted_data` field is a JSON string (escaped JSON within JSON)
- Always update `updated_at` when modifying any field
- Set `device_id` to `"agent"` to identify agent-created/modified records
- The `metadata.updated_at` should match the `updated_at` inside `encrypted_data`
- Never modify `created_at` after initial creation
