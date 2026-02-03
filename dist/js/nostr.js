// Nostr authentication utilities
import {
  storeCredentials,
  getStoredCredentials,
  clearCredentials,
  refreshCredentialExpiry,
  cacheProfile,
  getCachedProfile,
} from './secure-store.js';

export const LOGIN_KIND = 27235;
export const AUTH_KIND = 22242; // NIP-42 AUTH kind
export const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.devvul.com', 'wss://purplepag.es'];
export const APP_TAG = 'super-based-todo';

// Storage keys (legacy - being phased out)
export const STORAGE_KEYS = {
  AUTO_LOGIN_METHOD: 'nostr_auto_login_method',
  AUTO_LOGIN_PUBKEY: 'nostr_auto_login_pubkey',
  EPHEMERAL_SECRET: 'nostr_ephemeral_secret',
  ENCRYPTED_SECRET: 'nostr_encrypted_secret',
  ENCRYPTED_BUNKER: 'nostr_encrypted_bunker',
};

// Lazy-load nostr-tools
let nostrLibs = null;
export async function loadNostrLibs() {
  if (!nostrLibs) {
    const base = 'https://esm.sh/nostr-tools@2.7.2';
    nostrLibs = {
      pure: await import(/* @vite-ignore */ `${base}/pure`),
      nip19: await import(/* @vite-ignore */ `${base}/nip19`),
      nip44: await import(/* @vite-ignore */ `${base}/nip44`),
      nip46: await import(/* @vite-ignore */ `${base}/nip46`),
      pool: await import(/* @vite-ignore */ `${base}/pool`),
    };
  }
  return nostrLibs;
}

// Lazy-load QR code library
let qrLib = null;
export async function loadQRCodeLib() {
  if (!qrLib) {
    const mod = await import(/* @vite-ignore */ 'https://esm.sh/qrcode@1.5.3');
    qrLib = mod.default || mod;
  }
  return qrLib;
}

// Hex/bytes conversion
export function hexToBytes(hex) {
  if (!hex) return new Uint8Array();
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Decode nsec
export function decodeNsec(nip19, input) {
  try {
    const decoded = nip19.decode(input);
    if (decoded.type !== 'nsec' || !decoded.data) throw new Error('Not a valid nsec key.');
    if (decoded.data instanceof Uint8Array) return decoded.data;
    if (Array.isArray(decoded.data)) return new Uint8Array(decoded.data);
    throw new Error('Unable to read nsec payload.');
  } catch (_err) {
    throw new Error('Invalid nsec key.');
  }
}

// Build unsigned login event
export function buildUnsignedEvent(method) {
  return {
    kind: LOGIN_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['app', APP_TAG],
      ['method', method],
    ],
    content: 'Authenticate with Super Based Todo',
  };
}

// Build NIP-42 style auth event for extension persistence
export function buildAuthEvent(pubkey) {
  return {
    kind: AUTH_KIND,
    created_at: Math.floor(Date.now() / 1000),
    pubkey,
    tags: [
      ['app', APP_TAG],
      ['challenge', crypto.randomUUID()],
    ],
    content: 'Auth token for Super Based Todo',
  };
}

// In-memory secret storage (session only)
let memorySecret = null;
let memoryPubkey = null;
let memoryBunkerSigner = null;
let memoryBunkerUri = null;

export function getMemorySecret() { return memorySecret; }
export function setMemorySecret(secret) { memorySecret = secret; }
export function getMemoryPubkey() { return memoryPubkey; }
export function setMemoryPubkey(pubkey) { memoryPubkey = pubkey; }
export function getMemoryBunkerSigner() { return memoryBunkerSigner; }
export function setMemoryBunkerSigner(signer) { memoryBunkerSigner = signer; }
export function getMemoryBunkerUri() { return memoryBunkerUri; }
export function setMemoryBunkerUri(uri) { memoryBunkerUri = uri; }

export function clearMemoryCredentials() {
  memorySecret = null;
  memoryPubkey = null;
  memoryBunkerSigner = null;
  memoryBunkerUri = null;
}

// Sign login event based on method
export async function signLoginEvent(method, supplemental = null) {
  const { pure, nip19, nip46 } = await loadNostrLibs();

  if (method === 'ephemeral') {
    // Check secure storage first, then legacy localStorage
    const storedCreds = await getStoredCredentials();
    let secretHex;

    if (storedCreds?.method === 'ephemeral' && storedCreds.secretHex) {
      secretHex = storedCreds.secretHex;
    } else {
      // Check legacy storage
      const legacySecret = localStorage.getItem(STORAGE_KEYS.EPHEMERAL_SECRET);
      if (legacySecret) {
        secretHex = legacySecret;
        // Migrate to secure storage
        localStorage.removeItem(STORAGE_KEYS.EPHEMERAL_SECRET);
      } else {
        // Generate new key
        secretHex = bytesToHex(pure.generateSecretKey());
      }
    }

    const secret = hexToBytes(secretHex);
    setMemorySecret(secret);
    const event = pure.finalizeEvent(buildUnsignedEvent(method), secret);

    // Store in secure storage
    await storeCredentials({
      method: 'ephemeral',
      pubkey: event.pubkey,
      secretHex,
    });

    return event;
  }

  if (method === 'extension') {
    if (!window.nostr?.signEvent) {
      throw new Error('No NIP-07 browser extension found.');
    }
    const pubkey = await window.nostr.getPublicKey();
    const event = buildUnsignedEvent(method);
    event.pubkey = pubkey;
    const signedEvent = await window.nostr.signEvent(event);

    // Create and store auth token for persistence
    const authEvent = buildAuthEvent(pubkey);
    const signedAuth = await window.nostr.signEvent(authEvent);

    await storeCredentials({
      method: 'extension',
      pubkey,
      authEvent: signedAuth,
    });

    return signedEvent;
  }

  if (method === 'bunker') {
    let signer = getMemoryBunkerSigner();

    if (signer) {
      return await signer.signEvent(buildUnsignedEvent(method));
    }

    let bunkerUri = supplemental || getMemoryBunkerUri();
    if (!bunkerUri) {
      throw new Error('No bunker connection available.');
    }

    const pointer = await nip46.parseBunkerInput(bunkerUri);
    if (!pointer) throw new Error('Unable to parse bunker details.');

    const clientSecret = pure.generateSecretKey();
    signer = new nip46.BunkerSigner(clientSecret, pointer);
    await signer.connect();

    setMemoryBunkerSigner(signer);
    setMemoryBunkerUri(bunkerUri);

    const event = await signer.signEvent(buildUnsignedEvent(method));

    // Store bunker URI for reconnection
    await storeCredentials({
      method: 'bunker',
      pubkey: event.pubkey,
      bunkerUri,
    });

    return event;
  }

  if (method === 'secret') {
    let secret = getMemorySecret();
    let secretHex;

    if (!secret && supplemental) {
      const decodedSecret = decodeNsec(nip19, supplemental);
      secret = decodedSecret;
      secretHex = bytesToHex(secret);
      setMemorySecret(secret);
    } else if (secret) {
      secretHex = bytesToHex(secret);
    }

    if (!secret) {
      throw new Error('No secret key available.');
    }

    const event = pure.finalizeEvent(buildUnsignedEvent(method), secret);

    // Store in secure storage
    await storeCredentials({
      method: 'secret',
      pubkey: event.pubkey,
      secretHex,
    });

    return event;
  }

  throw new Error('Unsupported login method.');
}

// Attempt auto-login from secure storage
export async function tryAutoLoginFromStorage() {
  const creds = await getStoredCredentials();
  if (!creds) return null;

  const { pure } = await loadNostrLibs();

  try {
    if (creds.method === 'ephemeral' || creds.method === 'secret') {
      if (!creds.secretHex) return null;
      const secret = hexToBytes(creds.secretHex);
      setMemorySecret(secret);
      setMemoryPubkey(creds.pubkey);
      await refreshCredentialExpiry();
      return {
        pubkey: creds.pubkey,
        method: creds.method,
      };
    }

    if (creds.method === 'extension') {
      // Verify extension is available (just check existence, don't prompt)
      if (!window.nostr) return null;

      // Verify the stored auth event exists
      if (!creds.authEvent) return null;

      // Check auth event is still valid (not too old)
      const authAge = Date.now() / 1000 - creds.authEvent.created_at;
      const maxAge = 7 * 24 * 60 * 60; // 7 days in seconds
      if (authAge > maxAge) {
        await clearCredentials();
        return null;
      }

      // Verify the authEvent signature locally (no extension prompt!)
      // This proves the user authenticated with this pubkey previously
      const isValid = pure.verifyEvent(creds.authEvent);
      if (!isValid) {
        console.warn('Stored auth event signature invalid');
        await clearCredentials();
        return null;
      }

      // Verify the auth event has our app tag
      const appTag = creds.authEvent.tags.find(t => t[0] === 'app' && t[1] === APP_TAG);
      if (!appTag) {
        console.warn('Stored auth event missing app tag');
        await clearCredentials();
        return null;
      }

      // Trust the pubkey from the verified signed event
      setMemoryPubkey(creds.pubkey);
      await refreshCredentialExpiry();
      return {
        pubkey: creds.pubkey,
        method: 'extension',
      };
    }

    if (creds.method === 'bunker') {
      // Bunker needs reconnection - return info for manual reconnect
      if (!creds.bunkerUri) return null;
      setMemoryBunkerUri(creds.bunkerUri);
      // Don't auto-connect, just prepare for it
      return {
        pubkey: creds.pubkey,
        method: 'bunker',
        needsReconnect: true,
        bunkerUri: creds.bunkerUri,
      };
    }
  } catch (err) {
    console.error('Auto-login failed:', err);
    return null;
  }

  return null;
}

// Get public key from signed event
export function getPubkeyFromEvent(event) {
  return event.pubkey;
}

// Encode pubkey to npub
export async function pubkeyToNpub(pubkey) {
  const { nip19 } = await loadNostrLibs();
  return nip19.npubEncode(pubkey);
}

// Clear auto-login data
export async function clearAutoLogin() {
  // Clear legacy localStorage
  localStorage.removeItem(STORAGE_KEYS.AUTO_LOGIN_METHOD);
  localStorage.removeItem(STORAGE_KEYS.AUTO_LOGIN_PUBKEY);
  localStorage.removeItem(STORAGE_KEYS.EPHEMERAL_SECRET);
  // Clear secure storage
  await clearCredentials();
}

// Set auto-login data
export function setAutoLogin(method, pubkey) {
  localStorage.setItem(STORAGE_KEYS.AUTO_LOGIN_METHOD, method);
  localStorage.setItem(STORAGE_KEYS.AUTO_LOGIN_PUBKEY, pubkey);
}

// Get auto-login method
export function getAutoLoginMethod() {
  return localStorage.getItem(STORAGE_KEYS.AUTO_LOGIN_METHOD);
}

// Check if ephemeral secret exists
export function hasEphemeralSecret() {
  return !!localStorage.getItem(STORAGE_KEYS.EPHEMERAL_SECRET);
}

// Export nsec for ephemeral accounts
export async function exportNsec() {
  const stored = localStorage.getItem(STORAGE_KEYS.EPHEMERAL_SECRET);
  if (!stored) return null;
  const { nip19 } = await loadNostrLibs();
  const secret = hexToBytes(stored);
  return nip19.nsecEncode(secret);
}

// Generate login QR URL
export async function generateLoginQrUrl() {
  const nsec = await exportNsec();
  if (!nsec) return null;
  return `${window.location.origin}/#code=${nsec}`;
}

// Parse fragment login (nsec in URL hash)
export async function parseFragmentLogin() {
  const hash = window.location.hash;
  if (!hash.startsWith('#code=')) return null;

  const nsec = hash.slice(6);
  if (!nsec || !nsec.startsWith('nsec1')) {
    history.replaceState(null, '', window.location.pathname + window.location.search);
    return null;
  }

  history.replaceState(null, '', window.location.pathname + window.location.search);

  const { nip19 } = await loadNostrLibs();
  const secretBytes = decodeNsec(nip19, nsec);
  const secretHex = bytesToHex(secretBytes);
  localStorage.setItem(STORAGE_KEYS.EPHEMERAL_SECRET, secretHex);

  return 'ephemeral';
}

// ===========================================
// NIP-44 Encryption (encrypt to self)
// ===========================================

// Encrypt data to self using NIP-44
export async function encryptToSelf(plaintext) {
  const { nip44, pure } = await loadNostrLibs();
  const secret = getMemorySecret();
  const pubkey = getMemoryPubkey();

  // For extension users (no secret, but pubkey set from auto-login)
  if (!secret) {
    if (window.nostr?.nip44?.encrypt) {
      // Use memory pubkey if available, avoid getPublicKey() prompt
      const selfPubkey = pubkey || await window.nostr.getPublicKey();
      return window.nostr.nip44.encrypt(selfPubkey, plaintext);
    }
    throw new Error('No encryption key available. Please log in first.');
  }

  if (!pubkey) {
    throw new Error('No pubkey available. Please log in first.');
  }

  // Use nostr-tools nip44 for ephemeral/secret users
  const conversationKey = nip44.v2.utils.getConversationKey(secret, pubkey);
  return nip44.v2.encrypt(plaintext, conversationKey);
}

// Decrypt data from self using NIP-44
export async function decryptFromSelf(ciphertext) {
  const { nip44 } = await loadNostrLibs();
  const secret = getMemorySecret();
  const pubkey = getMemoryPubkey();

  // For extension users (no secret, but pubkey set from auto-login)
  if (!secret) {
    if (window.nostr?.nip44?.decrypt) {
      // Use memory pubkey if available, avoid getPublicKey() prompt
      const selfPubkey = pubkey || await window.nostr.getPublicKey();
      return window.nostr.nip44.decrypt(selfPubkey, ciphertext);
    }
    throw new Error('No decryption key available. Please log in first.');
  }

  if (!pubkey) {
    throw new Error('No pubkey available. Please log in first.');
  }

  // Use nostr-tools nip44 for ephemeral/secret users
  const conversationKey = nip44.v2.utils.getConversationKey(secret, pubkey);
  return nip44.v2.decrypt(ciphertext, conversationKey);
}

// Encrypt a JSON object
export async function encryptObject(obj) {
  const plaintext = JSON.stringify(obj);
  return encryptToSelf(plaintext);
}

// Decrypt to a JSON object
export async function decryptObject(ciphertext) {
  const plaintext = await decryptFromSelf(ciphertext);
  return JSON.parse(plaintext);
}

// ===========================================
// Profile Fetching
// ===========================================

const PROFILE_KIND = 0;
const PROFILE_FETCH_TIMEOUT = 5000;

/**
 * Fetch user profile (kind 0) from relays
 * Returns { name, picture, about, nip05, ... } or null
 */
export async function fetchProfile(pubkeyHex) {
  // Check Dexie cache first
  const cached = await getCachedProfile(pubkeyHex);
  if (cached) return cached;

  const { pool } = await loadNostrLibs();
  const relayPool = new pool.SimplePool();

  try {
    const filter = {
      kinds: [PROFILE_KIND],
      authors: [pubkeyHex],
      limit: 1,
    };

    // Query relays with timeout
    const events = await Promise.race([
      relayPool.querySync(DEFAULT_RELAYS, filter),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Timeout')), PROFILE_FETCH_TIMEOUT)
      ),
    ]);

    if (events && events.length > 0) {
      // Get most recent profile event
      const latest = events.reduce((a, b) =>
        (a.created_at > b.created_at) ? a : b
      );

      try {
        const profile = JSON.parse(latest.content);
        // Cache the profile in Dexie
        await cacheProfile(pubkeyHex, profile);
        return profile;
      } catch {
        console.error('Failed to parse profile content');
        return null;
      }
    }

    return null;
  } catch (err) {
    console.error('Failed to fetch profile:', err);
    return null;
  } finally {
    relayPool.close(DEFAULT_RELAYS);
  }
}
