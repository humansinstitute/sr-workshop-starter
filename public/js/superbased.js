// SuperBased Sync Client
// Handles authenticated sync with flux_adaptor server

import { loadNostrLibs, getMemorySecret, getMemoryPubkey, bytesToHex, hexToBytes } from './nostr.js';
import { getEncryptedTodosByOwner, importEncryptedTodos, db, formatTodosForDER, parseDERRecord, CURRENT_SCHEMA_VERSION } from './db.js';

/**
 * Sanitize JSON string by escaping control characters
 * Fixes common issues from improperly escaped agent-written data
 */
function sanitizePayload(str) {
  if (!str || typeof str !== 'string') return str;
  return str
    .replace(/\r\n/g, '\\n')
    .replace(/\r/g, '\\n')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

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

  /**
   * Grant delegation to another npub
   */
  async grantDelegation(delegateNpub, permissions) {
    return this.request(`/apps/${this.config.appNpub}/delegate`, 'POST', {
      delegate_npub: delegateNpub,
      permissions: permissions,
    });
  }

  /**
   * List delegations granted by the current user
   */
  async listDelegations() {
    return this.request(`/apps/${this.config.appNpub}/delegations`, 'GET');
  }

  /**
   * Revoke a delegation
   */
  async revokeDelegation(delegateNpub) {
    return this.request(`/apps/${this.config.appNpub}/delegate/${delegateNpub}`, 'DELETE');
  }

  /**
   * Fetch records delegated to the current user
   */
  async fetchDelegatedRecords(options = {}) {
    const params = new URLSearchParams();
    params.set('delegate', 'true');
    if (options.collection) params.set('collection', options.collection);
    if (options.since) params.set('since', options.since);

    const queryString = params.toString();
    const path = `/records/${this.config.appNpub}/fetch?${queryString}`;

    return this.request(path, 'GET');
  }
}

/**
 * Convert local todos to DER v1 sync format
 * Encrypts payload with NIP-44 to owner + delegates
 */
export async function todosToSyncRecords(ownerNpub) {
  const storedTodos = await getEncryptedTodosByOwner(ownerNpub);
  return formatTodosForDER(storedTodos);
}

/**
 * Convert sync records back to local todo format
 * Handles both v0 (encrypted_data) and v1 (encrypted_payload) formats
 * v1 records are decrypted via parseDERRecord
 */
export async function syncRecordsToTodos(records) {
  const results = [];
  for (const record of records) {
    const parsed = await parseDERRecord(record);
    if (parsed) {
      results.push({
        id: parsed.id,
        owner: parsed.owner,
        payload: sanitizePayload(parsed.payload),
        read_delegates: parsed.read_delegates || [],
        write_delegates: parsed.write_delegates || [],
        schema_version: parsed.schema_version || 0,
        _remote_id: parsed.record_id,
        _updated_at: parsed.updated_at,
      });
    }
  }
  return results;
}

/**
 * Perform full sync with pull-first strategy and DER v1 support.
 *
 * Strategy:
 * - PULL FIRST to see what server has
 * - Merge: take newer server versions into local (decrypt v1 records)
 * - THEN PUSH only records where local is newer (encrypt as v1)
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
    // Match both numeric IDs (legacy) and hex UUIDs
    const match = record.record_id.match(/^todo_([a-f0-9]+)$/i);
    if (!match) continue;

    const localId = match[1]; // Keep as string (UUID)
    const serverUpdatedAt = record.updated_at;
    const remoteDeviceId = record.metadata?.device_id;
    const isV1 = record.metadata?.schema_version >= 1 && record.encrypted_payload;

    const existing = await db.todos.get(localId);

    if (!existing) {
      // New record from server - add it
      // Decrypt if v1, otherwise use encrypted_data as payload
      let payload;
      let readDelegates = [];
      let writeDelegates = [];
      let schemaVersion = 0;

      if (isV1) {
        const parsed = await parseDERRecord(record);
        if (!parsed) continue; // decrypt failed
        payload = parsed.payload;
        readDelegates = parsed.read_delegates;
        writeDelegates = parsed.write_delegates;
        schemaVersion = parsed.schema_version;
      } else {
        payload = sanitizePayload(record.encrypted_data);
      }

      await db.todos.put({
        id: localId,
        owner: record.metadata?.owner || ownerNpub,
        payload,
        schema_version: schemaVersion,
        read_delegates: readDelegates,
        write_delegates: writeDelegates,
        server_updated_at: serverUpdatedAt,
      });
      newRecordsAdded++;
      console.log(`Sync: Added new record ${localId} from server (v${schemaVersion})`);
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
      let localHasPendingChanges = false;
      if (existing.payload) {
        try {
          const parsed = JSON.parse(existing.payload);
          const localUpdatedAt = parsed.updated_at || parsed.created_at;
          if (localUpdatedAt) {
            const localEditTime = new Date(localUpdatedAt).getTime();
            localHasPendingChanges = localEditTime > localServerTime;
          }
        } catch (err) {
          console.warn(`Sync: Can't parse local record ${localId}, assuming pending changes:`, err.message);
          localHasPendingChanges = true;
        }
      }

      // Take server version only if server is newer AND no pending local changes
      if (remoteServerTime > localServerTime && !localHasPendingChanges) {
        let payload;
        let readDelegates = existing.read_delegates || [];
        let writeDelegates = existing.write_delegates || [];
        let schemaVersion = existing.schema_version || 0;

        if (isV1) {
          const parsed = await parseDERRecord(record);
          if (!parsed) continue;
          payload = parsed.payload;
          readDelegates = parsed.read_delegates;
          writeDelegates = parsed.write_delegates;
          schemaVersion = parsed.schema_version;
        } else {
          payload = sanitizePayload(record.encrypted_data);
        }

        await db.todos.put({
          id: localId,
          owner: record.metadata?.owner || ownerNpub,
          payload,
          schema_version: schemaVersion,
          read_delegates: readDelegates,
          write_delegates: writeDelegates,
          server_updated_at: serverUpdatedAt,
        });
        recordsUpdated++;
        console.log(`Sync: Updated record ${localId} (server newer, v${schemaVersion})`);
      } else if (localHasPendingChanges) {
        console.log(`Sync: Skipping server update for ${localId} - local has pending changes`);
      }
    }
  }

  // 3. PUSH only records that are newer locally
  const allLocalTodos = await getEncryptedTodosByOwner(ownerNpub);
  const todosToPush = [];

  for (const todo of allLocalTodos) {
    const recordId = `todo_${todo.id}`;
    const serverRecord = serverRecords.get(recordId);

    let localUpdatedAt = null;
    try {
      const parsed = JSON.parse(todo.payload);
      localUpdatedAt = parsed.updated_at || parsed.created_at;
    } catch {
      localUpdatedAt = new Date().toISOString();
    }

    const localTime = localUpdatedAt ? new Date(localUpdatedAt).getTime() : 0;
    const serverTime = serverRecord?.updated_at
      ? new Date(serverRecord.updated_at).getTime()
      : 0;

    if (!serverRecord || localTime > serverTime) {
      todosToPush.push(todo);
    }
  }

  let pushed = 0;
  if (todosToPush.length > 0) {
    // Encrypt and format as DER v1 before pushing
    const recordsToPush = await formatTodosForDER(todosToPush);
    await client.syncRecords(recordsToPush);
    pushed = recordsToPush.length;
    console.log(`Sync: Pushed ${pushed} DER v1 records to server`);
  }

  return {
    pushed,
    pulled: newRecordsAdded,
    updated: recordsUpdated,
    syncTime: new Date().toISOString(),
  };
}
