// SuperBased sync - thin wrapper around bundled SDK
// Uses window.SuperBasedSDK.createClient factory

import { getMemorySecret, bytesToHex } from './nostr.js';

const SUPERBASED_TOKEN_KEY = 'superbased_token';

function getSDK() {
  if (!window.SuperBasedSDK) {
    throw new Error('SuperBased SDK not loaded');
  }
  return window.SuperBasedSDK;
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

export function saveToken(token) {
  sessionStorage.setItem(SUPERBASED_TOKEN_KEY, token);
}

export function loadToken() {
  return sessionStorage.getItem(SUPERBASED_TOKEN_KEY);
}

export function clearToken() {
  sessionStorage.removeItem(SUPERBASED_TOKEN_KEY);
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
