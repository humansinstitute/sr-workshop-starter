// Dexie database for todos with NIP-44 encryption
import Dexie from 'https://esm.sh/dexie@4.0.10';
import { encryptObject, decryptObject } from './nostr.js';

const db = new Dexie('TodoApp');

// Schema: id and owner are plaintext for querying, payload is encrypted
db.version(1).stores({
  todos: '++id, owner',
});

// Fields that are stored encrypted in the payload
const ENCRYPTED_FIELDS = ['title', 'description', 'priority', 'state', 'tags', 'scheduled_for', 'done', 'deleted', 'created_at', 'updated_at'];

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
    updated_at: now,
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

  // Always set updated_at on every change
  const now = new Date().toISOString();
  const updated = { ...existing, ...updates, updated_at: now };
  const encryptedTodo = await encryptTodo(updated);

  // Preserve server_updated_at from original record (sync metadata)
  if (existingEncrypted.server_updated_at) {
    encryptedTodo.server_updated_at = existingEncrypted.server_updated_at;
  }

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

// Export db for direct access if needed
export { db };
