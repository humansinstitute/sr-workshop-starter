// SuperBased Token Sync via Nostr
// Stores encrypted tokens as addressable events for cross-device sync

import {
  loadNostrLibs,
  encryptToSelf,
  decryptFromSelf,
  getMemoryPubkey,
  getMemorySecret,
  DEFAULT_RELAYS,
} from './nostr.js';

export const SUPERBASED_TOKEN_KIND = 32873;
const FETCH_TIMEOUT = 10000;

/**
 * Hash app identifier (appNpub + httpUrl) to create a stable d-tag
 * This uniquely identifies a token per app per user:
 * - User pubkey (event author)
 * - App identifier (appNpub + httpUrl hash as d-tag)
 */
export async function hashAppIdentifier(appNpub, httpUrl) {
  const encoder = new TextEncoder();
  // Normalize URL: lowercase, trim, remove trailing slash
  const normalizedUrl = httpUrl.toLowerCase().trim().replace(/\/+$/, '');
  // Combine app npub and URL for unique identifier
  const combined = `${appNpub}:${normalizedUrl}`;
  const data = encoder.encode(combined);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Publish a SuperBased token to Nostr (encrypted to self)
 * Creates an addressable event (kind 32873) with d-tag = hash(appNpub + httpUrl)
 * This ensures one token per app per user.
 */
export async function publishSuperBasedToken(token, appNpub, httpUrl) {
  const { pure, pool } = await loadNostrLibs();
  const secret = getMemorySecret();
  const pubkey = getMemoryPubkey();

  // Create payload to encrypt
  const payload = {
    token,
    appNpub,
    httpUrl,
    createdAt: new Date().toISOString(),
  };

  // Encrypt to self using NIP-44
  const encryptedContent = await encryptToSelf(JSON.stringify(payload));

  // Create d-tag from app identifier hash
  const appHash = await hashAppIdentifier(appNpub, httpUrl);

  let signedEvent;

  if (secret && pubkey) {
    // For ephemeral/secret users - sign directly
    signedEvent = pure.finalizeEvent({
      kind: SUPERBASED_TOKEN_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['d', appHash],
        ['client', 'superbased-todo'],
      ],
      content: encryptedContent,
    }, secret);
  } else if (window.nostr?.signEvent) {
    // For extension users - use memory pubkey if available
    const extPubkey = pubkey || await window.nostr.getPublicKey();
    const event = {
      kind: SUPERBASED_TOKEN_KIND,
      created_at: Math.floor(Date.now() / 1000),
      pubkey: extPubkey,
      tags: [
        ['d', appHash],
        ['client', 'superbased-todo'],
      ],
      content: encryptedContent,
    };
    signedEvent = await window.nostr.signEvent(event);
  } else {
    throw new Error('No signing key available');
  }

  // Publish to relays
  const relayPool = new pool.SimplePool();
  try {
    const publishPromises = DEFAULT_RELAYS.map(relay =>
      relayPool.publish([relay], signedEvent).catch(err => {
        console.warn(`Failed to publish to ${relay}:`, err.message);
        return null;
      })
    );
    await Promise.allSettled(publishPromises);
    console.log('SuperBased: Token published to Nostr relays');
    return signedEvent;
  } finally {
    relayPool.close(DEFAULT_RELAYS);
  }
}

/**
 * Fetch SuperBased token for a specific app (appNpub + httpUrl)
 * Returns the decrypted payload or null if not found
 */
export async function fetchSuperBasedTokenByApp(appNpub, httpUrl) {
  const { pool } = await loadNostrLibs();
  const pubkey = getMemoryPubkey() || (window.nostr ? await window.nostr.getPublicKey() : null);

  if (!pubkey) {
    throw new Error('Not logged in');
  }

  const appHash = await hashAppIdentifier(appNpub, httpUrl);

  const relayPool = new pool.SimplePool();
  try {
    const filter = {
      kinds: [SUPERBASED_TOKEN_KIND],
      authors: [pubkey],
      '#d': [appHash],
      limit: 1,
    };

    const events = await Promise.race([
      relayPool.querySync(DEFAULT_RELAYS, filter),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Relay timeout')), FETCH_TIMEOUT)),
    ]);

    if (!events || events.length === 0) {
      return null;
    }

    // Get most recent if multiple (shouldn't happen with addressable events, but just in case)
    const latest = events.reduce((a, b) => (a.created_at > b.created_at) ? a : b);

    // Check if deleted
    const isDeleted = latest.tags.some(t => t[0] === 'deleted');
    if (isDeleted || !latest.content) {
      return null;
    }

    // Decrypt the content
    const decrypted = await decryptFromSelf(latest.content);
    return JSON.parse(decrypted);
  } finally {
    relayPool.close(DEFAULT_RELAYS);
  }
}

/**
 * Fetch all SuperBased tokens for this user
 * Returns array of decrypted payloads
 */
export async function fetchAllSuperBasedTokens() {
  const { pool } = await loadNostrLibs();
  const pubkey = getMemoryPubkey() || (window.nostr ? await window.nostr.getPublicKey() : null);

  if (!pubkey) {
    throw new Error('Not logged in');
  }

  const relayPool = new pool.SimplePool();
  try {
    const filter = {
      kinds: [SUPERBASED_TOKEN_KIND],
      authors: [pubkey],
    };

    const events = await Promise.race([
      relayPool.querySync(DEFAULT_RELAYS, filter),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Relay timeout')), FETCH_TIMEOUT)),
    ]);

    if (!events || events.length === 0) {
      return [];
    }

    // Dedupe by d-tag (keep most recent per app)
    const byDTag = new Map();
    for (const event of events) {
      const dTag = event.tags.find(t => t[0] === 'd')?.[1];
      if (!dTag) continue;

      const existing = byDTag.get(dTag);
      if (!existing || event.created_at > existing.created_at) {
        byDTag.set(dTag, event);
      }
    }

    // Decrypt each unique token (skip deleted ones)
    const tokens = [];
    for (const event of byDTag.values()) {
      // Skip deleted tokens
      const isDeleted = event.tags.some(t => t[0] === 'deleted');
      if (isDeleted || !event.content) continue;

      try {
        const decrypted = await decryptFromSelf(event.content);
        tokens.push(JSON.parse(decrypted));
      } catch (err) {
        console.error('SuperBased: Failed to decrypt token event:', err);
      }
    }

    return tokens;
  } finally {
    relayPool.close(DEFAULT_RELAYS);
  }
}

/**
 * Delete a SuperBased token from Nostr
 * Publishes an empty event with the same d-tag (Nostr convention for deletion)
 */
export async function deleteSuperBasedToken(appNpub, httpUrl) {
  const { pure, pool } = await loadNostrLibs();
  const secret = getMemorySecret();
  const pubkey = getMemoryPubkey();

  const appHash = await hashAppIdentifier(appNpub, httpUrl);

  let signedEvent;

  if (secret && pubkey) {
    signedEvent = pure.finalizeEvent({
      kind: SUPERBASED_TOKEN_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['d', appHash],
        ['client', 'superbased-todo'],
        ['deleted', 'true'],
      ],
      content: '',
    }, secret);
  } else if (window.nostr?.signEvent) {
    // Use memory pubkey if available
    const extPubkey = pubkey || await window.nostr.getPublicKey();
    const event = {
      kind: SUPERBASED_TOKEN_KIND,
      created_at: Math.floor(Date.now() / 1000),
      pubkey: extPubkey,
      tags: [
        ['d', appHash],
        ['client', 'superbased-todo'],
        ['deleted', 'true'],
      ],
      content: '',
    };
    signedEvent = await window.nostr.signEvent(event);
  } else {
    throw new Error('No signing key available');
  }

  const relayPool = new pool.SimplePool();
  try {
    await Promise.allSettled(
      DEFAULT_RELAYS.map(relay => relayPool.publish([relay], signedEvent))
    );
    console.log('SuperBased: Token deleted from Nostr');
    return signedEvent;
  } finally {
    relayPool.close(DEFAULT_RELAYS);
  }
}
