// Key Teleport - Secure Nostr identity transfer
// Instance keypair management + teleport handling

import Dexie from 'https://esm.sh/dexie@4.0.10';
import { loadNostrLibs, hexToBytes, bytesToHex } from './nostr.js';

// Separate database for instance identity (app-level, not user-level)
const instanceDb = new Dexie('KeyTeleportInstance');

instanceDb.version(1).stores({
  identity: 'id',
});

const INSTANCE_ID = 'instance-keypair';
const KEYTELEPORT_KIND = 30078;

// ===========================================
// Instance Keypair Management
// ===========================================

/**
 * Get or create the instance keypair
 * Generated once per browser, stored permanently
 */
export async function getOrCreateInstanceKey() {
  const stored = await instanceDb.identity.get(INSTANCE_ID);
  if (stored?.privateKeyHex) {
    return {
      privateKeyHex: stored.privateKeyHex,
      publicKeyHex: stored.publicKeyHex,
    };
  }

  // Generate new keypair
  const { pure, nip19 } = await loadNostrLibs();
  const privateKey = pure.generateSecretKey();
  const publicKeyHex = pure.getPublicKey(privateKey);
  const privateKeyHex = bytesToHex(privateKey);

  await instanceDb.identity.put({
    id: INSTANCE_ID,
    privateKeyHex,
    publicKeyHex,
    createdAt: Date.now(),
  });

  return { privateKeyHex, publicKeyHex };
}

/**
 * Get instance public key as npub
 */
export async function getInstanceNpub() {
  const { publicKeyHex } = await getOrCreateInstanceKey();
  const { nip19 } = await loadNostrLibs();
  return nip19.npubEncode(publicKeyHex);
}

/**
 * Get instance private key as Uint8Array
 */
async function getInstancePrivateKey() {
  const { privateKeyHex } = await getOrCreateInstanceKey();
  return hexToBytes(privateKeyHex);
}

// ===========================================
// Registration Blob Generation
// ===========================================

/**
 * Generate a registration blob for Welcome/sender apps
 * One-click: no input needed, blob is self-contained
 */
export async function generateRegistrationBlob() {
  const { pure } = await loadNostrLibs();
  const instanceKey = await getInstancePrivateKey();

  // Registration content (plaintext - nothing secret here)
  const content = {
    url: window.location.origin,
    name: 'Super Based Todo',
    description: 'Local-first todo app with Nostr auth',
    v: 1,
  };

  // Create and sign event
  const event = pure.finalizeEvent({
    kind: KEYTELEPORT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['type', 'keyteleport-app-registration'],
    ],
    content: JSON.stringify(content),
  }, instanceKey);

  // Base64 encode
  return btoa(JSON.stringify(event));
}

// ===========================================
// Receiving Teleported Keys
// ===========================================

/**
 * Check URL for incoming teleport
 * Returns the blob if found, clears URL immediately
 */
export function checkForTeleportInUrl() {
  const hash = window.location.hash;
  if (!hash.includes('keyteleport=')) {
    return null;
  }

  // Extract blob from fragment
  const params = new URLSearchParams(hash.slice(1));
  const blob = params.get('keyteleport');

  // Clear URL immediately (don't leave blob in history)
  history.replaceState(null, '', window.location.pathname + window.location.search);

  return blob ? decodeURIComponent(blob) : null;
}

/**
 * Decode and decrypt a teleport blob
 * Returns { encryptedNsec, npub } for unlock step
 */
export async function decodeTeleportBlob(blob) {
  const { pure, nip44 } = await loadNostrLibs();
  const instanceKey = await getInstancePrivateKey();

  // Base64 decode
  let event;
  try {
    const eventJson = atob(blob);
    event = JSON.parse(eventJson);
  } catch (err) {
    throw new Error('Invalid teleport blob format');
  }

  // Verify signature (proves authenticity)
  if (!pure.verifyEvent(event)) {
    throw new Error('Invalid signature - blob may be tampered');
  }

  // Decrypt content with instance key
  // NIP-44 auth failure = wrong key = blob isn't for us
  let decrypted;
  try {
    const conversationKey = nip44.v2.utils.getConversationKey(
      instanceKey,
      event.pubkey // Sender's pubkey
    );
    decrypted = nip44.v2.decrypt(event.content, conversationKey);
  } catch (err) {
    throw new Error('Decryption failed - this teleport link may be for a different app');
  }

  const payload = JSON.parse(decrypted);

  // Validate version
  if (payload.v !== 1) {
    throw new Error(`Unsupported protocol version: ${payload.v}`);
  }

  return {
    encryptedNsec: payload.encryptedNsec,
    npub: payload.npub,
    senderPubkey: event.pubkey,
  };
}

/**
 * Decrypt user's nsec with the throwaway unlock code
 */
export async function decryptWithUnlockCode(encryptedNsec, userNpub, unlockCode) {
  const { nip19, nip44 } = await loadNostrLibs();

  // Validate unlock code format
  if (!unlockCode || !unlockCode.startsWith('nsec1')) {
    throw new Error('Invalid unlock code format - should start with nsec1');
  }

  // Decode unlock code (throwaway nsec)
  let throwawaySecretKey;
  try {
    const decoded = nip19.decode(unlockCode);
    if (decoded.type !== 'nsec') {
      throw new Error('Not an nsec');
    }
    throwawaySecretKey = decoded.data;
  } catch (err) {
    throw new Error('Invalid unlock code format');
  }

  // Decode user's npub
  let userPubkeyHex;
  try {
    const decoded = nip19.decode(userNpub);
    if (decoded.type !== 'npub') {
      throw new Error('Not an npub');
    }
    userPubkeyHex = decoded.data;
  } catch (err) {
    throw new Error('Invalid user npub in teleport');
  }

  // Derive conversation key: throwaway + user's pubkey
  const conversationKey = nip44.v2.utils.getConversationKey(
    throwawaySecretKey,
    userPubkeyHex
  );

  // Decrypt
  let nsec;
  try {
    nsec = nip44.v2.decrypt(encryptedNsec, conversationKey);
  } catch (err) {
    throw new Error('Incorrect unlock code - please try again');
  }

  // Validate result is actually an nsec
  try {
    const decoded = nip19.decode(nsec);
    if (decoded.type !== 'nsec') {
      throw new Error('Decryption produced invalid key');
    }
  } catch (err) {
    throw new Error('Decryption failed - invalid unlock code?');
  }

  return nsec;
}
