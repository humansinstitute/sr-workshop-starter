# Agent API Documentation

API for AI agents with delegated access to read and update todos via SuperBased.

---

## Connecting

The app provides an **Agent Connect JSON** when the user clicks "Agent Connect". Copy the JSON and paste it into your agent session. It contains everything the agent needs.

### Agent Connect JSON format

```json
{
  "agentConnectGuide": "https://example.com/agentconnect.md",
  "superbasedURL": "https://sb.otherstuff.studio",
  "appNpub": "npub1abc...",
  "appPubkey": "a1c51007...",
  "ownerPubkey": "934b9c5b5d2cbca3c21b9d18da7cac94b61bf0cf57756531d08f6818227c77ce",
  "ownerNpub": "npub1owner..."
}
```

### Field mapping to MCP tools

| Agent Connect field | MCP tool parameter | Format | Usage |
|--------------------|--------------------|--------|-------|
| `appNpub` | `app_npub` | npub (bech32) | Pass directly - already in the correct format |
| `appPubkey` | — | 64-char hex | Hex version of appNpub, for APIs that need hex format |
| `superbasedURL` | `base_url` | URL string | Pass directly to all SuperBased MCP calls |
| `ownerPubkey` | `owner_pubkey` | 64-char hex | **Required** for both fetch and sync — scopes records to this owner |
| `ownerNpub` | metadata `owner` | npub (bech32) | Include in record metadata |

**All values are ready to use as-is.** No format conversion needed.

---

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

## Reading Delegated Tasks

Use the `superbased_fetch_records` MCP tool. It automatically:
- Authenticates via NIP-98
- Fetches records where Wingman is a delegate
- Decrypts each record's `delegate_payloads` entry using NIP-44

### Example

```
superbased_fetch_records(
  app_npub: "<appNpub from Agent Connect JSON>",
  owner_pubkey: "<ownerPubkey from Agent Connect JSON>",
  base_url: "<superbasedURL from Agent Connect JSON>",
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

## Creating & Updating Tasks

Use the `superbased_sync_records` MCP tool. It automatically:
- Encrypts the plaintext payload to the owner, all delegates, and Wingman
- Authenticates via NIP-98
- Syncs the record to SuperBased

### CRITICAL: Preserve Existing Field Values

When updating a task, you **must** send back ALL fields with their current values. Only change the fields you intend to modify. **Do not guess or use defaults for fields you are not changing.**

The correct workflow is:

1. **Fetch** the current record via `superbased_fetch_records`
2. **Parse** the `decrypted_payload` JSON
3. **Copy every field exactly as-is** into your updated payload
4. **Only modify the specific fields** relevant to your change
5. **Update `updated_at`** to the current timestamp
6. **Sync** the modified payload back

**Fields agents commonly clobber by mistake:**

| Field | Valid values | What goes wrong |
|-------|-------------|-----------------|
| `state` | `new`, `ready`, `in_progress`, `review`, `done` | Agent resets to `"new"` or `"ready"` when it should keep the current value |
| `priority` | `sand`, `stone`, `iron`, `gold` | Agent resets to `"sand"` (default) instead of keeping the user's chosen priority |
| `tags` | Comma-separated string | Agent sends `""` and wipes existing tags |
| `assigned_to` | Hex pubkey or `null` | Agent sends `null` and unassigns the task |
| `scheduled_for` | ISO8601 string or `null` | Agent sends `null` and removes the due date |

**Example of what NOT to do:** If a task has `"priority": "gold"` and `"state": "in_progress"`, and you only want to update the `title`, do NOT send `"priority": "sand"` and `"state": "new"`. Copy the existing `"priority": "gold"` and `"state": "in_progress"` exactly.

### Example: Create a new task

```
superbased_sync_records(
  app_npub: "<appNpub from Agent Connect JSON>",
  base_url: "<superbasedURL from Agent Connect JSON>",
  records: [
    {
      "record_id": "todo_a1b2c3d4e5f67890",
      "plaintext_payload": "{\"title\":\"New task from agent\",\"description\":\"\",\"priority\":\"sand\",\"state\":\"new\",\"tags\":\"\",\"scheduled_for\":null,\"assigned_to\":null,\"done\":0,\"deleted\":0,\"created_at\":\"2024-01-15T14:30:00.000Z\",\"updated_at\":\"2024-01-15T14:30:00.000Z\"}",
      "owner_pubkey": "<ownerPubkey from Agent Connect JSON>",
      "collection": "todos",
      "delegate_pubkeys": ["<copy from existing record metadata.read_delegates>"],
      "metadata": {
        "local_id": "a1b2c3d4e5f67890",
        "owner": "<ownerNpub from Agent Connect JSON>",
        "updated_at": "2024-01-15T14:30:00.000Z",
        "device_id": "agent",
        "schema_version": 1
      }
    }
  ]
)
```

### Example: Update an existing task

**Always fetch first, then modify only what you need.** Every field in the payload below must come from the fetched record — only `state`, `done`, and `updated_at` are changed in this example. All other fields (`title`, `description`, `priority`, `tags`, `scheduled_for`, `assigned_to`, `created_at`) are preserved exactly from the original:

```
superbased_sync_records(
  app_npub: "<appNpub from Agent Connect JSON>",
  base_url: "<superbasedURL from Agent Connect JSON>",
  records: [
    {
      "record_id": "todo_a1b2c3d4e5f67890",
      "plaintext_payload": "{\"title\":\"Buy groceries\",\"description\":\"Milk and eggs\",\"priority\":\"stone\",\"state\":\"done\",\"tags\":\"shopping\",\"scheduled_for\":null,\"assigned_to\":\"934b9c...\",\"done\":1,\"deleted\":0,\"created_at\":\"2024-01-15T14:30:00.000Z\",\"updated_at\":\"2024-01-16T09:00:00.000Z\"}",
      "owner_pubkey": "<ownerPubkey from Agent Connect JSON>",
      "collection": "todos",
      "delegate_pubkeys": ["<copy from existing record metadata.read_delegates>"],
      "metadata": {
        "local_id": "a1b2c3d4e5f67890",
        "owner": "<ownerNpub from Agent Connect JSON>",
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

### Required fields for every sync

| Field | Required | Notes |
|-------|----------|-------|
| `record_id` | **YES** | Format: `todo_{16-char-hex}`. Generate one for new records, reuse existing for updates. |
| `plaintext_payload` | **YES** | JSON string with **all** todo fields (not just changed ones) |
| `owner_pubkey` | **YES** | Hex pubkey from Agent Connect JSON `ownerPubkey` |
| `collection` | **YES** | Always specify explicitly. Use `"todos"` — omitting defaults to `"default"` and moves the record out of its original collection. |
| `delegate_pubkeys` | Recommended | Copy from existing record's `metadata.read_delegates` |
| `metadata` | Recommended | Include `device_id: "agent"`, `schema_version: 1`, `updated_at` |

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
| `ready` | Ready to start | Triaged and ready for work |
| `in_progress` | In progress | User has started working on it |
| `review` | Ready for review | Work complete, needs verification |
| `done` | Completed | Task is finished |

To change status:
```json
"state": "in_progress"
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

---

## Deep Links to Tasks

Users (or other agents) may share a direct link to a specific task in the format:

```
https://<domain>/?todo=4010bc5a34508299
```

The `todo` query parameter is the **local hex ID** of the task. To work with this task via SuperBased, prefix it with `todo_` to get the `record_id`:

```
URL param:   ?todo=4010bc5a34508299
record_id:   todo_4010bc5a34508299
```

### Processing a deep-linked task

1. Extract the ID from the URL: `4010bc5a34508299`
2. Fetch the record using its `record_id`:

```
superbased_fetch_records(
  app_npub: "<appNpub>",
  owner_pubkey: "<ownerPubkey>",
  base_url: "<superbasedURL>",
  collection: "todos"
)
```

3. Find the record where `record_id` equals `todo_4010bc5a34508299` in the response
4. Parse `decrypted_payload` as JSON to read the task fields
5. To update it, sync back using the same `record_id`:

```
superbased_sync_records(
  app_npub: "<appNpub>",
  base_url: "<superbasedURL>",
  records: [
    {
      "record_id": "todo_4010bc5a34508299",
      "plaintext_payload": "<updated JSON>",
      "owner_pubkey": "<ownerPubkey>",
      "collection": "todos",
      "delegate_pubkeys": ["<from original record>"]
    }
  ]
)
```

**Note**: You must have delegate access to the record to read or update it. If the record isn't in your fetch results, you haven't been granted access.

---

## Common Operations

All update operations **must** follow this pattern — never skip step 1:

1. **Fetch** the record with `superbased_fetch_records`
2. **Parse** `decrypted_payload` as JSON
3. **Copy all fields as-is**, then modify only the fields you need to change
4. **Update** `updated_at` to current timestamp
5. **Sync back** with `superbased_sync_records` (include unchanged fields too)

### Mark a todo as in progress

Update the payload:
- `"state": "in_progress"`
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
todo_{16-character-hex}
```

Example: `todo_a1b2c3d4e5f67890`

**Important**: Use **underscores** (NOT hyphens): `todo_abc123` not `todo-abc123`.

When creating a new todo, generate a random 16-character hex string for the ID.
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
- Always include **all fields** in the payload when updating, not just changed ones — **copy every field value from the fetched record**, then change only what you need
- **Never substitute default values** (e.g. `"sand"`, `"new"`, `""`, `null`) for fields you haven't read from the current record
- Preserve `delegate_pubkeys` from the original record when syncing back

---

## AI Reviews (`ai_reviews` Collection)

Agents can write **review and summary records** that display as cards in the app above the todo list. These are stored in the `ai_reviews` collection on SuperBased and synced to the client automatically.

### Data Model

The encrypted payload must include a `_collection` discriminator field:

```json
{
  "_collection": "ai_reviews",
  "title": "Short one-line takeaway",
  "description": "Markdown description with **bold**, *italic*, lists, etc.",
  "review_type": "daily",
  "date": "2026-02-14",
  "created_at": "2026-02-14T08:00:00.000Z",
  "updated_at": "2026-02-14T08:00:00.000Z"
}
```

### Field Reference

| Field | Required | Valid Values | Notes |
|-------|----------|-------------|-------|
| `_collection` | **YES** | `"ai_reviews"` | Must be exactly this string — used to distinguish from todos in the shared Dexie table |
| `title` | **YES** | Any string | Short summary shown as card heading |
| `description` | **YES** | Markdown string | Rendered as HTML in the app. Supports **bold**, *italic*, `code`, lists, links |
| `review_type` | **YES** | `"daily"` or `"weekly"` | Displayed as a badge on the card |
| `date` | **YES** | `YYYY-MM-DD` | The date the review covers. Used for sorting (newest first) |
| `created_at` | **YES** | ISO8601 UTC | When the review was first written |
| `updated_at` | **YES** | ISO8601 UTC | Must update on every change |

### Creating an AI Review

```
superbased_sync_records(
  app_npub: "<appNpub from Agent Connect JSON>",
  base_url: "<superbasedURL from Agent Connect JSON>",
  owner_pubkey: "<ownerPubkey from Agent Connect JSON>",
  records: [
    {
      "plaintext_payload": "{\"_collection\":\"ai_reviews\",\"title\":\"Good momentum today\",\"description\":\"You completed **3 tasks** and moved 2 more to in-progress.\\n\\n- Finished the API refactor\\n- Closed 2 bug reports\\n- Started the auth migration\",\"review_type\":\"daily\",\"date\":\"2026-02-14\",\"created_at\":\"2026-02-14T20:00:00.000Z\",\"updated_at\":\"2026-02-14T20:00:00.000Z\"}",
      "collection": "ai_reviews",
      "delegate_pubkeys": ["<wingman delegate pubkey>"]
    }
  ]
)
```

### Important Notes

- **Always set `collection: "ai_reviews"`** in the sync call — this scopes the record on SuperBased. Omitting it defaults to `"default"` and the app will never see it.
- **Always include `"_collection": "ai_reviews"`** inside the payload — this is how the client-side Dexie DB distinguishes reviews from todos in the shared table.
- **Include `delegate_pubkeys`** so Wingman can decrypt the record on future fetches.
- **`record_id` is auto-generated** if omitted. To update an existing review, pass the same `record_id`.
- The app sorts reviews by `date` descending and displays them in a paging card. Users see the newest review first and can page through older ones.
- Markdown in `description` is rendered via snarkdown — basic markdown (bold, italic, code, links, lists) is supported. HTML `<script>` tags are stripped.

### Reading AI Reviews

To fetch existing reviews (e.g. to check what's already been written):

```
superbased_fetch_records(
  app_npub: "<appNpub from Agent Connect JSON>",
  owner_pubkey: "<ownerPubkey from Agent Connect JSON>",
  base_url: "<superbasedURL from Agent Connect JSON>",
  collection: "ai_reviews"
)
```

### Workflow: Writing a Daily Review

1. Fetch todos via `superbased_fetch_records` with `collection: "todos"`
2. Analyze the tasks — completions, state changes, priorities, patterns
3. Optionally fetch existing `ai_reviews` to avoid duplicating today's review
4. Write a review record via `superbased_sync_records` with `collection: "ai_reviews"`
5. The app picks up the review on its next sync cycle (every 3 seconds)

---

## Quick Reference: MCP Tools

| Operation | Tool | Key Parameters |
|-----------|------|---------------|
| Read tasks | `superbased_fetch_records` | `app_npub`, `owner_pubkey`, `base_url`, `collection: "todos"` |
| Create/Update tasks | `superbased_sync_records` | `app_npub`, `base_url`, `records` (with `collection: "todos"`) |
| Read AI reviews | `superbased_fetch_records` | `app_npub`, `owner_pubkey`, `base_url`, `collection: "ai_reviews"` |
| Write AI reviews | `superbased_sync_records` | `app_npub`, `base_url`, `records` (with `collection: "ai_reviews"`) |
| Check API health | `superbased_health` | `base_url` (optional) |
| NIP-98 auth (raw) | `sign_nip98` | `url`, `method` |
| Decrypt messages | `nip44_decrypt` | `ciphertext`, `sender_pubkey` |
