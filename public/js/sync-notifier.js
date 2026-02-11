// SyncNotifier - Real-time sync notifications via Nostr relays
// Publishes events when local changes happen, subscribes to remote changes

import { loadNostrLibs, getMemorySecret, getMemoryPubkey } from './nostr.js';

const SYNC_NOTIFY_KIND = 30080;
// Use just one fast relay for notifications
const NOTIFICATION_RELAYS = [
  'wss://relay.damus.io',
];
const DEBOUNCE_MS = 2000; // 2 second debounce

const DEVICE_ID_KEY = 'superbased_device_id';

function getDeviceId() {
  let deviceId = localStorage.getItem(DEVICE_ID_KEY);
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, deviceId);
    console.log('SyncNotifier: generated deviceId:', deviceId);
  }
  return deviceId;
}

export class SyncNotifier {
  constructor(appNpub) {
    this.appNpub = appNpub;
    this.deviceId = getDeviceId();
    this.lastPublishTime = 0;
    this.onSyncNeeded = null;
    this.relayPool = null;
    this.subscriptions = [];
    this.userPubkeyHex = null;
  }

  async init() {
    const { pool } = await loadNostrLibs();
    this.relayPool = new pool.SimplePool();

    // Get user pubkey
    const secret = getMemorySecret();
    const pubkey = getMemoryPubkey();

    if (pubkey) {
      this.userPubkeyHex = pubkey;
    } else if (window.nostr) {
      this.userPubkeyHex = await window.nostr.getPublicKey();
    } else {
      throw new Error('No user pubkey available');
    }

    console.log('SyncNotifier: initialized for', this.userPubkeyHex.slice(0, 8) + '...');
  }

  /**
   * Publish a sync notification to relays
   */
  async publish() {
    // Debounce
    const now = Date.now();
    if (now - this.lastPublishTime < DEBOUNCE_MS) {
      console.log('SyncNotifier: skipping (debounce)');
      return false;
    }
    this.lastPublishTime = now;

    const { pure, nip44 } = await loadNostrLibs();
    const secret = getMemorySecret();

    // Create payload
    const payload = {
      deviceId: this.deviceId,
      appNpub: this.appNpub,
      timestamp: now,
    };

    let signedEvent;

    if (secret && this.userPubkeyHex) {
      // Encrypt payload to self
      const conversationKey = nip44.v2.utils.getConversationKey(secret, this.userPubkeyHex);
      const encrypted = nip44.v2.encrypt(JSON.stringify(payload), conversationKey);

      signedEvent = pure.finalizeEvent({
        kind: SYNC_NOTIFY_KIND,
        created_at: Math.floor(now / 1000),
        tags: [
          ['p', this.userPubkeyHex],
          ['d', this.appNpub],
        ],
        content: encrypted,
      }, secret);
    } else if (window.nostr) {
      // Extension user
      const encrypted = await window.nostr.nip44.encrypt(this.userPubkeyHex, JSON.stringify(payload));

      const event = {
        kind: SYNC_NOTIFY_KIND,
        created_at: Math.floor(now / 1000),
        pubkey: this.userPubkeyHex,
        tags: [
          ['p', this.userPubkeyHex],
          ['d', this.appNpub],
        ],
        content: encrypted,
      };

      signedEvent = await window.nostr.signEvent(event);
    } else {
      console.error('SyncNotifier: no signing method');
      return false;
    }

    // Publish to relays
    try {
      const results = await Promise.allSettled(
        NOTIFICATION_RELAYS.map(relay =>
          this.relayPool.publish([relay], signedEvent)
        )
      );
      console.log('SyncNotifier: published to', results.filter(r => r.status === 'fulfilled').length, 'relays');
      return true;
    } catch (err) {
      console.error('SyncNotifier: publish failed:', err);
      return false;
    }
  }

  /**
   * Subscribe to sync notifications from other devices
   */
  startSubscription(callback) {
    if (!this.relayPool || !this.userPubkeyHex) {
      console.error('SyncNotifier: not initialized');
      return;
    }

    this.onSyncNeeded = callback;

    const filter = {
      kinds: [SYNC_NOTIFY_KIND],
      '#p': [this.userPubkeyHex],
      since: Math.floor(Date.now() / 1000) - 300, // Last 5 minutes
    };

    console.log('SyncNotifier: subscribing to notifications');

    const sub = this.relayPool.subscribeMany(
      NOTIFICATION_RELAYS,
      [filter],
      {
        onevent: async (event) => {
          await this.handleEvent(event);
        },
        oneose: () => {
          console.log('SyncNotifier: subscription ready (EOSE)');
        },
      }
    );

    this.subscriptions.push(sub);
  }

  async handleEvent(event) {
    const { nip44 } = await loadNostrLibs();
    const secret = getMemorySecret();

    try {
      let payload;

      if (secret && this.userPubkeyHex) {
        const conversationKey = nip44.v2.utils.getConversationKey(secret, this.userPubkeyHex);
        const decrypted = nip44.v2.decrypt(event.content, conversationKey);
        payload = JSON.parse(decrypted);
      } else if (window.nostr?.nip44?.decrypt) {
        const decrypted = await window.nostr.nip44.decrypt(event.pubkey, event.content);
        payload = JSON.parse(decrypted);
      } else {
        console.log('SyncNotifier: cannot decrypt event');
        return;
      }

      // Skip our own notifications
      if (payload.deviceId === this.deviceId) {
        console.log('SyncNotifier: ignoring own notification');
        return;
      }

      // Skip different app
      if (payload.appNpub !== this.appNpub) {
        console.log('SyncNotifier: ignoring different app');
        return;
      }

      console.log('SyncNotifier: received notification from device:', payload.deviceId.slice(0, 8));

      if (this.onSyncNeeded) {
        this.onSyncNeeded(payload);
      }
    } catch (err) {
      console.error('SyncNotifier: failed to process event:', err);
    }
  }

  stopSubscription() {
    for (const sub of this.subscriptions) {
      sub.close();
    }
    this.subscriptions = [];
    this.onSyncNeeded = null;
    console.log('SyncNotifier: stopped subscription');
  }

  destroy() {
    this.stopSubscription();
    if (this.relayPool) {
      this.relayPool.close(NOTIFICATION_RELAYS);
      this.relayPool = null;
    }
  }
}

// ============================================
// DelegationNotifier - notifies bots/agents of task assignments
// Kind: 30078 - Replaceable delegation manifest (DER)
// ============================================

const DELEGATION_MANIFEST_KIND = 30078;
const DELEGATION_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://purplepag.es',
  'wss://relay.nostr.band',
];

export class DelegationNotifier {
  constructor(appNpub) {
    this.appNpub = appNpub;
    this.relayPool = null;
    this.userPubkeyHex = null;
    this.subscriptions = [];
    this.onDelegation = null;
    this.superbasedPubkeyHex = null; // Set from token config
  }

  async init() {
    const { pool, nip19 } = await loadNostrLibs();
    this.relayPool = new pool.SimplePool();
    this.nip19 = nip19;

    // Get user pubkey
    const pubkey = getMemoryPubkey();
    if (pubkey) {
      this.userPubkeyHex = pubkey;
    } else if (window.nostr) {
      this.userPubkeyHex = await window.nostr.getPublicKey();
    } else {
      throw new Error('No user pubkey available');
    }

    // Derive superbased pubkey from appNpub
    if (this.appNpub) {
      try {
        const decoded = nip19.decode(this.appNpub);
        this.superbasedPubkeyHex = decoded.data;
      } catch { /* ignore */ }
    }

    console.log('DelegationNotifier: initialized for app', this.appNpub?.slice(0, 15) + '...');
  }

  // Convert npub to hex if needed
  _toHex(pubkey) {
    if (pubkey.startsWith('npub1')) {
      const decoded = this.nip19.decode(pubkey);
      return decoded.data;
    }
    return pubkey;
  }

  /**
   * Publish a delegation notification to a delegate (legacy per-record)
   */
  async publishAssignment(delegatePubkey, recordId, action = 'assign') {
    const { pure } = await loadNostrLibs();
    const secret = getMemorySecret();

    try {
      const delegateHex = this._toHex(delegatePubkey);
      const now = Date.now();

      let signedEvent;

      const eventTemplate = {
        kind: DELEGATION_MANIFEST_KIND,
        created_at: Math.floor(now / 1000),
        tags: [
          ['d', this.appNpub],
          ['p', delegateHex],
          ['t', 'der-delegation'],
          ['record', recordId],
          ['action', action],
        ],
        content: '',
      };

      if (secret) {
        signedEvent = pure.finalizeEvent(eventTemplate, secret);
      } else if (window.nostr) {
        eventTemplate.pubkey = this.userPubkeyHex;
        signedEvent = await window.nostr.signEvent(eventTemplate);
      } else {
        console.error('DelegationNotifier: no signing method');
        return false;
      }

      const results = await Promise.allSettled(
        DELEGATION_RELAYS.map(relay =>
          this.relayPool.publish([relay], signedEvent).catch(() => {
            // Relay may block kind 30078 — swallow per-relay errors
          })
        )
      );

      const successCount = results.filter(r => r.status === 'fulfilled').length;
      console.log(`DelegationNotifier: published ${action} for ${recordId} to ${delegatePubkey.slice(0, 15)}... (${successCount}/${DELEGATION_RELAYS.length} relays)`);

      return true;
    } catch (err) {
      console.error('DelegationNotifier: publish failed:', err);
      return false;
    }
  }

  /**
   * Publish notifications for multiple assignments (batch)
   */
  async publishAssignments(assignments) {
    const results = [];
    for (const { delegatePubkey, recordId, action } of assignments) {
      const result = await this.publishAssignment(delegatePubkey, recordId, action || 'assign');
      results.push({ delegatePubkey, recordId, success: result });
    }
    return results;
  }

  /**
   * Publish a full delegation manifest (kind 30078 replaceable event).
   * One manifest per delegate per app/superbased instance.
   * Content is NIP-44 encrypted to the delegate pubkey.
   *
   * @param {string} delegatePubkey - hex pubkey of the delegate
   * @param {Array} records - [{ record_id, collection, access: 'read'|'write', delegated_at }]
   * @param {string} apiBaseUrl - SuperBased HTTP URL
   */
  async publishDelegationManifest(delegatePubkey, records, apiBaseUrl) {
    const { pure, nip44 } = await loadNostrLibs();
    const secret = getMemorySecret();
    const delegateHex = this._toHex(delegatePubkey);

    const dTag = `super-based-todo_${this.superbasedPubkeyHex || this.appNpub}`;

    // Build manifest content
    const manifest = {
      superbased_pubkey: this.superbasedPubkeyHex || '',
      api_base_url: apiBaseUrl || '',
      app: 'super-based-todo',
      delegated_by: this.userPubkeyHex,
      updated_at: new Date().toISOString(),
      records,
    };

    const plaintext = JSON.stringify(manifest);
    let encryptedContent;
    let signedEvent;

    try {
      const now = Date.now();

      if (secret) {
        // Encrypt to delegate
        const conversationKey = nip44.v2.utils.getConversationKey(secret, delegateHex);
        encryptedContent = nip44.v2.encrypt(plaintext, conversationKey);

        signedEvent = pure.finalizeEvent({
          kind: DELEGATION_MANIFEST_KIND,
          created_at: Math.floor(now / 1000),
          tags: [
            ['d', dTag],
            ['p', delegateHex],
            ['t', 'der-delegation'],
          ],
          content: encryptedContent,
        }, secret);
      } else if (window.nostr) {
        encryptedContent = await window.nostr.nip44.encrypt(delegateHex, plaintext);

        const eventTemplate = {
          kind: DELEGATION_MANIFEST_KIND,
          created_at: Math.floor(now / 1000),
          pubkey: this.userPubkeyHex,
          tags: [
            ['d', dTag],
            ['p', delegateHex],
            ['t', 'der-delegation'],
          ],
          content: encryptedContent,
        };

        signedEvent = await window.nostr.signEvent(eventTemplate);
      } else {
        console.error('DelegationNotifier: no signing method');
        return false;
      }

      const results = await Promise.allSettled(
        DELEGATION_RELAYS.map(relay =>
          this.relayPool.publish([relay], signedEvent).catch(() => {
            // Relay may block kind 30078 — swallow per-relay errors
          })
        )
      );

      const successCount = results.filter(r => r.status === 'fulfilled').length;
      console.log(`DelegationNotifier: published manifest for ${delegateHex.slice(0, 12)}... with ${records.length} records (${successCount}/${DELEGATION_RELAYS.length} relays)`);
      return true;
    } catch (err) {
      console.error('DelegationNotifier: manifest publish failed:', err);
      return false;
    }
  }

  /**
   * Subscribe to delegation notifications (for bots/agents)
   * Listens for kind 30078 events tagged with our pubkey
   */
  startSubscription(callback) {
    if (!this.relayPool || !this.userPubkeyHex) {
      console.error('DelegationNotifier: not initialized');
      return;
    }

    this.onDelegation = callback;

    const filter = {
      kinds: [DELEGATION_MANIFEST_KIND],
      '#p': [this.userPubkeyHex],
      '#t': ['der-delegation'],
      since: Math.floor(Date.now() / 1000) - 300,
    };

    console.log('DelegationNotifier: subscribing to delegation manifests');

    const sub = this.relayPool.subscribeMany(
      DELEGATION_RELAYS,
      [filter],
      {
        onevent: async (event) => {
          await this.handleEvent(event);
        },
        oneose: () => {
          console.log('DelegationNotifier: subscription ready (EOSE)');
        },
      }
    );

    this.subscriptions.push(sub);
  }

  async handleEvent(event) {
    try {
      const dTag = event.tags.find(t => t[0] === 'd')?.[1];
      const ownerPubkey = event.pubkey;

      // Try to decrypt manifest content
      let manifest = null;
      if (event.content) {
        try {
          const { nip44 } = await loadNostrLibs();
          const secret = getMemorySecret();
          let decrypted;

          if (secret) {
            const conversationKey = nip44.v2.utils.getConversationKey(secret, ownerPubkey);
            decrypted = nip44.v2.decrypt(event.content, conversationKey);
          } else if (window.nostr?.nip44?.decrypt) {
            decrypted = await window.nostr.nip44.decrypt(ownerPubkey, event.content);
          }

          if (decrypted) {
            manifest = JSON.parse(decrypted);
          }
        } catch (err) {
          console.warn('DelegationNotifier: could not decrypt manifest:', err.message);
        }
      }

      // Also check for legacy per-record tags
      const recordId = event.tags.find(t => t[0] === 'record')?.[1];
      const action = event.tags.find(t => t[0] === 'action')?.[1] || 'manifest';

      console.log(`DelegationNotifier: received ${action} from ${ownerPubkey.slice(0, 12)}...`);

      if (this.onDelegation) {
        this.onDelegation({
          action: manifest ? 'manifest' : action,
          manifest,
          recordId,
          dTag,
          ownerPubkey,
          timestamp: event.created_at,
        });
      }
    } catch (err) {
      console.error('DelegationNotifier: failed to process event:', err);
    }
  }

  stopSubscription() {
    for (const sub of this.subscriptions) {
      sub.close();
    }
    this.subscriptions = [];
    this.onDelegation = null;
    console.log('DelegationNotifier: stopped subscription');
  }

  destroy() {
    this.stopSubscription();
    if (this.relayPool) {
      this.relayPool.close(DELEGATION_RELAYS);
      this.relayPool = null;
    }
  }
}
