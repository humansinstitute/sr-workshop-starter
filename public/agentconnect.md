# Agent API Documentation

API for AI agents with delegated access to read and update todos via SuperBased.

## How Delegation Works

All todo data is **encrypted with NIP-44**. When a user assigns you as a delegate on their tasks, two things happen:

1. **Per-record encryption**: Each synced record gets a copy of the payload encrypted specifically to your pubkey (stored in `delegate_payloads`)
2. **Delegation manifest**: A Nostr event (kind 30078) is published listing which records you have access to, along with the API base URL

As a delegated agent, you can **read** tasks you've been granted access to, and **update** tasks where you have **write** permission. You cannot see tasks you haven't been delegated.

---

## Authentication

All API requests use **NIP-98 HTTP Auth** (Nostr-signed request headers). There are no Bearer tokens.

Wingman handles NIP-98 signing automatically. Use the `sign_nip98` MCP tool when making raw HTTP requests, or use the higher-level `superbased_fetch_records` and `superbased_sync_records` tools which handle auth internally.

---

## Config Values

These are provided in the Agent Connect JSON from the app:

- `agentConnectGuide` - URL to this document
- `superbasedURL` - SuperBased API base URL for raw HTTP calls
- `appNpub` - The app's npub identifier (use as `app_npub` in all SuperBased MCP calls)
- `ownerPubkey` - Hex pubkey of the task owner (use as `owner_pubkey` when syncing records)
- `ownerNpub` - Npub of the task owner (for display/metadata)

---

## Reading Delegated Tasks

Use the `superbased_fetch_records` MCP tool. It automatically:
- Authenticates via NIP-98
- Fetches records where Wingman is a delegate
- Decrypts each record's `delegate_payloads` entry using NIP-44

### Example

```
superbased_fetch_records(
  app_npub: "npub1abc...",
  collection: "todos"
)
```

### Response

Each record in the response includes a `decrypted_payload` field containing the plaintext todo JSON:

```json
{
  "records": [
    {
      "record_id": "todo_a1b2c3d4e5f67890",
      "collection": "todos",
      "updated_at": "2024-01-15T14:30:00.000Z",
      "decrypted_payload": "{\"title\":\"Buy groceries\",\"description\":\"Milk and eggs\",\"priority\":\"stone\",\"state\":\"doing\",\"tags\":\"shopping\",\"scheduled_for\":null,\"assigned_to\":\"934b9c...\",\"done\":0,\"deleted\":0,\"created_at\":\"2024-01-15T14:30:00.000Z\",\"updated_at\":\"2024-01-15T14:30:00.000Z\"}",
      "metadata": {
        "local_id": "a1b2c3d4e5f67890",
        "owner": "npub1owner...",
        "read_delegates": ["abc123..."],
        "write_delegates": ["abc123..."],
        "schema_version": 1
      }
    }
  ]
}
```

Parse `decrypted_payload` as JSON to get the todo fields. If decryption fails, the record will have a `decrypt_error` field instead.

### Filtering

- Use `collection: "todos"` to get only todo records
- Use `since: "2024-01-15T00:00:00.000Z"` for incremental fetches (only records modified after this time)

---

## Updating Tasks

Use the `superbased_sync_records` MCP tool. It automatically:
- Encrypts the plaintext payload to the owner, all delegates, and Wingman
- Authenticates via NIP-98
- Syncs the record to SuperBased

### Example: Update a task's state

First read the current record, then sync back with changes:

```
superbased_sync_records(
  app_npub: "npub1abc...",
  records: [
    {
      "id": "todo_a1b2c3d4e5f67890",
      "plaintext_payload": "{\"title\":\"Buy groceries\",\"description\":\"Milk and eggs\",\"priority\":\"stone\",\"state\":\"done\",\"tags\":\"shopping\",\"scheduled_for\":null,\"assigned_to\":\"934b9c...\",\"done\":1,\"deleted\":0,\"created_at\":\"2024-01-15T14:30:00.000Z\",\"updated_at\":\"2024-01-16T09:00:00.000Z\"}",
      "owner_pubkey": "934b9c5b5d2cbca3c21b9d18da7cac94b61bf0cf57756531d08f6818227c77ce",
      "collection": "todos",
      "delegate_pubkeys": ["abc123...", "def456..."],
      "metadata": {
        "local_id": "a1b2c3d4e5f67890",
        "owner": "npub1owner...",
        "read_delegates": ["abc123...", "def456..."],
        "write_delegates": ["abc123..."],
        "updated_at": "2024-01-16T09:00:00.000Z",
        "device_id": "agent",
        "schema_version": 1
      }
    }
  ]
)
```

**CRITICAL**:
- `plaintext_payload` must contain **all fields**, not just changed ones
- `owner_pubkey` must be the **hex pubkey** of the task owner
- `delegate_pubkeys` should include all current delegates (from the record's metadata)
- Always update `updated_at` to the current time in both the payload and metadata
- Set `device_id` to `"agent"` in metadata

---

## Raw API with NIP-98 (Advanced)

If you need to make direct HTTP calls instead of using the SuperBased MCP tools, sign each request with NIP-98:

### Fetch delegated records

```
# 1. Get a NIP-98 token
sign_nip98(
  url: "https://sb.otherstuff.studio/records/npub1abc.../fetch?delegate=true&collection=todos",
  method: "GET"
)

# 2. Use the returned Authorization header in your request
curl -H "Authorization: Nostr <base64-signed-event>" \
  "https://sb.otherstuff.studio/records/npub1abc.../fetch?delegate=true&collection=todos"
```

The `?delegate=true` parameter tells SuperBased to return records where the authenticated pubkey is listed as a delegate.

### Sync records

```
# 1. Get a NIP-98 token (POST requires body hash)
sign_nip98(
  url: "https://sb.otherstuff.studio/records/npub1abc.../sync",
  method: "POST",
  body_hash: "<sha256-hex-of-request-body>"
)

# 2. POST the records
curl -X POST \
  -H "Authorization: Nostr <base64-signed-event>" \
  -H "Content-Type: application/json" \
  -d '{ "records": [...] }' \
  "https://sb.otherstuff.studio/records/npub1abc.../sync"
```

**Note**: When using raw API calls, you must handle NIP-44 encryption/decryption yourself. The `encrypted_data` field is NIP-44 ciphertext (not plain JSON). Delegate copies are in the `delegate_payloads` map keyed by delegate hex pubkey.

---

## Field Guide

The decrypted payload contains a JSON object with these fields:

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

To add a tag, append to existing: `"work,urgent"` -> `"work,urgent,new-tag"`
To remove a tag, filter it out: `"work,urgent,old"` -> `"work,urgent"`
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

All operations follow this pattern:
1. Fetch the record with `superbased_fetch_records`
2. Parse `decrypted_payload` as JSON
3. Modify the fields you need
4. Update `updated_at` to current timestamp
5. Sync back with `superbased_sync_records`

### Mark a todo as in progress

Update the payload:
- `"state": "doing"`
- `"done": 0`
- `"updated_at": "{current timestamp}"`

### Mark a todo as complete

Update the payload:
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

### Delete a todo (soft delete)

- `"deleted": 1`
- `"updated_at": "{current timestamp}"`

---

## Record ID Format

The `record_id` follows this format:
```
todo_{16-character-hex-uuid}
```

Example: `todo_a1b2c3d4e5f67890`

**Important**: Use **underscores** (NOT hyphens): `todo_abc123` not `todo-abc123`.

When updating an existing todo, use the same `record_id` from the fetched record.

---

## Permission Model

| Permission | Can read tasks | Can update tasks |
|------------|---------------|-----------------|
| `read` | Yes | No |
| `write` | Yes | Yes |

Write permission implies read permission. If you attempt to sync a record you only have read access to, the server will reject the update.

Check `metadata.write_delegates` in the fetched record to confirm you have write access before attempting updates.

---

## Notes

- All data is **NIP-44 encrypted** - the Wingman MCP tools handle encryption/decryption automatically
- Always update `updated_at` when modifying any field
- Set `device_id` to `"agent"` in metadata to identify agent-modified records
- The `metadata.updated_at` should match the `updated_at` inside the payload
- Never modify `created_at` after initial creation
- Always include **all fields** in the payload when updating, not just changed ones
- Preserve `delegate_pubkeys` from the original record when syncing back

---

## Quick Reference: MCP Tools

| Operation | Tool | Key Parameters |
|-----------|------|---------------|
| Read tasks | `superbased_fetch_records` | `app_npub`, `collection` |
| Update tasks | `superbased_sync_records` | `app_npub`, `records` |
| Check API health | `superbased_health` | `base_url` (optional) |
| NIP-98 auth (raw) | `sign_nip98` | `url`, `method` |
| Decrypt messages | `nip44_decrypt` | `ciphertext`, `sender_pubkey` |
