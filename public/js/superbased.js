// SuperBased Sync Client
// Handles authenticated sync with flux_adaptor server

import { loadNostrLibs, getMemorySecret, getMemoryPubkey, bytesToHex, hexToBytes } from './nostr.js';
import { getEncryptedTodosByOwner, importEncryptedTodos, db } from './db.js';

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

  if (!secret) {
    // For extension users
    if (window.nostr?.signEvent) {
      const pubkey = await window.nostr.getPublicKey();

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
 */
export async function todosToSyncRecords(ownerNpub) {
  // Get raw encrypted todos from DB
  const encryptedTodos = await getEncryptedTodosByOwner(ownerNpub);

  return encryptedTodos.map(todo => ({
    record_id: `todo_${todo.id}`,
    collection: 'todos',
    encrypted_data: todo.payload,
    metadata: {
      local_id: todo.id,
      owner: todo.owner,
    },
  }));
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
 * Perform full sync
 * 1. Push local changes to server
 * 2. Pull remote changes
 * 3. Merge into local DB (batched for performance)
 */
export async function performSync(client, ownerNpub, lastSyncTime = null) {
  // 1. Get local todos and push to server
  const localRecords = await todosToSyncRecords(ownerNpub);

  if (localRecords.length > 0) {
    await client.syncRecords(localRecords);
  }

  // 2. Fetch ALL remote records (since filter doesn't work reliably)
  const remoteData = await client.fetchRecords({});

  // 3. Merge remote records into local DB
  // ONLY add records that don't exist locally (never overwrite local changes)
  let newRecordsAdded = 0;
  if (remoteData.records && remoteData.records.length > 0) {
    for (const record of remoteData.records) {
      const match = record.record_id.match(/^todo_(\d+)$/);
      if (match) {
        const localId = parseInt(match[1], 10);

        // Check if this record exists locally
        const existing = await db.todos.get(localId);

        // Only add if it doesn't exist locally (don't overwrite local changes)
        if (!existing) {
          await db.todos.put({
            id: localId,
            owner: record.metadata?.owner || ownerNpub,
            payload: record.encrypted_data,
          });
          newRecordsAdded++;
        }
      }
    }
  }

  return {
    pushed: localRecords.length,
    pulled: newRecordsAdded,
    syncTime: new Date().toISOString(),
  };
}
