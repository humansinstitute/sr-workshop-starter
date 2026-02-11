# Delegated Encrypted Record (DER) - Kind Specification

**Status:** Draft
**Context:** SuperBased encrypted storage with multi-recipient access

## Architecture

No middle server. The stack is:

```
Browser (Dexie/Alpine) ←→ SuperBased (storage + NIP-98 auth)
         ↕                        ↕
    Nostr Relays            Bot/Agent
```

- **Browser** holds encryption keys, talks to SuperBased directly with NIP-98
- **SuperBased** stores encrypted records, enforces envelope structure and authorization
- **Nostr relays** carry delegation manifests and real-time notifications
- **Bots/Agents** discover delegations via relays, query SuperBased directly with NIP-98

No proxy, no middleware, no secrets to hide server-side. NIP-98 handles auth, NIP-44 handles encryption, relays handle notifications.

## Problem

Encrypted records currently support a single owner. To enable bot integrations, shared access, and delegation, records need to be readable by multiple recipients without exposing keys server-side.

## Record Structure

```json
{
  "record_id": "todo-<uuid>",
  "collection": "todos",
  "metadata": {
    "id": "<uuid>",
    "owner": "<hex-pubkey>",
    "read_delegates": ["<hex-pubkey-bot-readonly>"],
    "write_delegates": ["<hex-pubkey-bot-readwrite>"],
    "created_at": "<ISO-8601>",
    "updated_at": "<ISO-8601>",
    "schema_version": 1
  },
  "encrypted_payload": "<NIP-44 encrypted blob, to owner pubkey>",
  "delegate_payloads": {
    "<hex-pubkey-bot-readonly>": "<NIP-44 encrypted blob>",
    "<hex-pubkey-bot-readwrite>": "<NIP-44 encrypted blob>"
  }
}
```

All delegate fields are optional. A record with no `read_delegates`, `write_delegates`, or `delegate_payloads` is valid — it's just an owner-only record, identical in behavior to v0.

### Fields

#### `metadata` (plaintext, queryable)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | UUID, unique per record |
| `owner` | hex string | yes | Nostr pubkey of the record owner |
| `read_delegates` | hex string[] | no | Pubkeys with read-only access |
| `write_delegates` | hex string[] | no | Pubkeys with read and write access |
| `created_at` | ISO-8601 | yes | Record creation timestamp |
| `updated_at` | ISO-8601 | yes | Last modification timestamp |
| `schema_version` | integer | yes | Record format version (currently `1`) |

#### `encrypted_payload` (opaque to server)

NIP-44 encrypted JSON blob. The plaintext content is encrypted **from the writer's secret key to the owner's pubkey**. Only the owner can decrypt.

For this app (todos), the plaintext is:

```json
{
  "title": "...",
  "description": "...",
  "priority": "sand|rock|water",
  "state": "new|active|done",
  "tags": "comma,separated",
  "scheduled_for": "<ISO-8601 | null>",
  "assigned_to": "<npub | null>",
  "done": 0,
  "deleted": 0
}
```

#### `delegate_payloads` (opaque to server)

Map of delegate hex pubkey → NIP-44 encrypted blob. Each entry contains the same plaintext as `encrypted_payload`, encrypted **to that delegate's pubkey**. Keyed by pubkey (not positional) so delegate order doesn't matter and lookups are direct.

Only present if the record has delegates. A delegate's pubkey appearing in `read_delegates` or `write_delegates` without a corresponding entry in `delegate_payloads` means they've been granted access but the blobs haven't been generated yet (error state, owner should re-encrypt).

## Operations

### Create (owner)

1. Owner constructs plaintext record
2. Encrypts to own pubkey → `encrypted_payload`
3. For each delegate pubkey, encrypts same plaintext → `delegate_payloads[pubkey]`
4. Sends to SuperBased with NIP-98 auth
5. (Optional) Updates delegation manifest on Nostr relays

### Read (owner)

1. Fetch record from SuperBased by `id` or `owner`
2. Decrypt `encrypted_payload` with own secret key

### Read (delegate)

1. Fetch records from SuperBased where own pubkey appears in `read_delegates` or `write_delegates`
2. Decrypt `delegate_payloads[own_pubkey]` with own secret key

### Update (owner)

1. Decrypt `encrypted_payload`
2. Modify plaintext
3. Re-encrypt to self + all delegates
4. Send full record update to SuperBased with NIP-98 auth

### Update (write delegate)

1. Decrypt `delegate_payloads[own_pubkey]`
2. Modify plaintext
3. Re-encrypt to owner + all delegates
4. Send full record update to SuperBased with NIP-98 auth
5. SuperBased validates: signer's pubkey is in `write_delegates`

### Update (read delegate)

Rejected by SuperBased. Read delegates cannot modify records.

### Add/Remove delegate (owner only)

1. Owner fetches and decrypts record
2. Adds/removes pubkey from `read_delegates` or `write_delegates`
3. Adds/removes corresponding entry in `delegate_payloads`
4. Re-encrypts to new set of recipients
5. Sends update to SuperBased
6. Updates delegation manifest on Nostr relays

## Delegate Discovery

Delegates learn about records assigned to them through two mechanisms:

### 1. Push: Nostr Delegation Manifest (Replaceable Event)

Each owner maintains a single replaceable event per delegate per app/superbased instance. When delegations change (add, remove, change access level), the owner publishes an updated version of the same event. The delegate subscribes once and always has the current manifest.

```
Kind: 30078 (replaceable parameterized, application-specific data)

d tag: "<app_tag>_<superbased_hex_pubkey>"
  e.g. "super-based-todo_ab12cd34..."

Tags:
  ["d", "<app_tag>_<superbased_hex_pubkey>"]
  ["p", "<delegate-hex-pubkey>"]
  ["t", "der-delegation"]

Content (NIP-44 encrypted to delegate pubkey):
{
  "superbased_pubkey": "<hex-pubkey of superbased instance>",
  "api_base_url": "https://superbased.example.com",
  "app": "super-based-todo",
  "delegated_by": "<owner hex-pubkey>",
  "updated_at": "<ISO-8601>",
  "records": [
    {
      "record_id": "<uuid>",
      "collection": "todos",
      "access": "read",
      "delegated_at": "<ISO-8601>"
    },
    {
      "record_id": "<uuid>",
      "collection": "todos",
      "access": "write",
      "delegated_at": "<ISO-8601>"
    }
  ]
}
```

**How it works:**

- `d` tag = `<app>_<superbased_pubkey>` scopes the event to one app on one SuperBased instance
- Being replaceable (kind 30078), each publish overwrites the previous — the delegate always sees the latest full list
- When a record is removed from delegation, the owner publishes without it — absence = revoked
- The delegate filters: `kinds: [30078], #p: [own_pubkey], #t: ["der-delegation"]`
- On receiving, decrypt content to get the full manifest of record IDs, access levels, and the SuperBased endpoint to fetch from

### 2. Pull: SuperBased Delegate Endpoint

SuperBased exposes an endpoint for delegates to query records assigned to them directly:

```
GET /api/v1/delegated?since=<ISO-8601>&collection=<optional>
Authorization: Nostr <NIP-98 token signed by delegate pubkey>
```

**Response:**
```json
{
  "records": [
    {
      "record_id": "todo-<uuid>",
      "collection": "todos",
      "metadata": { ... },
      "delegate_payloads": {
        "<delegate-pubkey>": "<encrypted blob>"
      },
      "updated_at": "<ISO-8601>"
    }
  ],
  "cursor": "<pagination token>"
}
```

SuperBased:
- Filters records where the NIP-98 signer's pubkey appears in `read_delegates` or `write_delegates`
- Only returns `delegate_payloads` entries for the requesting pubkey (not other delegates' blobs)
- Supports `since` for incremental sync (only records modified after the given timestamp)
- Does NOT return `encrypted_payload` (that's the owner's blob — delegates don't need it)

This is useful for:
- Bots querying "what's been delegated to me since last check?"
- Recovery if the Nostr push notification was missed
- Batch sync on startup
- Users providing a NIP-98 token on the bot's behalf for one-off queries

## SuperBased Authorization

| Action | Allowed signers |
|--------|----------------|
| Create | `owner` only |
| Read | `owner`, any pubkey in `read_delegates` or `write_delegates` |
| Update content | `owner`, any pubkey in `write_delegates` |
| Modify delegates | `owner` only |
| Delete | `owner` only |

- All calls authenticated via NIP-98 (Nostr HTTP Auth)
- SuperBased **never** has access to decryption keys
- SuperBased **can** enforce: valid metadata structure, authorized pubkeys, timestamp ordering, delegate permission level

## Encryption Details

- **Algorithm:** NIP-44 (ChaCha20 + HMAC-SHA256)
- **Key derivation:** NIP-44 conversation key (ECDH shared secret between sender and recipient)
- **Each blob is independently encrypted** — no shared symmetric key. Each recipient uses their own secret key + the sender's pubkey to derive the conversation key.

## Considerations

### Storage Cost

Each delegate adds ~equal storage to the base record. A record with 3 delegates stores 4x the encrypted data. Acceptable for small delegate counts (bots, devices); not designed for large groups.

### Update Races

When multiple writers (owner + write delegates) can update, last-write-wins based on `updated_at`. SuperBased should reject updates where the submitted `updated_at` is older than the stored value. Future work could add vector clocks or CRDTs.

### Delegate Key Rotation

If a delegate's key is compromised, the owner removes them from delegates and re-encrypts. Old blobs encrypted to the compromised key remain in server history — consider server-side record versioning with expiry.

### Relation to Nostr Kinds

This could be formalized as a replaceable parameterized Nostr event kind:

- **Kind 3xxxx** — the `d` tag would be the record ID
- Tags: `["p", "<pubkey>", "<relay>", "read"]` or `["p", "<pubkey>", "<relay>", "write"]` for delegates
- Content: JSON with `encrypted_payload` and `delegate_payloads`

The exact kind number and NIP should be proposed once the pattern is validated in this app.

## Migration Path

### Current format (v0)

```json
{
  "record_id": "todo-<id>",
  "collection": "todos",
  "encrypted_data": "{\"id\":...,\"owner\":...,\"payload\":...}"
}
```

### New format (v1)

Records with `schema_version: 1` and the structure above. SuperBased should support both formats during migration:

1. Records without `metadata.schema_version` are treated as v0
2. v0 records can be upgraded by the owner: decrypt, re-encrypt in v1 format
3. A v1 record with no delegate fields behaves identically to v0
4. Once all records are v1, v0 parsing can be dropped

## Workshop Deployment

For a workshop with N participants:

- **You run:** One SuperBased instance (storage + auth)
- **Participants run:** Local dev server (`bun dev`) serving the static app — they customize the UI/logic
- **Agents:** Talk to SuperBased directly via NIP-98, discover delegations via Nostr relays
- **No shared server needed** — each participant's browser holds their own keys, authenticates independently
