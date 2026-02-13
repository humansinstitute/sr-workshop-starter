// SuperBased Sync Client — v3
// Handles authenticated sync with flux_adaptor server (append-only versioned records)

import { loadNostrLibs, getMemorySecret, getMemoryPubkey, bytesToHex, hexToBytes } from './nostr.js';
import { db, formatForV3Sync, parseV3Record, getAiReviewsByOwner } from './db.js';

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

// Serialize extension signEvent calls to prevent race conditions (Safari)
let _signQueue = Promise.resolve();
function serialSignEvent(event) {
  _signQueue = _signQueue.then(() => window.nostr.signEvent(event)).catch(() => window.nostr.signEvent(event));
  return _signQueue;
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
      const pubkey = memPubkey || await window.nostr.getPublicKey();

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

      const event = {
        kind: 27235,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: '',
        pubkey,
      };

      const signedEvent = await serialSignEvent(event);
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

    // Remove trailing slash from httpUrl
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
   * Sync local todos to server (v3 format)
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
 * Perform full v3 sync: pull-first, then push pending.
 *
 * - PULL: fetch all server records, import new ones, overwrite if server version > local
 * - Detect server-side deletes: synced records missing from server → delete locally
 * - PUSH: send all pending local records, update local version from response
 * - Terminal deletes: hard-delete locally after server confirms soft-deleted records
 *
 * @param {SuperBasedClient} client
 * @param {string} ownerNpub
 * @param {string[]} delegatePubkeys - App-level delegate hex pubkeys for encryption
 */
export async function performSync(client, ownerNpub, delegatePubkeys = []) {
  // 1. PULL
  const remoteData = await client.fetchRecords({ collection: 'todos' });
  let pulled = 0;
  let updated = 0;

  for (const record of remoteData.records || []) {
    const local = await db.todos.get(record.record_id);

    if (!local) {
      // New record from server — decrypt and import
      const parsed = await parseV3Record(record);
      if (!parsed) continue;
      await db.todos.put({
        record_id: record.record_id,
        owner: ownerNpub,
        payload: parsed.payload,
        version: record.version,
        pending: false,
      });
      pulled++;
    } else if (record.version > local.version) {
      // Server is newer — overwrite local
      const parsed = await parseV3Record(record);
      if (!parsed) continue;
      await db.todos.put({
        record_id: record.record_id,
        owner: ownerNpub,
        payload: parsed.payload,
        version: record.version,
        pending: false,
      });
      updated++;
    }
    // else: local.version == server.version — skip (pending edits will push)
  }

  // Handle server-side deletes: records we have locally that were synced (version > 0)
  // but are absent from server response (server only returns live records)
  const serverRecordIds = new Set((remoteData.records || []).map(r => r.record_id));
  const allLocal = await db.todos.where('owner').equals(ownerNpub).toArray();
  let deletedLocally = 0;
  for (const local of allLocal) {
    if (local.version > 0 && !serverRecordIds.has(local.record_id) && !local.pending) {
      await db.todos.delete(local.record_id);
      deletedLocally++;
    }
  }

  // 2. PUSH
  const pendingTodos = await db.todos.where('owner').equals(ownerNpub).filter(t => t.pending === true).toArray();
  let pushed = 0;

  if (pendingTodos.length > 0) {
    const records = await formatForV3Sync(pendingTodos, delegatePubkeys);
    const syncResponse = await client.syncRecords(records);

    // Update local versions from server response
    for (const synced of syncResponse.synced || []) {
      await db.todos.update(synced.record_id, {
        version: synced.version,
        pending: false,
      });
    }

    // Handle terminal deletes — if we pushed a soft-deleted record and server
    // accepted it, hard-delete locally
    for (const todo of pendingTodos) {
      try {
        const parsed = JSON.parse(todo.payload);
        if (parsed.deleted === 1) {
          const wasSynced = (syncResponse.synced || []).some(s => s.record_id === todo.record_id);
          if (wasSynced) {
            await db.todos.delete(todo.record_id);
          }
        }
      } catch { /* ignore parse errors */ }
    }

    pushed = pendingTodos.length;
  }

  // 3. PULL ai_reviews (read-only — agent writes these, we just import)
  let aiReviewsPulled = 0;
  let aiReviewsUpdated = 0;
  try {
    const aiData = await client.fetchRecords({ collection: 'ai_reviews' });
    for (const record of aiData.records || []) {
      const local = await db.todos.get(record.record_id);

      if (!local) {
        const parsed = await parseV3Record(record);
        if (!parsed) continue;
        await db.todos.put({
          record_id: record.record_id,
          owner: ownerNpub,
          payload: parsed.payload,
          version: record.version,
          pending: false,
        });
        aiReviewsPulled++;
      } else if (record.version > local.version) {
        const parsed = await parseV3Record(record);
        if (!parsed) continue;
        await db.todos.put({
          record_id: record.record_id,
          owner: ownerNpub,
          payload: parsed.payload,
          version: record.version,
          pending: false,
        });
        aiReviewsUpdated++;
      }
    }

    // Detect server-side deletes for ai_reviews
    const aiServerIds = new Set((aiData.records || []).map(r => r.record_id));
    const localReviews = await getAiReviewsByOwner(ownerNpub);
    for (const review of localReviews) {
      const localRow = await db.todos.get(review.record_id);
      if (localRow && localRow.version > 0 && !aiServerIds.has(review.record_id) && !localRow.pending) {
        await db.todos.delete(review.record_id);
        deletedLocally++;
      }
    }
  } catch (err) {
    console.error('ai_reviews pull failed (non-fatal):', err.message);
  }

  return { pushed, pulled, updated, deletedLocally, aiReviewsPulled, aiReviewsUpdated };
}
