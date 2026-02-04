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
// Kind: 30081 - Delegation Assignment Notification
// ============================================

const DELEGATION_NOTIFY_KIND = 30081;
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
   * Publish a delegation notification to a delegate
   * @param {string} delegatePubkey - The delegate's pubkey (npub or hex)
   * @param {string} recordId - The record ID being assigned
   * @param {string} action - 'assign', 'unassign', or 'update'
   */
  async publishAssignment(delegatePubkey, recordId, action = 'assign') {
    const { pure } = await loadNostrLibs();
    const secret = getMemorySecret();

    try {
      const delegateHex = this._toHex(delegatePubkey);
      const now = Date.now();

      let signedEvent;

      // Create unsigned event (content is empty - actual data is on server)
      const eventTemplate = {
        kind: DELEGATION_NOTIFY_KIND,
        created_at: Math.floor(now / 1000),
        tags: [
          ['d', this.appNpub],           // App namespace
          ['p', delegateHex],            // Delegate being notified
          ['record', recordId],          // Record that was assigned
          ['action', action],            // assign, unassign, update
        ],
        content: '',  // Empty - delegate fetches encrypted data from server
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

      // Publish to relays
      const results = await Promise.allSettled(
        DELEGATION_RELAYS.map(relay =>
          this.relayPool.publish([relay], signedEvent)
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
   * Subscribe to delegation notifications (for bots/agents)
   * Call with a callback to receive task assignment events
   */
  startSubscription(callback) {
    if (!this.relayPool || !this.userPubkeyHex) {
      console.error('DelegationNotifier: not initialized');
      return;
    }

    this.onDelegation = callback;

    const filter = {
      kinds: [DELEGATION_NOTIFY_KIND],
      '#p': [this.userPubkeyHex],  // Events tagging this user as delegate
      since: Math.floor(Date.now() / 1000) - 300,  // Last 5 minutes
    };

    console.log('DelegationNotifier: subscribing to delegation notifications');

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
      // Extract info from tags
      const recordId = event.tags.find(t => t[0] === 'record')?.[1];
      const action = event.tags.find(t => t[0] === 'action')?.[1] || 'assign';
      const appNpub = event.tags.find(t => t[0] === 'd')?.[1];
      const ownerPubkey = event.pubkey;

      console.log(`DelegationNotifier: received ${action} for record ${recordId} from ${ownerPubkey.slice(0, 12)}...`);

      if (this.onDelegation) {
        this.onDelegation({
          action,
          recordId,
          appNpub,
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
