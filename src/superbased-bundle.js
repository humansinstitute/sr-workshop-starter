// SuperBased SDK bundle - exact copy of ctxcn SuperbasedClient pattern
// All SDK usage stays inside this bundle to avoid window export issues

import { Client } from '@modelcontextprotocol/sdk/client';
import {
  NostrClientTransport,
  PrivateKeySigner,
  ApplesauceRelayPool,
} from '@contextvm/sdk';
import { nip19, verifyEvent, finalizeEvent } from 'nostr-tools';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { Observable, Subject, filter, map, takeUntil } from 'rxjs';

// Sync notification constants
const SYNC_NOTIFY_KIND = 30080;
const NOTIFICATION_RELAYS = [
  'wss://relay.damus.io/',
  'wss://nos.lol/',
  'wss://nostr.mom/',
  'wss://offchain.pub/',
  'wss://relay.primal.net/',
  'wss://nostr.wine/',
  'wss://nostrelites.org/',
  'wss://wot.nostr.party/',
];
const DEBOUNCE_MS = 5000; // 5 second debounce on publishing

// Token parsing (matches test_client/src/token-parser.ts)
function parseToken(tokenBase64) {
  const eventJson = atob(tokenBase64);
  const event = JSON.parse(eventJson);

  const isValid = verifyEvent(event);

  const result = {
    rawEvent: event,
    isValid,
    workspacePubkeyHex: event.pubkey,
    workspaceNpub: nip19.npubEncode(event.pubkey),
  };

  const npubToHex = (npub) => {
    const decoded = nip19.decode(npub);
    if (decoded.type !== 'npub') {
      throw new Error(`Expected npub, got ${decoded.type}`);
    }
    return decoded.data;
  };

  for (const tag of event.tags) {
    const [key, value] = tag;
    switch (key) {
      case 'server':
        result.serverNpub = value;
        result.serverPubkeyHex = npubToHex(value);
        break;
      case 'workspace':
        result.workspaceNpub = value;
        result.workspacePubkeyHex = npubToHex(value);
        break;
      case 'app':
        result.appNpub = value;
        result.appPubkeyHex = npubToHex(value);
        break;
      case 'relay':
        result.relayUrl = value;
        break;
      case 'invite':
        result.inviteId = value;
        break;
    }
  }

  return result;
}

/**
 * Extension Signer - wraps window.nostr for NIP-07 extensions
 * All methods return Promises (SDK uses withTimeout wrapper that expects Promises)
 */
class ExtensionSigner {
  constructor(pubkey) {
    this._pubkey = pubkey;

    // SDK checks for nip44 object with encrypt/decrypt methods
    this.nip44 = {
      encrypt: async (recipientPubkey, plaintext) => {
        if (!window.nostr?.nip44?.encrypt) {
          throw new Error('Extension does not support NIP-44 encryption');
        }
        return window.nostr.nip44.encrypt(recipientPubkey, plaintext);
      },
      decrypt: async (senderPubkey, ciphertext) => {
        if (!window.nostr?.nip44?.decrypt) {
          throw new Error('Extension does not support NIP-44 decryption');
        }
        return window.nostr.nip44.decrypt(senderPubkey, ciphertext);
      }
    };
  }

  // Must return Promise - SDK wraps with withTimeout
  getPublicKey() {
    return Promise.resolve(this._pubkey);
  }

  // SDK calls signEvent
  async signEvent(event) {
    return window.nostr.signEvent(event);
  }
}

/**
 * Create a SuperBased client - factory function that keeps SDK usage internal
 * Returns an object with methods to call
 */
async function createClient(options) {
  const { privateKeyHex, extensionPubkey, serverPubkeyHex, relays } = options;

  // Create signer
  let signer;
  if (privateKeyHex) {
    signer = new PrivateKeySigner(privateKeyHex);
    console.log('SuperBased: using PrivateKeySigner');
  } else if (extensionPubkey && window.nostr) {
    signer = new ExtensionSigner(extensionPubkey);
    console.log('SuperBased: using ExtensionSigner');
  } else {
    throw new Error('No signing method available');
  }

  // Create MCP client
  const client = new Client({
    name: "SuperbasedClient",
    version: "1.0.0",
  });

  // Create relay pool and transport
  const relayHandler = new ApplesauceRelayPool(relays);
  const transport = new NostrClientTransport({
    serverPubkey: serverPubkeyHex,
    signer,
    relayHandler,
    isStateless: true,
  });

  // Connect (fire and forget, matches ctxcn pattern)
  client.connect(transport).catch((error) => {
    console.error('SuperBased: connection error', error);
  });

  // Wait for connection
  await new Promise(resolve => setTimeout(resolve, 1500));

  // Helper to call tools
  async function call(name, args) {
    const result = await client.callTool({
      name,
      arguments: { ...args },
    });

    if (result.structuredContent) {
      return result.structuredContent;
    }

    const content = result.content;
    const textContent = content?.find((c) => c.type === 'text');
    if (textContent?.text) {
      return JSON.parse(textContent.text);
    }

    throw new Error('No valid response content');
  }

  // Return client interface
  return {
    async Health(args = {}) {
      return call("health", args);
    },
    async GetCredits(args = {}) {
      return call("get_credits", args);
    },
    async SyncRecords(workspace_npub, app_npub, records) {
      return call("sync_records", { workspace_npub, app_npub, records });
    },
    async FetchRecords(workspace_npub, app_npub, collection, since) {
      return call("fetch_records", { workspace_npub, app_npub, collection, since });
    },
    async disconnect() {
      try {
        await transport.close();
      } catch (err) {
        console.error('SuperBased: disconnect error', err);
      }
    }
  };
}

// ============================================
// Device ID Management
// ============================================

const DEVICE_ID_KEY = 'superbased_device_id';

function getDeviceId() {
  let deviceId = localStorage.getItem(DEVICE_ID_KEY);
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, deviceId);
    console.log('SyncNotifier: generated new deviceId:', deviceId);
  }
  return deviceId;
}

// ============================================
// Sync Notifier - uses ApplesauceRelayPool and PrivateKeySigner (same as CVM)
// ============================================

class SyncNotifier {
  constructor(options) {
    this.userPubkeyHex = options.userPubkeyHex;
    this.appNpub = options.appNpub;
    this.privateKeyHex = options.privateKeyHex;
    this.useExtension = options.useExtension;

    this.deviceId = getDeviceId();
    this.signer = null;
    this.relayPool = null;
    this.stopSignal = new Subject();
    this.subscription = null;
    this.lastPublishTime = 0;
    this.onSyncNeeded = null;

    // Create signer (same pattern as CVM client)
    if (this.privateKeyHex) {
      this.signer = new PrivateKeySigner(this.privateKeyHex);
    } else if (this.useExtension) {
      this.signer = new ExtensionSigner(this.userPubkeyHex);
    }

    // Create relay pool (same as CVM uses)
    this.relayPool = new ApplesauceRelayPool(NOTIFICATION_RELAYS);

    console.log('SyncNotifier: initialized with deviceId:', this.deviceId);
  }

  // Publish a sync notification
  async publish() {
    // Debounce check
    const now = Date.now();
    if (now - this.lastPublishTime < DEBOUNCE_MS) {
      console.log('SyncNotifier: skipping publish (debounce)');
      return false;
    }
    this.lastPublishTime = now;

    try {
      // Create payload
      const payload = {
        deviceId: this.deviceId,
        appNpub: this.appNpub,
        timestamp: now,
      };

      // Encrypt payload using signer's nip44 (same as CVM does)
      const encrypted = await this.signer.nip44.encrypt(
        this.userPubkeyHex,
        JSON.stringify(payload)
      );

      // Create unsigned event
      const unsignedEvent = {
        kind: SYNC_NOTIFY_KIND,
        created_at: Math.floor(now / 1000),
        tags: [
          ['p', this.userPubkeyHex],
          ['d', this.appNpub],
        ],
        content: encrypted,
      };

      // Sign event using signer
      const signedEvent = await this.signer.signEvent(unsignedEvent);

      // Publish using relay pool
      await this.relayPool.publish(signedEvent);
      console.log('SyncNotifier: published notification');

      return true;
    } catch (err) {
      console.error('SyncNotifier: publish failed:', err);
      return false;
    }
  }

  // Subscribe to sync notifications using ApplesauceRelayPool + RxJS
  startSubscription(callback) {
    if (this.subscription) {
      console.log('SyncNotifier: already subscribed');
      return;
    }

    this.onSyncNeeded = callback;

    const nostrFilter = {
      kinds: [SYNC_NOTIFY_KIND],
      '#p': [this.userPubkeyHex],
      since: Math.floor(Date.now() / 1000) - 300,
    };

    console.log('SyncNotifier: starting subscription with filter:', nostrFilter);

    // Create RxJS Observable from relay pool subscription
    const eventObservable = new Observable((subscriber) => {
      // ApplesauceRelayPool.subscribe(filters, onEvent, onEose) - takes separate args, not object
      this.relayPool.subscribe(
        [nostrFilter],
        (event) => {
          subscriber.next(event);
        },
        () => {
          console.log('SyncNotifier: received EOSE');
        }
      );

      // Cleanup on unsubscribe - call unsubscribe on the pool
      return () => {
        this.relayPool.unsubscribe();
      };
    });

    // Process events with RxJS
    this.subscription = eventObservable
      .pipe(takeUntil(this.stopSignal))
      .subscribe({
        next: async (event) => {
          try {
            // Decrypt payload using signer's nip44
            const decrypted = await this.signer.nip44.decrypt(
              event.pubkey,
              event.content
            );

            const payload = JSON.parse(decrypted);

            // Skip our own notifications
            if (payload.deviceId === this.deviceId) {
              console.log('SyncNotifier: skipping own notification');
              return;
            }

            // Skip if different app
            if (payload.appNpub !== this.appNpub) {
              console.log('SyncNotifier: skipping different app notification');
              return;
            }

            console.log('SyncNotifier: received sync notification from device:', payload.deviceId);

            // Trigger callback
            if (this.onSyncNeeded) {
              this.onSyncNeeded(payload);
            }
          } catch (err) {
            console.error('SyncNotifier: failed to process event:', err);
          }
        },
        error: (err) => {
          console.error('SyncNotifier: subscription error:', err);
        },
      });
  }

  // Stop subscription
  stopSubscription() {
    if (this.subscription) {
      this.stopSignal.next();
      this.subscription.unsubscribe();
      this.subscription = null;
      this.onSyncNeeded = null;
      console.log('SyncNotifier: stopped subscription');
    }
  }

  // Cleanup
  destroy() {
    this.stopSubscription();
    // Note: ApplesauceRelayPool may not need explicit close
  }
}

// Factory function for SyncNotifier
function createSyncNotifier(options) {
  return new SyncNotifier(options);
}

// Export to window
window.SuperBasedSDK = {
  createClient,
  createSyncNotifier,
  parseToken,
  verifyEvent,
  nip19,
  bytesToHex,
  getDeviceId,
};

console.log('SuperBased SDK loaded');
