// SuperBased sync - thin wrapper around bundled SDK
// Uses window.SuperBasedSDK.createClient factory

import { getMemorySecret, getMemoryPubkey, bytesToHex } from './nostr.js';
import {
  storeSuperbaedToken,
  getStoredSuperbasedToken,
  clearSuperbasedToken,
} from './secure-store.js';

function getSDK() {
  if (!window.SuperBasedSDK) {
    throw new Error('SuperBased SDK not loaded');
  }
  return window.SuperBasedSDK;
}

export function getDeviceId() {
  return getSDK().getDeviceId();
}

export function parseToken(tokenBase64) {
  return getSDK().parseToken(tokenBase64);
}

export function verifyToken(tokenBase64) {
  try {
    const parsed = parseToken(tokenBase64);
    return parsed.isValid;
  } catch {
    return false;
  }
}

// Secure token storage (encrypted in IndexedDB)
export async function saveToken(token) {
  await storeSuperbaedToken(token);
}

export async function loadToken() {
  return getStoredSuperbasedToken();
}

export async function clearToken() {
  await clearSuperbasedToken();
}

/**
 * SuperBased client wrapper
 */
export class SuperBasedClient {
  constructor(token) {
    this.token = token;
    this.config = parseToken(token);
    this.client = null;
  }

  async connect() {
    const { createClient, bytesToHex: sdkBytesToHex } = getSDK();

    const memorySecret = getMemorySecret();

    let options = {
      serverPubkeyHex: this.config.serverPubkeyHex,
      relays: [this.config.relayUrl],
    };

    if (memorySecret) {
      // Ephemeral or nsec user
      options.privateKeyHex = sdkBytesToHex(memorySecret);
    } else if (window.nostr) {
      // Extension user - get pubkey first
      options.extensionPubkey = await window.nostr.getPublicKey();
    } else {
      throw new Error('No signing method available');
    }

    console.log('SuperBased: creating client');
    console.log('SuperBased: server', this.config.serverPubkeyHex);
    console.log('SuperBased: relay', this.config.relayUrl);

    // Create client using factory (all SDK usage stays in bundle)
    this.client = await createClient(options);

    // Test with health check
    const health = await this.client.Health();
    console.log('SuperBased: connected, health:', health);

    return health;
  }

  async disconnect() {
    if (this.client) {
      await this.client.disconnect();
      this.client = null;
    }
  }

  async health() {
    if (!this.client) throw new Error('Not connected');
    return this.client.Health();
  }

  async getCredits() {
    if (!this.client) throw new Error('Not connected');
    return this.client.GetCredits();
  }

  async syncRecords(records) {
    if (!this.client) throw new Error('Not connected');
    return this.client.SyncRecords(
      this.config.workspaceNpub,
      this.config.appNpub,
      records
    );
  }

  async fetchRecords(options = {}) {
    if (!this.client) throw new Error('Not connected');
    return this.client.FetchRecords(
      this.config.workspaceNpub,
      this.config.appNpub,
      options.collection,
      options.since
    );
  }
}

export function truncateNpub(npub) {
  if (!npub || npub.length < 20) return npub;
  return npub.slice(0, 12) + '...' + npub.slice(-8);
}

/**
 * Sync Notifier wrapper - publishes and subscribes to sync events
 */
export class SyncNotifier {
  constructor(token) {
    this.config = parseToken(token);
    this.notifier = null;
  }

  async init() {
    const { createSyncNotifier, bytesToHex: sdkBytesToHex } = getSDK();

    const memorySecret = getMemorySecret();
    const memoryPubkey = getMemoryPubkey();

    let options = {
      appNpub: this.config.appNpub,
    };

    if (memorySecret && memoryPubkey) {
      // Ephemeral or nsec user
      options.privateKeyHex = sdkBytesToHex(memorySecret);
      options.userPubkeyHex = memoryPubkey;
      options.useExtension = false;
    } else if (window.nostr) {
      // Extension user
      options.userPubkeyHex = await window.nostr.getPublicKey();
      options.useExtension = true;
    } else {
      throw new Error('No signing method available');
    }

    this.notifier = createSyncNotifier(options);
    console.log('SyncNotifier: initialized');
  }

  async publish() {
    if (!this.notifier) throw new Error('Not initialized');
    return this.notifier.publish();
  }

  startSubscription(callback) {
    if (!this.notifier) throw new Error('Not initialized');
    this.notifier.startSubscription(callback);
  }

  stopSubscription() {
    if (this.notifier) {
      this.notifier.stopSubscription();
    }
  }

  destroy() {
    if (this.notifier) {
      this.notifier.destroy();
      this.notifier = null;
    }
  }
}
