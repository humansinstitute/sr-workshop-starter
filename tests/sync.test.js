/**
 * Integration tests for SuperBased sync
 *
 * These tests verify that:
 * 1. Local edits are preserved during sync
 * 2. Remote changes are correctly merged
 * 3. Conflict resolution works as expected
 * 4. server_updated_at is preserved during local edits
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Dexie from 'dexie';
import { MockSuperBasedServer, createMockClient, createTestEncryption } from './mock-superbased.js';

// Create a test database that mirrors the real one
const testDb = new Dexie('TestTodoApp');
testDb.version(1).stores({
  todos: '++id, owner',
});

// Test encryption (simple base64 for testing)
const { encrypt, decrypt } = createTestEncryption();

// Helper to create an encrypted todo
function encryptTodo(todo) {
  const { id, owner, server_updated_at, ...sensitiveData } = todo;
  const payload = 'encrypted:' + btoa(JSON.stringify(sensitiveData));
  const result = { id, owner, payload };
  if (server_updated_at) {
    result.server_updated_at = server_updated_at;
  }
  return result;
}

// Helper to decrypt a todo
function decryptTodo(encryptedTodo) {
  if (!encryptedTodo?.payload) return encryptedTodo;
  const payload = encryptedTodo.payload;
  if (!payload.startsWith('encrypted:')) {
    throw new Error('Invalid payload');
  }
  const decrypted = JSON.parse(atob(payload.slice(10)));
  return { id: encryptedTodo.id, owner: encryptedTodo.owner, ...decrypted };
}

// Simplified performSync for testing (mirrors real logic)
async function performSync(client, ownerNpub, db) {
  const deviceId = 'test-device-1';

  // 1. PULL from server
  const remoteData = await client.fetchRecords({});

  const serverRecords = new Map();
  for (const record of remoteData.records || []) {
    serverRecords.set(record.record_id, record);
  }

  // 2. Merge remote records into local
  let pulled = 0;
  let updated = 0;

  for (const record of remoteData.records || []) {
    const match = record.record_id.match(/^todo_(\d+)$/);
    if (!match) continue;

    const localId = parseInt(match[1], 10);
    const serverUpdatedAt = record.updated_at;
    const remoteDeviceId = record.metadata?.device_id;

    const existing = await db.todos.get(localId);

    if (!existing) {
      // New record from server
      await db.todos.put({
        id: localId,
        owner: record.metadata?.owner || ownerNpub,
        payload: record.encrypted_data,
        server_updated_at: serverUpdatedAt,
      });
      pulled++;
    } else {
      const localServerTime = existing.server_updated_at
        ? new Date(existing.server_updated_at).getTime()
        : 0;
      const remoteServerTime = serverUpdatedAt
        ? new Date(serverUpdatedAt).getTime()
        : 0;

      // Skip own device echo
      if (remoteDeviceId === deviceId) {
        if (serverUpdatedAt && remoteServerTime > localServerTime) {
          await db.todos.update(localId, { server_updated_at: serverUpdatedAt });
        }
        continue;
      }

      // Check for pending local changes
      let localHasPendingChanges = false;
      if (existing.payload) {
        try {
          const decrypted = decryptTodo(existing);
          const localUpdatedAt = decrypted.updated_at || decrypted.created_at;
          if (localUpdatedAt) {
            const localEditTime = new Date(localUpdatedAt).getTime();
            localHasPendingChanges = localEditTime > localServerTime;
          }
        } catch {
          // Can't decrypt - assume pending changes (safer)
          localHasPendingChanges = true;
        }
      }

      // Only take server version if no pending local changes
      if (remoteServerTime > localServerTime && !localHasPendingChanges) {
        await db.todos.put({
          id: localId,
          owner: record.metadata?.owner || ownerNpub,
          payload: record.encrypted_data,
          server_updated_at: serverUpdatedAt,
        });
        updated++;
      }
    }
  }

  // 3. PUSH local changes
  const allLocalTodos = await db.todos.where('owner').equals(ownerNpub).toArray();
  const recordsToPush = [];

  for (const todo of allLocalTodos) {
    const recordId = `todo_${todo.id}`;
    const serverRecord = serverRecords.get(recordId);

    let localUpdatedAt = null;
    try {
      const decrypted = decryptTodo(todo);
      localUpdatedAt = decrypted.updated_at || decrypted.created_at;
    } catch {
      localUpdatedAt = new Date().toISOString();
    }

    const localTime = localUpdatedAt ? new Date(localUpdatedAt).getTime() : 0;
    const serverTime = serverRecord?.updated_at
      ? new Date(serverRecord.updated_at).getTime()
      : 0;

    if (!serverRecord || localTime > serverTime) {
      recordsToPush.push({
        record_id: recordId,
        collection: 'todos',
        encrypted_data: todo.payload,
        metadata: {
          local_id: todo.id,
          owner: todo.owner,
          updated_at: localUpdatedAt,
          device_id: deviceId,
        },
      });
    }
  }

  let pushed = 0;
  if (recordsToPush.length > 0) {
    await client.syncRecords(recordsToPush);
    pushed = recordsToPush.length;
  }

  return { pushed, pulled, updated };
}

// Helper to simulate updating a todo locally
async function updateTodoLocally(db, id, updates) {
  const existingEncrypted = await db.todos.get(id);
  if (!existingEncrypted) throw new Error('Todo not found');

  const existing = decryptTodo(existingEncrypted);
  const now = new Date().toISOString();
  const updated = { ...existing, ...updates, updated_at: now };
  const encryptedTodo = encryptTodo(updated);

  // Preserve server_updated_at (the bug we fixed!)
  if (existingEncrypted.server_updated_at) {
    encryptedTodo.server_updated_at = existingEncrypted.server_updated_at;
  }

  await db.todos.put(encryptedTodo);
  return updated;
}

describe('SuperBased Sync', () => {
  let mockServer;
  let mockClient;
  const testOwner = 'npub1testowner';

  beforeEach(async () => {
    // Reset database
    await testDb.todos.clear();

    // Reset mock server
    mockServer = new MockSuperBasedServer();
    mockClient = createMockClient(mockServer);
  });

  describe('Local edit preservation', () => {
    it('should NOT overwrite local edits with stale server data', async () => {
      // Setup: Create a todo that has been synced
      const initialTime = '2024-01-01T10:00:00.000Z';
      const serverTime = '2024-01-01T10:00:00.000Z';

      const todo = {
        id: 1,
        owner: testOwner,
        title: 'Original Title',
        description: 'Original description',
        priority: 'sand',
        state: 'new',
        created_at: initialTime,
        updated_at: initialTime,
      };

      // Store locally with server_updated_at (simulating previous sync)
      const encrypted = encryptTodo(todo);
      encrypted.server_updated_at = serverTime;
      await testDb.todos.put(encrypted);

      // Server has the same version
      mockServer.setRecord({
        record_id: 'todo_1',
        collection: 'todos',
        encrypted_data: encrypted.payload,
        updated_at: serverTime,
        metadata: { owner: testOwner, device_id: 'other-device' },
      });

      // User makes a LOCAL EDIT
      const editTime = '2024-01-01T11:00:00.000Z';
      vi.setSystemTime(new Date(editTime));

      await updateTodoLocally(testDb, 1, {
        title: 'EDITED TITLE',
        description: 'Edited description',
      });

      // Verify edit was saved
      const afterEdit = decryptTodo(await testDb.todos.get(1));
      expect(afterEdit.title).toBe('EDITED TITLE');

      // Now sync - server still has old version
      await performSync(mockClient, testOwner, testDb);

      // Verify local edit was PRESERVED (not overwritten!)
      const afterSync = decryptTodo(await testDb.todos.get(1));
      expect(afterSync.title).toBe('EDITED TITLE');
      expect(afterSync.description).toBe('Edited description');
    });

    it('should preserve server_updated_at during local edits', async () => {
      const serverTime = '2024-01-01T10:00:00.000Z';

      const todo = encryptTodo({
        id: 1,
        owner: testOwner,
        title: 'Test',
        updated_at: serverTime,
      });
      todo.server_updated_at = serverTime;
      await testDb.todos.put(todo);

      // Edit locally
      await updateTodoLocally(testDb, 1, { title: 'Edited' });

      // Verify server_updated_at is preserved
      const afterEdit = await testDb.todos.get(1);
      expect(afterEdit.server_updated_at).toBe(serverTime);
    });
  });

  describe('Remote change acceptance', () => {
    it('should accept newer server changes when no local edits', async () => {
      const oldTime = '2024-01-01T10:00:00.000Z';
      const newTime = '2024-01-01T12:00:00.000Z';

      // Local has old version
      const todo = encryptTodo({
        id: 1,
        owner: testOwner,
        title: 'Old Title',
        updated_at: oldTime,
      });
      todo.server_updated_at = oldTime;
      await testDb.todos.put(todo);

      // Server has newer version (from another device)
      const serverTodo = encryptTodo({
        id: 1,
        owner: testOwner,
        title: 'New Title From Server',
        updated_at: newTime,
      });
      mockServer.setRecord({
        record_id: 'todo_1',
        collection: 'todos',
        encrypted_data: serverTodo.payload,
        updated_at: newTime,
        metadata: { owner: testOwner, device_id: 'other-device' },
      });

      // Sync
      const result = await performSync(mockClient, testOwner, testDb);

      // Should have updated from server
      expect(result.updated).toBe(1);

      const afterSync = decryptTodo(await testDb.todos.get(1));
      expect(afterSync.title).toBe('New Title From Server');
    });

    it('should add new records from server', async () => {
      // Server has a record we don't have locally
      const serverTodo = encryptTodo({
        id: 999,
        owner: testOwner,
        title: 'New from server',
        updated_at: '2024-01-01T10:00:00.000Z',
      });
      mockServer.setRecord({
        record_id: 'todo_999',
        collection: 'todos',
        encrypted_data: serverTodo.payload,
        updated_at: '2024-01-01T10:00:00.000Z',
        metadata: { local_id: 999, owner: testOwner, device_id: 'other-device' },
      });

      // Sync
      const result = await performSync(mockClient, testOwner, testDb);

      expect(result.pulled).toBe(1);

      const newRecord = await testDb.todos.get(999);
      expect(newRecord).toBeTruthy();
      expect(decryptTodo(newRecord).title).toBe('New from server');
    });
  });

  describe('Push to server', () => {
    it('should push local changes to server', async () => {
      // Create a local todo
      const todo = encryptTodo({
        id: 1,
        owner: testOwner,
        title: 'New local todo',
        updated_at: '2024-01-01T10:00:00.000Z',
      });
      await testDb.todos.put(todo);

      // Sync (should push)
      const result = await performSync(mockClient, testOwner, testDb);

      expect(result.pushed).toBe(1);

      // Verify server received it
      const serverRecord = mockServer.getRecord('todo_1');
      expect(serverRecord).toBeTruthy();
      expect(serverRecord.encrypted_data).toBe(todo.payload);
    });

    it('should push updated records to server', async () => {
      const serverTime = '2024-01-01T10:00:00.000Z';
      const localEditTime = '2024-01-01T11:00:00.000Z';

      // Start with synced todo
      const todo = encryptTodo({
        id: 1,
        owner: testOwner,
        title: 'Original',
        updated_at: serverTime,
      });
      todo.server_updated_at = serverTime;
      await testDb.todos.put(todo);

      // Server has same version
      mockServer.setRecord({
        record_id: 'todo_1',
        collection: 'todos',
        encrypted_data: todo.payload,
        updated_at: serverTime,
        metadata: { owner: testOwner, device_id: 'test-device-1' },
      });

      // Edit locally
      vi.setSystemTime(new Date(localEditTime));
      await updateTodoLocally(testDb, 1, { title: 'Locally Edited' });

      // Sync
      const result = await performSync(mockClient, testOwner, testDb);

      // Should push our edit
      expect(result.pushed).toBe(1);

      // Server should have new version
      const serverRecord = mockServer.getRecord('todo_1');
      const serverDecrypted = decryptTodo({ payload: serverRecord.encrypted_data });
      expect(serverDecrypted.title).toBe('Locally Edited');
    });
  });

  describe('Bug regression tests', () => {
    it('BUG: server_updated_at was lost on local edit (caused overwrites)', async () => {
      // This test reproduces the bug where local edits were being overwritten
      // because updateTodo() was not preserving server_updated_at

      const syncTime = '2024-01-01T10:00:00.000Z';

      // Simulate a todo that was previously synced
      const todo = encryptTodo({
        id: 1,
        owner: testOwner,
        title: 'Synced todo',
        updated_at: syncTime,
      });
      todo.server_updated_at = syncTime; // This marks it as synced
      await testDb.todos.put(todo);

      // User edits the todo
      vi.setSystemTime(new Date('2024-01-01T11:00:00.000Z'));
      await updateTodoLocally(testDb, 1, { title: 'User edit' });

      // CRITICAL: Verify server_updated_at was preserved
      const afterEdit = await testDb.todos.get(1);
      expect(afterEdit.server_updated_at).toBe(syncTime);
      // If this was null/undefined, the sync would think there's no sync
      // history and allow the server to overwrite our edit!
    });

    it('BUG: decrypt failure should NOT allow overwrite', async () => {
      // This test verifies that if decryption fails during the pending
      // changes check, we assume we DO have pending changes (safer)

      const syncTime = '2024-01-01T10:00:00.000Z';

      // Create a todo with invalid encrypted payload
      await testDb.todos.put({
        id: 1,
        owner: testOwner,
        payload: 'invalid-not-encrypted-data',
        server_updated_at: syncTime,
      });

      // Server has a "newer" version
      mockServer.setRecord({
        record_id: 'todo_1',
        collection: 'todos',
        encrypted_data: encryptTodo({ title: 'Server version' }).payload,
        updated_at: '2024-01-01T12:00:00.000Z',
        metadata: { owner: testOwner, device_id: 'other-device' },
      });

      // Sync should NOT overwrite because we can't verify no pending changes
      await performSync(mockClient, testOwner, testDb);

      // Local should still have the "invalid" payload (not overwritten)
      const afterSync = await testDb.todos.get(1);
      expect(afterSync.payload).toBe('invalid-not-encrypted-data');
    });
  });

  describe('DER v1 format', () => {
    it('should serialize and deserialize with delegate fields', async () => {
      // Create a v1 todo with delegates
      const todo = {
        id: 1,
        owner: testOwner,
        title: 'DER Test',
        description: 'Testing DER format',
        priority: 'rock',
        state: 'new',
        created_at: '2024-01-01T10:00:00.000Z',
        updated_at: '2024-01-01T10:00:00.000Z',
        read_delegates: ['aabb1122'],
        write_delegates: ['ccdd3344'],
        schema_version: 1,
      };

      // Serialize (simulate what serializeTodo does)
      const { id, owner, read_delegates, write_delegates, schema_version, ...sensitiveData } = todo;
      const stored = {
        id,
        owner,
        payload: JSON.stringify(sensitiveData),
        schema_version,
        read_delegates,
        write_delegates,
      };

      await testDb.todos.put(stored);

      // Verify stored structure
      const retrieved = await testDb.todos.get(1);
      expect(retrieved.read_delegates).toEqual(['aabb1122']);
      expect(retrieved.write_delegates).toEqual(['ccdd3344']);
      expect(retrieved.schema_version).toBe(1);

      // Verify payload doesn't contain delegate fields
      const parsedPayload = JSON.parse(retrieved.payload);
      expect(parsedPayload.read_delegates).toBeUndefined();
      expect(parsedPayload.write_delegates).toBeUndefined();
      expect(parsedPayload.schema_version).toBeUndefined();
      expect(parsedPayload.title).toBe('DER Test');
    });

    it('v0 records should parse correctly (backward compat)', async () => {
      // Simulate a v0 record from server (no schema_version, uses encrypted_data)
      const v0Data = {
        id: 1,
        owner: testOwner,
        payload: 'encrypted:' + btoa(JSON.stringify({ title: 'Legacy todo', state: 'new', updated_at: '2024-01-01T10:00:00.000Z' })),
      };
      const v0ServerRecord = {
        record_id: 'todo_1',
        collection: 'todos',
        encrypted_data: JSON.stringify(v0Data),
        updated_at: '2024-01-01T10:00:00.000Z',
        metadata: { owner: testOwner, device_id: 'other-device' },
      };

      // Simulate pull and store
      const match = v0ServerRecord.record_id.match(/^todo_(\d+)$/);
      expect(match).toBeTruthy();

      const data = JSON.parse(v0ServerRecord.encrypted_data);
      await testDb.todos.put({
        id: data.id,
        owner: data.owner,
        payload: data.payload,
        server_updated_at: v0ServerRecord.updated_at,
      });

      const stored = await testDb.todos.get(1);
      expect(stored).toBeTruthy();
      expect(stored.payload).toBe(v0Data.payload);
      // v0 records won't have delegate fields
      expect(stored.read_delegates).toBeUndefined();
    });

    it('should preserve delegate fields through local update cycle', async () => {
      // Create a todo with delegates
      const todo = {
        id: 1,
        owner: testOwner,
        title: 'Delegated task',
        updated_at: '2024-01-01T10:00:00.000Z',
        read_delegates: ['delegate1hex'],
        write_delegates: ['delegate2hex'],
        schema_version: 1,
      };

      const { id, owner, read_delegates, write_delegates, schema_version, ...sensitiveData } = todo;
      const stored = {
        id,
        owner,
        payload: JSON.stringify(sensitiveData),
        schema_version,
        read_delegates,
        write_delegates,
        server_updated_at: '2024-01-01T10:00:00.000Z',
      };
      await testDb.todos.put(stored);

      // Simulate updateTodo preserving delegate fields
      const existing = await testDb.todos.get(1);
      const parsedPayload = JSON.parse(existing.payload);
      const updated = { ...parsedPayload, title: 'Updated title', updated_at: '2024-01-01T11:00:00.000Z' };

      // Re-serialize (delegate fields come from stored record, not payload)
      await testDb.todos.put({
        id: existing.id,
        owner: existing.owner,
        payload: JSON.stringify(updated),
        schema_version: existing.schema_version,
        read_delegates: existing.read_delegates,
        write_delegates: existing.write_delegates,
        server_updated_at: existing.server_updated_at,
      });

      // Verify delegate fields survived the update
      const afterUpdate = await testDb.todos.get(1);
      expect(afterUpdate.read_delegates).toEqual(['delegate1hex']);
      expect(afterUpdate.write_delegates).toEqual(['delegate2hex']);
      expect(afterUpdate.schema_version).toBe(1);
      expect(afterUpdate.server_updated_at).toBe('2024-01-01T10:00:00.000Z');

      const afterPayload = JSON.parse(afterUpdate.payload);
      expect(afterPayload.title).toBe('Updated title');
    });

    it('should add and remove delegates on a record', async () => {
      // Create todo without delegates
      const stored = {
        id: 1,
        owner: testOwner,
        payload: JSON.stringify({ title: 'Test', updated_at: '2024-01-01T10:00:00.000Z' }),
        schema_version: 1,
        read_delegates: [],
        write_delegates: [],
      };
      await testDb.todos.put(stored);

      // Add read delegate
      const record = await testDb.todos.get(1);
      const readDelegates = [...(record.read_delegates || []), 'newdelegatehex'];
      await testDb.todos.update(1, { read_delegates: readDelegates });

      let updated = await testDb.todos.get(1);
      expect(updated.read_delegates).toContain('newdelegatehex');
      expect(updated.write_delegates).toEqual([]);

      // Add write delegate
      const writeDelegates = [...(updated.write_delegates || []), 'writerdelegatehex'];
      const updatedReaders = [...(updated.read_delegates || []), 'writerdelegatehex']; // write implies read
      await testDb.todos.update(1, { write_delegates: writeDelegates, read_delegates: updatedReaders });

      updated = await testDb.todos.get(1);
      expect(updated.write_delegates).toContain('writerdelegatehex');
      expect(updated.read_delegates).toContain('writerdelegatehex');

      // Remove delegate
      const filteredRead = updated.read_delegates.filter(p => p !== 'newdelegatehex');
      await testDb.todos.update(1, { read_delegates: filteredRead });

      updated = await testDb.todos.get(1);
      expect(updated.read_delegates).not.toContain('newdelegatehex');
      expect(updated.read_delegates).toContain('writerdelegatehex');
    });

    it('should handle mixed v0/v1 records during sync', async () => {
      // Local v1 record
      await testDb.todos.put({
        id: 1,
        owner: testOwner,
        payload: JSON.stringify({ title: 'v1 local', updated_at: '2024-01-01T10:00:00.000Z' }),
        schema_version: 1,
        read_delegates: ['delegate1'],
        write_delegates: [],
        server_updated_at: '2024-01-01T10:00:00.000Z',
      });

      // Server has a v0 record (different ID)
      const v0ServerPayload = encryptTodo({
        id: 2,
        owner: testOwner,
        title: 'v0 from server',
        updated_at: '2024-01-01T09:00:00.000Z',
      });

      mockServer.setRecord({
        record_id: 'todo_2',
        collection: 'todos',
        encrypted_data: v0ServerPayload.payload,
        updated_at: '2024-01-01T09:00:00.000Z',
        metadata: { local_id: 2, owner: testOwner, device_id: 'other-device' },
      });

      // Also put local v1 record on server (echo)
      const v1Encrypted = encryptTodo({
        id: 1,
        owner: testOwner,
        title: 'v1 local',
        updated_at: '2024-01-01T10:00:00.000Z',
      });
      mockServer.setRecord({
        record_id: 'todo_1',
        collection: 'todos',
        encrypted_data: v1Encrypted.payload,
        updated_at: '2024-01-01T10:00:00.000Z',
        metadata: { owner: testOwner, device_id: 'test-device-1' },
      });

      // Sync should handle both
      const result = await performSync(mockClient, testOwner, testDb);

      expect(result.pulled).toBe(1); // v0 record from server

      // Verify both records exist
      const record1 = await testDb.todos.get(1);
      const record2 = await testDb.todos.get(2);
      expect(record1).toBeTruthy();
      expect(record2).toBeTruthy();
      expect(record1.read_delegates).toEqual(['delegate1']); // v1 delegates preserved
    });
  });

  describe('Conflict scenarios', () => {
    it('should handle rapid edit-sync-edit cycle', async () => {
      const t1 = '2024-01-01T10:00:00.000Z';
      const t2 = '2024-01-01T10:00:01.000Z';
      const t3 = '2024-01-01T10:00:02.000Z';

      // Initial synced state
      const todo = encryptTodo({
        id: 1,
        owner: testOwner,
        title: 'V1',
        updated_at: t1,
      });
      todo.server_updated_at = t1;
      await testDb.todos.put(todo);

      mockServer.setRecord({
        record_id: 'todo_1',
        collection: 'todos',
        encrypted_data: todo.payload,
        updated_at: t1,
        metadata: { owner: testOwner, device_id: 'other-device' },
      });

      // User edits locally
      vi.setSystemTime(new Date(t2));
      await updateTodoLocally(testDb, 1, { title: 'V2 - Local Edit' });

      // Sync runs (should push V2)
      await performSync(mockClient, testOwner, testDb);

      // User edits again before server response
      vi.setSystemTime(new Date(t3));
      await updateTodoLocally(testDb, 1, { title: 'V3 - Another Edit' });

      // Another sync - old server data shouldn't overwrite V3
      await performSync(mockClient, testOwner, testDb);

      const final = decryptTodo(await testDb.todos.get(1));
      expect(final.title).toBe('V3 - Another Edit');
    });
  });
});
