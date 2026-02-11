// Dexie database for todos (plaintext for workshop)
import Dexie from 'https://esm.sh/dexie@4.0.10';
import { encryptToSelf, decryptFromSelf, encryptToRecipient, decryptFromSender, getMemoryPubkey } from './nostr.js';

// Use new database name to avoid primary key migration issues
// Old 'TodoApp' used auto-increment integers which caused sync collisions
const db = new Dexie('TodoAppV2');

// Schema: id (UUID string) and owner are plaintext for querying, payload is encrypted
db.version(1).stores({
  todos: 'id, owner',
});

// DER schema version
export const CURRENT_SCHEMA_VERSION = 1;

// Device ID for tracking sync origin (shared with superbased.js)
const DEVICE_ID_KEY = 'superbased_device_id';
function getDeviceId() {
  let deviceId = localStorage.getItem(DEVICE_ID_KEY);
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, deviceId);
  }
  return deviceId;
}

// Generate a 16-character hex UUID
function generateTodoId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Fields that are stored encrypted in the payload
const ENCRYPTED_FIELDS = ['title', 'description', 'priority', 'state', 'tags', 'scheduled_for', 'done', 'deleted', 'created_at', 'updated_at', 'assigned_to'];

/**
 * Sanitize JSON string by escaping control characters
 * Fixes common issues from improperly escaped agent-written data
 */
function sanitizeJsonString(str) {
  if (!str || typeof str !== 'string') return str;

  // Replace literal control characters with their escape sequences
  return str
    // Replace literal newlines with \n
    .replace(/\r\n/g, '\\n')
    .replace(/\r/g, '\\n')
    .replace(/\n/g, '\\n')
    // Replace literal tabs with \t
    .replace(/\t/g, '\\t')
    // Remove other control characters (0x00-0x1F except those we've handled)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

// Serialize todo data before storage (plaintext for workshop)
// Delegate fields and schema_version are stored as top-level Dexie fields (not in payload)
function serializeTodo(todo) {
  const { id, owner, read_delegates, write_delegates, schema_version, ...sensitiveData } = todo;
  return {
    id,
    owner,
    payload: JSON.stringify(sensitiveData),
    schema_version: schema_version ?? CURRENT_SCHEMA_VERSION,
    read_delegates: read_delegates || [],
    write_delegates: write_delegates || [],
  };
}

// Deserialize todo data after retrieval (plaintext for workshop)
// Includes delegate fields and schema_version from top-level Dexie fields
function deserializeTodo(storedTodo) {
  if (!storedTodo || !storedTodo.payload) {
    return storedTodo;
  }

  let payload = storedTodo.payload;
  const delegateFields = {
    read_delegates: storedTodo.read_delegates || [],
    write_delegates: storedTodo.write_delegates || [],
    schema_version: storedTodo.schema_version || 0,
  };

  // First try to parse as-is
  try {
    const data = JSON.parse(payload);
    return { id: storedTodo.id, owner: storedTodo.owner, ...delegateFields, ...data };
  } catch (firstErr) {
    // Try sanitizing the payload and parsing again
    try {
      const sanitized = sanitizeJsonString(payload);
      const data = JSON.parse(sanitized);
      console.log('Sanitized and parsed todo:', storedTodo.id);
      return { id: storedTodo.id, owner: storedTodo.owner, ...delegateFields, ...data };
    } catch (secondErr) {
      console.error('Failed to parse todo even after sanitization:', storedTodo.id, secondErr.message);
      return {
        id: storedTodo.id,
        owner: storedTodo.owner,
        ...delegateFields,
        title: '[Parse error - invalid JSON]',
        description: '',
        priority: 'sand',
        state: 'new',
        tags: '',
        scheduled_for: null,
        done: 0,
        deleted: 1,
        created_at: null,
      };
    }
  }
}

// Deserialize multiple todos
function deserializeTodos(storedTodos) {
  return storedTodos.map(deserializeTodo);
}

// CRUD operations

export async function createTodo({ title, description = '', priority = 'sand', owner, tags = '', scheduled_for = null, assigned_to = null, read_delegates = [], write_delegates = [] }) {
  const now = new Date().toISOString();
  const id = generateTodoId(); // Use UUID instead of auto-increment

  const todoData = {
    id,
    title,
    description,
    priority,
    state: 'new',
    owner,
    tags,
    scheduled_for,
    assigned_to,
    deleted: 0,
    done: 0,
    created_at: now,
    updated_at: now,
    read_delegates,
    write_delegates,
    schema_version: CURRENT_SCHEMA_VERSION,
  };

  const serializedTodo = serializeTodo(todoData);
  return db.todos.put(serializedTodo); // Use put() since we're providing the ID
}

export async function getTodosByOwner(owner, includeDeleted = false) {
  const storedTodos = await db.todos.where('owner').equals(owner).toArray();
  const todos = deserializeTodos(storedTodos);
  if (includeDeleted) return todos;
  return todos.filter(t => !t.deleted);
}

export async function getTodoById(id) {
  const storedTodo = await db.todos.get(id);
  if (!storedTodo) return null;
  return deserializeTodo(storedTodo);
}

export async function updateTodo(id, updates) {
  // Get existing todo, deserialize, merge updates, re-serialize
  const existingStored = await db.todos.get(id);
  if (!existingStored) throw new Error('Todo not found');

  const existing = deserializeTodo(existingStored);

  // If state is being set to 'done', also set done flag
  if (updates.state === 'done') {
    updates.done = 1;
  } else if (updates.state && updates.state !== 'done') {
    updates.done = 0;
  }

  // Always set updated_at on every change
  const now = new Date().toISOString();
  const updated = { ...existing, ...updates, updated_at: now };
  const serializedTodo = serializeTodo(updated);

  // Preserve server_updated_at from original record (sync metadata)
  if (existingStored.server_updated_at) {
    serializedTodo.server_updated_at = existingStored.server_updated_at;
  }

  return db.todos.put(serializedTodo);
}

export async function deleteTodo(id, hard = false) {
  if (hard) {
    return db.todos.delete(id);
  }
  // Soft delete
  return updateTodo(id, { deleted: 1 });
}

export async function transitionTodoState(id, newState) {
  const updates = { state: newState };
  if (newState === 'done') {
    updates.done = 1;
  } else {
    updates.done = 0;
  }
  return updateTodo(id, updates);
}

// Bulk operations for future sync
export async function bulkCreateTodos(todos) {
  const serializedTodos = todos.map(serializeTodo);
  return db.todos.bulkAdd(serializedTodos);
}

export async function bulkUpdateTodos(todos) {
  const serializedTodos = todos.map(serializeTodo);
  return db.todos.bulkPut(serializedTodos);
}

export async function clearAllTodos(owner) {
  const todos = await db.todos.where('owner').equals(owner).toArray();
  const ids = todos.map(t => t.id);
  return db.todos.bulkDelete(ids);
}

// Export raw encrypted data (for sync)
export async function getEncryptedTodosByOwner(owner) {
  return db.todos.where('owner').equals(owner).toArray();
}

// Import raw encrypted data (from sync)
export async function importEncryptedTodos(encryptedTodos) {
  return db.todos.bulkPut(encryptedTodos);
}

// ===========================================
// SuperBased Sync Helpers
// ===========================================

/**
 * Format local encrypted todos for SuperBased sync
 * Maps Dexie structure to SuperBased record format
 */
export async function formatForSync(owner) {
  const encryptedTodos = await db.todos.where('owner').equals(owner).toArray();
  return formatEncryptedTodosForSync(encryptedTodos);
}

/**
 * Format specific encrypted todos for SuperBased sync
 */
export function formatEncryptedTodosForSync(encryptedTodos) {
  return encryptedTodos.map(todo => ({
    record_id: `todo-${todo.id}`,
    collection: 'todos',
    encrypted_data: JSON.stringify({
      id: todo.id,
      owner: todo.owner,
      payload: todo.payload,
    }),
    metadata: {
      local_id: todo.id,
    },
  }));
}

/**
 * Format todos by ID for upload
 */
export async function formatTodosByIdForSync(ids) {
  const todos = await db.todos.bulkGet(ids);
  return formatEncryptedTodosForSync(todos.filter(Boolean));
}

/**
 * Parse SuperBased record back to local format
 */
function parseRemoteRecord(record) {
  try {
    console.log('parseRemoteRecord: record_id:', record.record_id, 'has encrypted_data:', !!record.encrypted_data);
    const data = JSON.parse(record.encrypted_data);
    console.log('parseRemoteRecord: parsed data.id:', data.id);
    return {
      id: data.id,
      owner: data.owner,
      payload: data.payload,
      remote_id: record.id,
      record_id: record.record_id,
      updated_at: record.updated_at,
    };
  } catch (err) {
    console.error('Failed to parse remote record:', record.record_id, err.message);
    console.error('Record content:', JSON.stringify(record).slice(0, 200));
    return null;
  }
}

/**
 * Compare two encrypted payloads
 * Returns true if they are identical
 */
function payloadsMatch(payload1, payload2) {
  return payload1 === payload2;
}

/**
 * Merge remote records with local data
 * Cloud wins if newer - overwrites local with newer cloud records
 * Returns { toImport, conflicts, skipped }
 */
export async function mergeRemoteRecords(owner, remoteRecords) {
  console.log('mergeRemoteRecords: received', remoteRecords?.length || 0, 'remote records');

  const localStored = await db.todos.where('owner').equals(owner).toArray();
  const localDecrypted = deserializeTodos(localStored);
  console.log('mergeRemoteRecords: have', localDecrypted.length, 'local records');

  // Build lookup maps
  const localById = new Map();
  const localByPayload = new Map();
  for (const todo of localDecrypted) {
    localById.set(todo.id, todo);
    localByPayload.set(localStored.find(e => e.id === todo.id)?.payload, todo);
  }

  const toImport = [];
  const conflicts = [];
  const skipped = [];

  for (const remote of remoteRecords) {
    const parsed = parseRemoteRecord(remote);
    if (!parsed) continue;

    // Check if this exact payload already exists (duplicate)
    if (localByPayload.has(parsed.payload)) {
      skipped.push({
        remote: parsed,
        local: localByPayload.get(parsed.payload),
        reason: 'identical_payload',
      });
      continue;
    }

    // Check if we have a local record with the same ID
    const localMatch = localById.get(parsed.id);
    if (localMatch) {
      // Compare timestamps - cloud wins if newer
      const remoteTime = new Date(parsed.updated_at).getTime();
      const localTime = localMatch.updated_at ? new Date(localMatch.updated_at).getTime() : 0;

      if (remoteTime > localTime) {
        // Cloud is newer - import it (will overwrite local)
        toImport.push(parsed);
        console.log(`Cloud record ${parsed.id} is newer, will overwrite local`);
      } else {
        // Local is same or newer - skip
        skipped.push({
          remote: parsed,
          local: localMatch,
          reason: 'local_is_newer',
        });
      }
      continue;
    }

    // New record - import it
    console.log('mergeRemoteRecords: new record', parsed.id, 'will import');
    toImport.push(parsed);
  }

  // Find local record IDs that need to be pushed to cloud
  // (either newer than cloud, or not in cloud at all)
  const toUploadIds = [];
  const remoteIds = new Set(remoteRecords.map(r => {
    const parsed = parseRemoteRecord(r);
    return parsed?.id;
  }).filter(Boolean));

  for (const local of localDecrypted) {
    // Check if local record is missing from cloud entirely
    if (!remoteIds.has(local.id)) {
      toUploadIds.push(local.id);
      console.log('mergeRemoteRecords: local record', local.id, 'missing from cloud, will upload');
      continue;
    }

    // Check if local is newer (already in skipped with reason 'local_is_newer')
    const skippedEntry = skipped.find(s => s.local?.id === local.id && s.reason === 'local_is_newer');
    if (skippedEntry) {
      toUploadIds.push(local.id);
      console.log('mergeRemoteRecords: local record', local.id, 'is newer than cloud, will upload');
    }
  }

  console.log('mergeRemoteRecords: toImport:', toImport.length, 'toUploadIds:', toUploadIds.length, 'skipped:', skipped.length);

  return { toImport, toUploadIds, conflicts, skipped };
}

/**
 * Import parsed remote records (no conflict check)
 */
export async function importParsedRecords(records) {
  const toInsert = records.map(r => ({
    id: r.id,
    owner: r.owner,
    payload: r.payload,
  }));
  return db.todos.bulkPut(toInsert);
}

/**
 * Force import a single record, replacing local
 */
export async function forceImportRecord(record) {
  return db.todos.put({
    id: record.id,
    owner: record.owner,
    payload: record.payload,
  });
}

/**
 * Get last sync timestamp for incremental sync
 */
export function getLastSyncTime(owner) {
  const key = `superbased_last_sync_${owner}`;
  return localStorage.getItem(key);
}

/**
 * Set last sync timestamp
 */
export function setLastSyncTime(owner, timestamp) {
  const key = `superbased_last_sync_${owner}`;
  localStorage.setItem(key, timestamp);
}

// ===========================================
// DER (Delegated Encrypted Records) v1 Format
// ===========================================

/**
 * Format local todos into DER v1 wire format for SuperBased sync.
 * Encrypts payload to owner (NIP-44) and to each delegate.
 * @param {Array} storedTodos - Raw Dexie records (with payload as plaintext JSON)
 * @returns {Array} v1 wire format records ready for SuperBased
 */
export async function formatTodosForDER(storedTodos) {
  const deviceId = getDeviceId();
  const results = [];

  for (const todo of storedTodos) {
    // Parse payload to get updated_at for metadata
    let payloadData = {};
    try {
      payloadData = JSON.parse(todo.payload);
    } catch { /* ignore */ }

    // Encrypt payload to owner (self) using NIP-44
    const encrypted_data = await encryptToSelf(todo.payload);

    // Encrypt to each delegate
    const delegate_payloads = {};
    const allDelegates = new Set([
      ...(todo.read_delegates || []),
      ...(todo.write_delegates || []),
    ]);

    for (const delegatePubkey of allDelegates) {
      try {
        delegate_payloads[delegatePubkey] = await encryptToRecipient(todo.payload, delegatePubkey);
      } catch (err) {
        console.error(`DER: Failed to encrypt to delegate ${delegatePubkey.slice(0, 8)}:`, err.message);
      }
    }

    const record = {
      record_id: `todo_${todo.id}`,
      collection: 'todos',
      encrypted_data,
      metadata: {
        local_id: todo.id,
        owner: todo.owner,
        read_delegates: todo.read_delegates || [],
        write_delegates: todo.write_delegates || [],
        updated_at: payloadData.updated_at || payloadData.created_at || new Date().toISOString(),
        device_id: deviceId,
        schema_version: CURRENT_SCHEMA_VERSION,
      },
    };

    if (Object.keys(delegate_payloads).length > 0) {
      record.delegate_payloads = delegate_payloads;
    }

    results.push(record);
  }

  return results;
}

/**
 * Parse a SuperBased record back to local format.
 * Handles both v0 (legacy) and v1 (DER) formats.
 * For v1: decrypts encrypted_payload (owner) or delegate_payloads (delegate).
 * For v0: parses encrypted_data as JSON (no NIP-44).
 * @returns {Object|null} { id, owner, payload, record_id, updated_at, read_delegates, write_delegates, schema_version, device_id }
 */
export async function parseDERRecord(record) {
  const schemaVersion = record.metadata?.schema_version || 0;

  if (schemaVersion >= 1 && record.encrypted_data) {
    // v1 DER format — decrypt
    try {
      const myPubkey = getMemoryPubkey();
      let decryptedPayload;

      // Try decrypt as owner first
      try {
        decryptedPayload = await decryptFromSelf(record.encrypted_data);
      } catch (ownerErr) {
        // Not the owner — try as delegate
        if (myPubkey && record.delegate_payloads?.[myPubkey]) {
          // Need owner pubkey to derive conversation key
          const ownerPubkey = record.metadata?.owner;
          if (!ownerPubkey) throw new Error('No owner pubkey in metadata');
          decryptedPayload = await decryptFromSender(
            record.delegate_payloads[myPubkey],
            ownerPubkey
          );
        } else {
          throw new Error('Cannot decrypt: not owner or delegate');
        }
      }

      return {
        id: record.metadata?.local_id || extractIdFromRecordId(record.record_id),
        owner: record.metadata?.owner,
        payload: decryptedPayload,
        record_id: record.record_id,
        updated_at: record.updated_at,
        read_delegates: record.metadata?.read_delegates || [],
        write_delegates: record.metadata?.write_delegates || [],
        schema_version: schemaVersion,
        device_id: record.metadata?.device_id,
      };
    } catch (err) {
      console.error('Failed to parse DER v1 record:', record.record_id, err.message);
      return null;
    }
  }

  // v0 fallback — legacy format (no encryption, JSON in encrypted_data)
  return parseRemoteRecordV0(record);
}

/**
 * Extract todo ID from record_id format "todo_<id>"
 */
function extractIdFromRecordId(recordId) {
  const match = recordId?.match(/^todo_([a-f0-9]+)$/i);
  return match ? match[1] : null;
}

/**
 * v0 legacy record parser (plain JSON in encrypted_data)
 * Returns same shape as parseDERRecord for consistency
 */
function parseRemoteRecordV0(record) {
  try {
    const data = JSON.parse(record.encrypted_data);
    return {
      id: data.id,
      owner: data.owner,
      payload: data.payload,
      record_id: record.record_id,
      updated_at: record.updated_at,
      read_delegates: [],
      write_delegates: [],
      schema_version: 0,
      device_id: record.metadata?.device_id,
    };
  } catch (err) {
    console.error('Failed to parse v0 record:', record.record_id, err.message);
    return null;
  }
}

// ===========================================
// Per-Record Delegate Management
// ===========================================

/**
 * Add a delegate to a todo record
 * @param {string} id - Todo ID
 * @param {string} pubkeyHex - Delegate's hex pubkey
 * @param {string} permission - 'read' or 'write'
 */
export async function addDelegateToTodo(id, pubkeyHex, permission = 'read') {
  const storedTodo = await db.todos.get(id);
  if (!storedTodo) throw new Error('Todo not found');

  const readDelegates = storedTodo.read_delegates || [];
  const writeDelegates = storedTodo.write_delegates || [];

  if (permission === 'write') {
    if (!writeDelegates.includes(pubkeyHex)) {
      writeDelegates.push(pubkeyHex);
    }
    // Write implies read — add to read_delegates too
    if (!readDelegates.includes(pubkeyHex)) {
      readDelegates.push(pubkeyHex);
    }
  } else {
    if (!readDelegates.includes(pubkeyHex)) {
      readDelegates.push(pubkeyHex);
    }
  }

  // Update via updateTodo to bump updated_at
  return updateTodo(id, { read_delegates: readDelegates, write_delegates: writeDelegates });
}

/**
 * Remove a delegate from a todo record (both read and write)
 * @param {string} id - Todo ID
 * @param {string} pubkeyHex - Delegate's hex pubkey
 */
export async function removeDelegateFromTodo(id, pubkeyHex) {
  const storedTodo = await db.todos.get(id);
  if (!storedTodo) throw new Error('Todo not found');

  const readDelegates = (storedTodo.read_delegates || []).filter(p => p !== pubkeyHex);
  const writeDelegates = (storedTodo.write_delegates || []).filter(p => p !== pubkeyHex);

  return updateTodo(id, { read_delegates: readDelegates, write_delegates: writeDelegates });
}

/**
 * Get delegates for a todo record
 * @param {string} id - Todo ID
 * @returns {{ read_delegates: string[], write_delegates: string[] }}
 */
export async function getTodoDelegates(id) {
  const storedTodo = await db.todos.get(id);
  if (!storedTodo) throw new Error('Todo not found');
  return {
    read_delegates: storedTodo.read_delegates || [],
    write_delegates: storedTodo.write_delegates || [],
  };
}

/**
 * Lazy migration: tag v0 records with v1 schema and empty delegate arrays.
 * Called on first loadTodos after login.
 */
export async function migrateToV1(owner) {
  const storedTodos = await db.todos.where('owner').equals(owner).toArray();
  let migrated = 0;

  for (const todo of storedTodos) {
    if (todo.schema_version === undefined || todo.schema_version === null || todo.schema_version < 1) {
      await db.todos.update(todo.id, {
        schema_version: CURRENT_SCHEMA_VERSION,
        read_delegates: todo.read_delegates || [],
        write_delegates: todo.write_delegates || [],
      });
      migrated++;
    }
  }

  if (migrated > 0) {
    console.log(`DER: Migrated ${migrated} v0 records to v1 schema`);
  }
  return migrated;
}

// Export db for direct access if needed
export { db };
