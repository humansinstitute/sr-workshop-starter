// Dexie database for todos (plaintext for workshop)
import Dexie from 'https://esm.sh/dexie@4.0.10';

// Use new database name to avoid primary key migration issues
// Old 'TodoApp' used auto-increment integers which caused sync collisions
const db = new Dexie('TodoAppV2');

// Schema: id (UUID string) and owner are plaintext for querying, payload is encrypted
db.version(1).stores({
  todos: 'id, owner',
});

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
function serializeTodo(todo) {
  const { id, owner, ...sensitiveData } = todo;
  return { id, owner, payload: JSON.stringify(sensitiveData) };
}

// Deserialize todo data after retrieval (plaintext for workshop)
function deserializeTodo(storedTodo) {
  if (!storedTodo || !storedTodo.payload) {
    return storedTodo;
  }

  let payload = storedTodo.payload;

  // First try to parse as-is
  try {
    const data = JSON.parse(payload);
    return { id: storedTodo.id, owner: storedTodo.owner, ...data };
  } catch (firstErr) {
    // Try sanitizing the payload and parsing again
    try {
      const sanitized = sanitizeJsonString(payload);
      const data = JSON.parse(sanitized);
      console.log('Sanitized and parsed todo:', storedTodo.id);
      return { id: storedTodo.id, owner: storedTodo.owner, ...data };
    } catch (secondErr) {
      console.error('Failed to parse todo even after sanitization:', storedTodo.id, secondErr.message);
      return {
        id: storedTodo.id,
        owner: storedTodo.owner,
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

export async function createTodo({ title, description = '', priority = 'sand', owner, tags = '', scheduled_for = null, assigned_to = null }) {
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

// Export db for direct access if needed
export { db };
