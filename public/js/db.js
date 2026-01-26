// Dexie database for todos with NIP-44 encryption
import Dexie from 'https://esm.sh/dexie@4.0.10';
import { encryptObject, decryptObject } from './nostr.js';

const db = new Dexie('TodoApp');

// Schema: id and owner are plaintext for querying, payload is encrypted
db.version(1).stores({
  todos: '++id, owner',
});

// Fields that are stored encrypted in the payload
const ENCRYPTED_FIELDS = ['title', 'description', 'priority', 'state', 'tags', 'scheduled_for', 'done', 'deleted', 'created_at'];

// Encrypt todo data before storage
async function encryptTodo(todo) {
  const { id, owner, ...sensitiveData } = todo;
  const encryptedPayload = await encryptObject(sensitiveData);
  return { id, owner, payload: encryptedPayload };
}

// Decrypt todo data after retrieval
async function decryptTodo(encryptedTodo) {
  if (!encryptedTodo || !encryptedTodo.payload) {
    return encryptedTodo;
  }
  try {
    const decryptedData = await decryptObject(encryptedTodo.payload);
    return { id: encryptedTodo.id, owner: encryptedTodo.owner, ...decryptedData };
  } catch (err) {
    console.error('Failed to decrypt todo:', err);
    // Return a placeholder if decryption fails
    return {
      id: encryptedTodo.id,
      owner: encryptedTodo.owner,
      title: '[Encrypted - unable to decrypt]',
      description: '',
      priority: 'sand',
      state: 'new',
      tags: '',
      scheduled_for: null,
      done: 0,
      deleted: 1, // Hide failed decryptions
      created_at: null,
    };
  }
}

// Decrypt multiple todos
async function decryptTodos(encryptedTodos) {
  return Promise.all(encryptedTodos.map(decryptTodo));
}

// CRUD operations

export async function createTodo({ title, description = '', priority = 'sand', owner, tags = '', scheduled_for = null }) {
  const now = new Date().toISOString();
  const todoData = {
    title,
    description,
    priority,
    state: 'new',
    owner,
    tags,
    scheduled_for,
    deleted: 0,
    done: 0,
    created_at: now,
  };

  const encryptedTodo = await encryptTodo(todoData);
  return db.todos.add(encryptedTodo);
}

export async function getTodosByOwner(owner, includeDeleted = false) {
  const encryptedTodos = await db.todos.where('owner').equals(owner).toArray();
  const todos = await decryptTodos(encryptedTodos);
  if (includeDeleted) return todos;
  return todos.filter(t => !t.deleted);
}

export async function getTodoById(id) {
  const encryptedTodo = await db.todos.get(id);
  if (!encryptedTodo) return null;
  return decryptTodo(encryptedTodo);
}

export async function updateTodo(id, updates) {
  // Get existing todo, decrypt, merge updates, re-encrypt
  const existingEncrypted = await db.todos.get(id);
  if (!existingEncrypted) throw new Error('Todo not found');

  const existing = await decryptTodo(existingEncrypted);

  // If state is being set to 'done', also set done flag
  if (updates.state === 'done') {
    updates.done = 1;
  } else if (updates.state && updates.state !== 'done') {
    updates.done = 0;
  }

  const updated = { ...existing, ...updates };
  const encryptedTodo = await encryptTodo(updated);

  return db.todos.put(encryptedTodo);
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
  const encryptedTodos = await Promise.all(todos.map(encryptTodo));
  return db.todos.bulkAdd(encryptedTodos);
}

export async function bulkUpdateTodos(todos) {
  const encryptedTodos = await Promise.all(todos.map(encryptTodo));
  return db.todos.bulkPut(encryptedTodos);
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
 * Parse SuperBased record back to local format
 */
function parseRemoteRecord(record) {
  try {
    const data = JSON.parse(record.encrypted_data);
    return {
      id: data.id,
      owner: data.owner,
      payload: data.payload,
      remote_id: record.id,
      record_id: record.record_id,
      updated_at: record.updated_at,
    };
  } catch {
    console.error('Failed to parse remote record:', record.record_id);
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
 * Returns { toImport, conflicts, skipped }
 */
export async function mergeRemoteRecords(owner, remoteRecords) {
  const localTodos = await db.todos.where('owner').equals(owner).toArray();

  // Build lookup maps
  const localById = new Map();
  const localByPayload = new Map();
  for (const todo of localTodos) {
    localById.set(todo.id, todo);
    localByPayload.set(todo.payload, todo);
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
      // Different payloads for same ID - conflict
      conflicts.push({
        remote: parsed,
        local: localMatch,
      });
      continue;
    }

    // New record - import it
    toImport.push(parsed);
  }

  return { toImport, conflicts, skipped };
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
