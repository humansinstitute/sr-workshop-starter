// SuperBased Sync Client
// Handles authenticated sync with flux_adaptor server

import { loadNostrLibs, getMemorySecret, getMemoryPubkey, bytesToHex, hexToBytes, decryptObject } from './nostr.js';
import { getEncryptedTodosByOwner, importEncryptedTodos, db } from './db.js';

// Device ID for tracking sync origin
const DEVICE_ID_KEY = 'superbased_device_id';

function getDeviceId() {
  let deviceId = localStorage.getItem(DEVICE_ID_KEY);
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, deviceId);
  }
  return deviceId;
}

/**
 * Parse a SuperBased token (base64-encoded Nostr event)
 */
export function parseToken(tokenBase64) {
  try {
    const eventJson = atob(tokenBase64);
    const event = JSON.parse(eventJson);

    // Extract attestation
    const attestationTag = event.tags.find(t => t[0] === 'attestation');

    return {
      rawEvent: event,
      isValid: !!attestationTag,
      serverPubkeyHex: event.pubkey,
      serverNpub: event.tags.find(t => t[0] === 'server')?.[1],
      appNpub: event.tags.find(t => t[0] === 'app')?.[1],
      relayUrl: event.tags.find(t => t[0] === 'relay')?.[1],
      httpUrl: event.tags.find(t => t[0] === 'http')?.[1],
    };
  } catch (err) {
    console.error('Token parse error:', err);
    return { isValid: false };
  }
}

/**
 * Create NIP-98 HTTP Auth header
 */
async function createNip98Auth(url, method, body = null) {
  const { pure, nip19 } = await loadNostrLibs();
  const secret = getMemorySecret();
  const memPubkey = getMemoryPubkey();

  if (!secret) {
    // For extension users
    if (window.nostr?.signEvent) {
      // Use memory pubkey if available, avoid getPublicKey() prompt
      const pubkey = memPubkey || await window.nostr.getPublicKey();

      const tags = [
        ['u', url],
        ['method', method],
      ];

      // Add payload hash for POST/PUT/PATCH
      if (body && ['POST', 'PUT', 'PATCH'].includes(method)) {
        const encoder = new TextEncoder();
        const data = encoder.encode(body);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashHex = Array.from(new Uint8Array(hashBuffer))
          .map(b => b.toString(16).padStart(2, '0'))
          .join('');
        tags.push(['payload', hashHex]);
      }

      const event = {
        kind: 27235,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: '',
        pubkey,
      };

      const signedEvent = await window.nostr.signEvent(event);
      return `Nostr ${btoa(JSON.stringify(signedEvent))}`;
    }
    throw new Error('No signing key available');
  }

  // For ephemeral/secret users
  const tags = [
    ['u', url],
    ['method', method],
  ];

  if (body && ['POST', 'PUT', 'PATCH'].includes(method)) {
    const encoder = new TextEncoder();
    const data = encoder.encode(body);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashHex = Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    tags.push(['payload', hashHex]);
  }

  const event = pure.finalizeEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: '',
  }, secret);

  return `Nostr ${btoa(JSON.stringify(event))}`;
}

/**
 * SuperBased Sync Client
 */
export class SuperBasedClient {
  constructor(token) {
    this.config = parseToken(token);
    this.token = token;

    if (!this.config.isValid) {
      throw new Error('Invalid SuperBased token');
    }

    if (!this.config.httpUrl) {
      throw new Error('Token missing HTTP URL');
    }

    // Remove trailing slash from httpUrl to avoid double slashes
    this.baseUrl = this.config.httpUrl.replace(/\/+$/, '');
  }

  /**
   * Make authenticated HTTP request
   */
  async request(path, method = 'GET', body = null) {
    const url = `${this.baseUrl}${path}`;
    const bodyStr = body ? JSON.stringify(body) : null;

    const auth = await createNip98Auth(url, method, bodyStr);

    const headers = {
      'Authorization': auth,
    };

    if (bodyStr) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(url, {
      method,
      headers,
      body: bodyStr,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.json();
  }

  /**
   * Test connection / get whoami (with timeout)
   */
  async whoami() {
    return this.requestWithTimeout('/auth/me', 'GET', null, 10000);
  }

  /**
   * Request with timeout wrapper
   */
  async requestWithTimeout(path, method = 'GET', body = null, timeoutMs = 30000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const url = `${this.baseUrl}${path}`;
      const bodyStr = body ? JSON.stringify(body) : null;
      const auth = await createNip98Auth(url, method, bodyStr);

      const headers = { 'Authorization': auth };
      if (bodyStr) {
        headers['Content-Type'] = 'application/json';
      }

      const response = await fetch(url, {
        method,
        headers,
        body: bodyStr,
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(error.error || `HTTP ${response.status}`);
      }

      return response.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Sync local todos to server
   */
  async syncRecords(records) {
    return this.request(`/records/${this.config.appNpub}/sync`, 'POST', { records });
  }

  /**
   * Fetch records from server
   */
  async fetchRecords(options = {}) {
    const params = new URLSearchParams();
    if (options.collection) params.set('collection', options.collection);
    if (options.since) params.set('since', options.since);

    const queryString = params.toString();
    const path = `/records/${this.config.appNpub}/fetch${queryString ? '?' + queryString : ''}`;

    return this.request(path, 'GET');
  }
}

/**
 * Convert local todos to sync format
 * Each todo becomes a record with encrypted_data being the payload
 * Includes updated_at and device_id in metadata for conflict resolution
 */
export async function todosToSyncRecords(ownerNpub) {
  // Get raw encrypted todos from DB
  const encryptedTodos = await getEncryptedTodosByOwner(ownerNpub);
  const deviceId = getDeviceId();

  // Decrypt each to get updated_at for metadata
  const records = [];
  for (const todo of encryptedTodos) {
    let updatedAt = null;
    try {
      const decrypted = await decryptObject(todo.payload);
      updatedAt = decrypted.updated_at || decrypted.created_at || new Date().toISOString();
    } catch {
      updatedAt = new Date().toISOString();
    }

    records.push({
      record_id: `todo_${todo.id}`,
      collection: 'todos',
      encrypted_data: todo.payload,
      metadata: {
        local_id: todo.id,
        owner: todo.owner,
        updated_at: updatedAt,
        device_id: deviceId,
      },
    });
  }

  return records;
}

/**
 * Convert sync records back to local todo format
 */
export function syncRecordsToTodos(records) {
  return records.map(record => ({
    id: record.metadata?.local_id,
    owner: record.metadata?.owner,
    payload: record.encrypted_data,
    _remote_id: record.record_id,
    _updated_at: record.updated_at,
  }));
}

/**
 * Perform full sync with pull-first strategy
 *
 * Strategy:
 * - PULL FIRST to see what server has
 * - Merge: take newer server versions into local
 * - THEN PUSH only records where local is newer than server
 * - This prevents stale local data from overwriting newer server data
 *
 * Flow:
 * 1. Pull remote changes
 * 2. Merge: update local if server has newer version
 * 3. Push only records that are newer locally than what server has
 */
export async function performSync(client, ownerNpub, lastSyncTime = null) {
  const deviceId = getDeviceId();

  // 1. PULL FIRST - Fetch all remote records
  const remoteData = await client.fetchRecords({});

  // Build a map of server records for comparison
  const serverRecords = new Map();
  if (remoteData.records) {
    for (const record of remoteData.records) {
      serverRecords.set(record.record_id, record);
    }
  }

  // 2. Merge remote records into local DB
  let newRecordsAdded = 0;
  let recordsUpdated = 0;

  for (const record of remoteData.records || []) {
    const match = record.record_id.match(/^todo_(\d+)$/);
    if (!match) continue;

    const localId = parseInt(match[1], 10);
    const serverUpdatedAt = record.updated_at;
    const remoteDeviceId = record.metadata?.device_id;

    const existing = await db.todos.get(localId);

    if (!existing) {
      // New record from server - add it
      await db.todos.put({
        id: localId,
        owner: record.metadata?.owner || ownerNpub,
        payload: record.encrypted_data,
        server_updated_at: serverUpdatedAt,
      });
      newRecordsAdded++;
      console.log(`Sync: Added new record ${localId} from server`);
    } else {
      // Record exists locally - compare timestamps
      const localServerTime = existing.server_updated_at
        ? new Date(existing.server_updated_at).getTime()
        : 0;
      const remoteServerTime = serverUpdatedAt
        ? new Date(serverUpdatedAt).getTime()
        : 0;

      // Skip if from same device (our own echo)
      if (remoteDeviceId === deviceId) {
        // Update server_updated_at to track sync
        if (serverUpdatedAt && remoteServerTime > localServerTime) {
          await db.todos.update(localId, { server_updated_at: serverUpdatedAt });
        }
        continue;
      }

      // Check if local has pending changes (edited since last sync)
      // by comparing encrypted updated_at with server_updated_at
      let localHasPendingChanges = false;
      if (existing.payload) {
        try {
          const decrypted = await decryptObject(existing.payload);
          const localUpdatedAt = decrypted.updated_at || decrypted.created_at;
          if (localUpdatedAt) {
            const localEditTime = new Date(localUpdatedAt).getTime();
            // Local has pending changes if edited after last sync from server
            localHasPendingChanges = localEditTime > localServerTime;
          }
        } catch (err) {
          // Can't decrypt - assume we DO have pending changes (safer)
          // This prevents accidental overwrites if extension decrypt fails
          console.warn(`Sync: Can't decrypt local record ${localId}, assuming pending changes:`, err.message);
          localHasPendingChanges = true;
        }
      }

      // Take server version only if:
      // 1. Server is newer than our last sync, AND
      // 2. We don't have pending local changes
      if (remoteServerTime > localServerTime && !localHasPendingChanges) {
        await db.todos.put({
          id: localId,
          owner: record.metadata?.owner || ownerNpub,
          payload: record.encrypted_data,
          server_updated_at: serverUpdatedAt,
        });
        recordsUpdated++;
        console.log(`Sync: Updated record ${localId} (server newer: ${serverUpdatedAt} > ${existing.server_updated_at})`);
      } else if (localHasPendingChanges) {
        console.log(`Sync: Skipping server update for ${localId} - local has pending changes`);
      }
    }
  }

  // 3. PUSH only records that are newer locally
  // Get all local records and filter to those that need pushing
  const allLocalTodos = await getEncryptedTodosByOwner(ownerNpub);
  const recordsToPush = [];

  for (const todo of allLocalTodos) {
    const recordId = `todo_${todo.id}`;
    const serverRecord = serverRecords.get(recordId);

    // Get local updated_at from decrypted payload
    let localUpdatedAt = null;
    try {
      const decrypted = await decryptObject(todo.payload);
      localUpdatedAt = decrypted.updated_at || decrypted.created_at;
    } catch {
      localUpdatedAt = new Date().toISOString();
    }

    const localTime = localUpdatedAt ? new Date(localUpdatedAt).getTime() : 0;
    const serverTime = serverRecord?.updated_at
      ? new Date(serverRecord.updated_at).getTime()
      : 0;

    // Push if:
    // - Record doesn't exist on server, OR
    // - Local client timestamp is newer than server timestamp (we made changes after last sync)
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
    console.log(`Sync: Pushed ${pushed} records to server`);

    // Update server_updated_at for pushed records
    // (They'll get the actual timestamp on next pull)
  }

  return {
    pushed,
    pulled: newRecordsAdded,
    updated: recordsUpdated,
    syncTime: new Date().toISOString(),
  };
}
