// Dexie database for todos — v3 (append-only versioned records)
import Dexie from 'https://esm.sh/dexie@4.0.10';
import { encryptToSelf, decryptFromSelf, encryptToRecipient, decryptFromSender, getMemoryPubkey } from './nostr.js';

// Clean break — new DB name, no migration from v1/v2
const db = new Dexie('TodoAppV3');

db.version(1).stores({
  todos: 'record_id, owner',
});

// Fields that are stored encrypted in the payload
const ENCRYPTED_FIELDS = ['title', 'description', 'priority', 'state', 'tags', 'scheduled_for', 'done', 'deleted', 'created_at', 'updated_at', 'assigned_to'];

/**
 * Sanitize JSON string by escaping control characters.
 * Fixes common issues from improperly escaped agent-written data.
 */
function sanitizeJsonString(str) {
  if (!str || typeof str !== 'string') return str;
  return str
    .replace(/\r\n/g, '\\n')
    .replace(/\r/g, '\\n')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

// ===========================
// Serialize / Deserialize
// ===========================

/**
 * Serialize a todo object for Dexie storage.
 * Sensitive fields go into `payload` JSON string.
 */
function serializeTodo(todo) {
  const { record_id, owner, version, pending, ...sensitiveData } = todo;
  return {
    record_id,
    owner,
    payload: JSON.stringify(sensitiveData),
    version: version ?? 0,
    pending: pending ?? true,
  };
}

/**
 * Deserialize a stored Dexie row back to a todo object.
 */
function deserializeTodo(storedTodo) {
  if (!storedTodo || !storedTodo.payload) return storedTodo;

  let payload = storedTodo.payload;

  // Try parse as-is first
  try {
    const data = JSON.parse(payload);
    return { record_id: storedTodo.record_id, owner: storedTodo.owner, ...data };
  } catch {
    // Try sanitizing
    try {
      const sanitized = sanitizeJsonString(payload);
      const data = JSON.parse(sanitized);
      return { record_id: storedTodo.record_id, owner: storedTodo.owner, ...data };
    } catch {
      console.error('Failed to parse todo even after sanitization:', storedTodo.record_id);
      return {
        record_id: storedTodo.record_id,
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

function deserializeTodos(storedTodos) {
  return storedTodos.map(deserializeTodo);
}

// ===========================
// CRUD Operations
// ===========================

export async function createTodo({ title, description = '', priority = 'sand', owner, tags = '', scheduled_for = null, assigned_to = null }) {
  const now = new Date().toISOString();
  const record_id = crypto.randomUUID();

  const todoData = {
    record_id,
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
    version: 0,
    pending: true,
  };

  const serialized = serializeTodo(todoData);
  return db.todos.put(serialized);
}

export async function getTodosByOwner(owner, includeDeleted = false) {
  const storedTodos = await db.todos.where('owner').equals(owner).toArray();
  const todos = deserializeTodos(storedTodos);
  // Only include actual todos (no _collection, or explicitly 'todos')
  const filtered = todos.filter(t => !t._collection || t._collection === 'todos');
  if (includeDeleted) return filtered;
  return filtered.filter(t => !t.deleted);
}

export async function getTodoById(record_id) {
  const storedTodo = await db.todos.get(record_id);
  if (!storedTodo) return null;
  return deserializeTodo(storedTodo);
}

export async function updateTodo(record_id, updates) {
  const existingStored = await db.todos.get(record_id);
  if (!existingStored) throw new Error('Todo not found');

  const existing = deserializeTodo(existingStored);

  // If state is being set to 'done', also set done flag
  if (updates.state === 'done') {
    updates.done = 1;
  } else if (updates.state && updates.state !== 'done') {
    updates.done = 0;
  }

  const now = new Date().toISOString();
  const updated = { ...existing, ...updates, updated_at: now, version: existingStored.version, pending: true };
  const serialized = serializeTodo(updated);
  return db.todos.put(serialized);
}

export async function deleteTodo(record_id, hard = false) {
  if (hard) {
    return db.todos.delete(record_id);
  }
  // Soft delete — marks pending so sync pushes the delete
  return updateTodo(record_id, { deleted: 1 });
}

export async function transitionTodoState(record_id, newState) {
  const updates = { state: newState };
  if (newState === 'done') {
    updates.done = 1;
  } else {
    updates.done = 0;
  }
  return updateTodo(record_id, updates);
}

// Bulk operations
export async function bulkCreateTodos(todos) {
  const serialized = todos.map(serializeTodo);
  return db.todos.bulkAdd(serialized);
}

export async function bulkUpdateTodos(todos) {
  const serialized = todos.map(serializeTodo);
  return db.todos.bulkPut(serialized);
}

export async function clearAllTodos(owner) {
  const todos = await db.todos.where('owner').equals(owner).toArray();
  const ids = todos.map(t => t.record_id);
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

// Convenience: get todos with pending local changes
export async function getPendingTodos(owner) {
  return db.todos.where('owner').equals(owner).filter(t => t.pending === true).toArray();
}

// ===========================
// V3 Sync Helpers
// ===========================

/**
 * Format local stored todos into v3 wire format for SuperBased sync.
 * Encrypts payload to self (NIP-44) and to each delegate.
 * Sets `encrypted_from` to our pubkey so the server (and delegates) know
 * which key to use for decryption.
 *
 * @param {Array} storedTodos - Raw Dexie rows (with payload as plaintext JSON)
 * @param {string[]} delegatePubkeys - App-level delegate hex pubkeys to encrypt to
 * @returns {Array} v3 wire format records for SuperBased sync
 */
export async function formatForV3Sync(storedTodos, delegatePubkeys = []) {
  const myPubkey = getMemoryPubkey();
  const results = [];

  for (const todo of storedTodos) {
    // Encrypt payload to self
    const encrypted_data = await encryptToSelf(todo.payload);

    // Encrypt to each app-level delegate
    const delegate_payloads = {};
    for (const delegatePubkey of delegatePubkeys) {
      try {
        delegate_payloads[delegatePubkey] = await encryptToRecipient(todo.payload, delegatePubkey);
      } catch (err) {
        console.error(`v3 sync: Failed to encrypt to delegate ${delegatePubkey.slice(0, 8)}:`, err.message);
      }
    }

    const record = {
      record_id: todo.record_id,
      collection: 'todos',
      encrypted_data,
      encrypted_from: myPubkey,
    };

    if (Object.keys(delegate_payloads).length > 0) {
      record.delegate_payloads = delegate_payloads;
    }

    results.push(record);
  }

  return results;
}

/**
 * Parse a v3 server record back to local format.
 * Uses `encrypted_from` to determine which NIP-44 conversation key to use.
 *
 * @param {Object} record - Server record with encrypted_data, encrypted_from, version, etc.
 * @returns {{ payload: string }|null} Decrypted record or null on failure
 */
export async function parseV3Record(record) {
  try {
    const myPubkey = getMemoryPubkey();
    const encryptedFrom = record.encrypted_from;
    let decryptedPayload;

    if (encryptedFrom && encryptedFrom !== myPubkey) {
      // Someone else encrypted this (e.g. a delegate/agent wrote it)
      // Decrypt using their pubkey as the conversation partner
      try {
        decryptedPayload = await decryptFromSender(record.encrypted_data, encryptedFrom);
      } catch {
        // Try our delegate_payload if available
        if (myPubkey && record.delegate_payloads?.[myPubkey]) {
          decryptedPayload = await decryptFromSender(record.delegate_payloads[myPubkey], encryptedFrom);
        } else {
          throw new Error('Cannot decrypt: encrypted_from differs and no delegate payload');
        }
      }
    } else {
      // We encrypted it ourselves — self-decrypt
      try {
        decryptedPayload = await decryptFromSelf(record.encrypted_data);
      } catch {
        // Not the owner — try as delegate
        if (myPubkey && record.delegate_payloads?.[myPubkey]) {
          const ownerPubkey = encryptedFrom;
          if (!ownerPubkey) throw new Error('No encrypted_from for delegate decrypt');
          decryptedPayload = await decryptFromSender(record.delegate_payloads[myPubkey], ownerPubkey);
        } else {
          throw new Error('Cannot decrypt: not owner or delegate');
        }
      }
    }

    // Sanitize agent-written payloads
    let payload = decryptedPayload;
    try {
      JSON.parse(payload);
    } catch {
      payload = sanitizeJsonString(payload);
    }

    return { payload };
  } catch (err) {
    console.error('Failed to parse v3 record:', record.record_id, err.message);
    return null;
  }
}

// ===========================
// AI Reviews (read-only from client)
// ===========================

const AI_REVIEW_ENCRYPTED_FIELDS = ['title', 'description', 'review_type', 'date', 'created_at', 'updated_at', '_collection'];

/**
 * Deserialize a stored Dexie row as an ai_review.
 * Returns null if the record is not an ai_review.
 */
function deserializeAiReview(storedRow) {
  if (!storedRow || !storedRow.payload) return null;
  const deserialized = deserializeTodo(storedRow);
  if (!deserialized || deserialized._collection !== 'ai_reviews') return null;
  return deserialized;
}

/**
 * Get all ai_reviews for an owner from the shared todos table.
 */
export async function getAiReviewsByOwner(owner) {
  const all = await db.todos.where('owner').equals(owner).toArray();
  return all.map(deserializeAiReview).filter(Boolean);
}

/**
 * Format ai_review records for v3 sync (not typically needed — agent writes these).
 * Included for completeness.
 */
export async function formatAiReviewsForV3Sync(storedRows, delegatePubkeys = []) {
  const { encryptToSelf, encryptToRecipient, getMemoryPubkey } = await import('./nostr.js');
  const myPubkey = getMemoryPubkey();
  const results = [];

  for (const row of storedRows) {
    const encrypted_data = await encryptToSelf(row.payload);
    const delegate_payloads = {};
    for (const dp of delegatePubkeys) {
      try {
        delegate_payloads[dp] = await encryptToRecipient(row.payload, dp);
      } catch (err) {
        console.error(`ai_review sync: encrypt to delegate ${dp.slice(0, 8)} failed:`, err.message);
      }
    }

    const record = {
      record_id: row.record_id,
      collection: 'ai_reviews',
      encrypted_data,
      encrypted_from: myPubkey,
    };
    if (Object.keys(delegate_payloads).length > 0) {
      record.delegate_payloads = delegate_payloads;
    }
    results.push(record);
  }
  return results;
}

/**
 * Format ALL local records for delegate re-encryption sync.
 * Used after delegate changes to push updated delegate_payloads for every record.
 * Filters out soft-deleted records (no point re-encrypting those).
 *
 * @param {string} ownerNpub - Owner npub to query records for
 * @param {string[]} delegatePubkeys - Current delegate hex pubkeys
 * @returns {Array} v3 wire format records for SuperBased sync
 */
export async function formatAllForDelegateSync(ownerNpub, delegatePubkeys = []) {
  const allTodos = await db.todos.where('owner').equals(ownerNpub).toArray();
  // Filter out soft-deleted records
  const liveTodos = allTodos.filter(t => {
    try { return JSON.parse(t.payload).deleted !== 1; } catch { return true; }
  });
  return formatForV3Sync(liveTodos, delegatePubkeys);
}

// Export db for direct access
export { db };
