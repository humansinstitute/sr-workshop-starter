// Nostr authentication utilities

export const LOGIN_KIND = 27235;
export const DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.devvul.com', 'wss://purplepag.es'];
export const APP_TAG = 'other-stuff-to-do';

// Storage keys
export const STORAGE_KEYS = {
  AUTO_LOGIN_METHOD: 'nostr_auto_login_method',
  AUTO_LOGIN_PUBKEY: 'nostr_auto_login_pubkey',
  EPHEMERAL_SECRET: 'nostr_ephemeral_secret',
  ENCRYPTED_SECRET: 'nostr_encrypted_secret',
  ENCRYPTED_BUNKER: 'nostr_encrypted_bunker',
  PROFILE_CACHE: 'nostr_profile_cache',
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
    content: 'Authenticate with Other Stuff To Do',
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
    let stored = localStorage.getItem(STORAGE_KEYS.EPHEMERAL_SECRET);
    if (!stored) {
      stored = bytesToHex(pure.generateSecretKey());
      localStorage.setItem(STORAGE_KEYS.EPHEMERAL_SECRET, stored);
    }
    const secret = hexToBytes(stored);
    setMemorySecret(secret);
    return pure.finalizeEvent(buildUnsignedEvent(method), secret);
  }

  if (method === 'extension') {
    if (!window.nostr?.signEvent) {
      throw new Error('No NIP-07 browser extension found.');
    }
    const event = buildUnsignedEvent(method);
    event.pubkey = await window.nostr.getPublicKey();
    return window.nostr.signEvent(event);
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

    return await signer.signEvent(buildUnsignedEvent(method));
  }

  if (method === 'secret') {
    let secret = getMemorySecret();

    if (!secret && supplemental) {
      const decodedSecret = decodeNsec(nip19, supplemental);
      secret = decodedSecret;
      setMemorySecret(secret);
    }

    if (!secret) {
      throw new Error('No secret key available.');
    }

    return pure.finalizeEvent(buildUnsignedEvent(method), secret);
  }

  throw new Error('Unsupported login method.');
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
export function clearAutoLogin() {
  localStorage.removeItem(STORAGE_KEYS.AUTO_LOGIN_METHOD);
  localStorage.removeItem(STORAGE_KEYS.AUTO_LOGIN_PUBKEY);
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

  if (!secret || !pubkey) {
    // For extension users, use NIP-07 nip44 methods
    if (window.nostr?.nip44?.encrypt) {
      const selfPubkey = await window.nostr.getPublicKey();
      return window.nostr.nip44.encrypt(selfPubkey, plaintext);
    }
    throw new Error('No encryption key available. Please log in first.');
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

  if (!secret || !pubkey) {
    // For extension users, use NIP-07 nip44 methods
    if (window.nostr?.nip44?.decrypt) {
      const selfPubkey = await window.nostr.getPublicKey();
      return window.nostr.nip44.decrypt(selfPubkey, ciphertext);
    }
    throw new Error('No decryption key available. Please log in first.');
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
