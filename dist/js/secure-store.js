// Secure credential storage using Web Crypto + Dexie
import Dexie from 'https://esm.sh/dexie@4.0.10';

const db = new Dexie('SecureAuth');

db.version(1).stores({
  credentials: 'id',  // Single row for credentials
  deviceKey: 'id',    // Single row for device encryption key
});

db.version(2).stores({
  credentials: 'id',
  deviceKey: 'id',
  profiles: 'pubkey', // Profile cache by pubkey
});

const DEVICE_KEY_ID = 'device-key';
const CRED_ID = 'primary';
const AUTH_EXPIRY_DAYS = 7;

// ===========================================
// Device Key Management (Web Crypto)
// ===========================================

async function getOrCreateDeviceKey() {
  // Try to get existing key
  const stored = await db.deviceKey.get(DEVICE_KEY_ID);
  if (stored?.key) {
    return stored.key;
  }

  // Generate new device-bound key
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false, // non-extractable - can't be exported
    ['encrypt', 'decrypt']
  );

  // Store the CryptoKey object (IndexedDB can store these)
  await db.deviceKey.put({ id: DEVICE_KEY_ID, key });
  return key;
}

async function encryptWithDeviceKey(plaintext) {
  const key = await getOrCreateDeviceKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded
  );

  // Combine IV + ciphertext
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);

  return bufferToBase64(combined);
}

async function decryptWithDeviceKey(encrypted) {
  const key = await getOrCreateDeviceKey();
  const combined = base64ToBuffer(encrypted);

  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );

  return new TextDecoder().decode(decrypted);
}

// ===========================================
// Buffer Utilities
// ===========================================

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ===========================================
// Credential Storage
// ===========================================

/**
 * Store credentials securely
 * @param {Object} creds - Credentials to store
 * @param {string} creds.method - Login method (ephemeral, secret, extension, bunker)
 * @param {string} creds.pubkey - Public key (hex)
 * @param {string} [creds.secretHex] - Secret key (hex) - for ephemeral/secret methods
 * @param {Object} [creds.authEvent] - Signed auth event - for extension method
 * @param {string} [creds.bunkerUri] - Bunker URI - for bunker method
 */
export async function storeCredentials(creds) {
  const { method, pubkey, secretHex, authEvent, bunkerUri } = creds;

  const record = {
    id: CRED_ID,
    method,
    pubkey,
    createdAt: Date.now(),
    expiresAt: Date.now() + (AUTH_EXPIRY_DAYS * 24 * 60 * 60 * 1000),
  };

  // Encrypt sensitive data with device key
  if (secretHex) {
    record.encryptedSecret = await encryptWithDeviceKey(secretHex);
  }

  if (authEvent) {
    record.authEvent = authEvent; // Already signed, no need to encrypt
  }

  if (bunkerUri) {
    record.encryptedBunkerUri = await encryptWithDeviceKey(bunkerUri);
  }

  await db.credentials.put(record);
}

/**
 * Retrieve stored credentials
 * @returns {Object|null} Decrypted credentials or null if none/expired
 */
export async function getStoredCredentials() {
  const record = await db.credentials.get(CRED_ID);
  if (!record) return null;

  // Check expiry
  if (record.expiresAt && Date.now() > record.expiresAt) {
    await clearCredentials();
    return null;
  }

  const result = {
    method: record.method,
    pubkey: record.pubkey,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };

  // Decrypt sensitive data
  try {
    if (record.encryptedSecret) {
      result.secretHex = await decryptWithDeviceKey(record.encryptedSecret);
    }

    if (record.authEvent) {
      result.authEvent = record.authEvent;
    }

    if (record.encryptedBunkerUri) {
      result.bunkerUri = await decryptWithDeviceKey(record.encryptedBunkerUri);
    }
  } catch (err) {
    console.error('Failed to decrypt credentials:', err);
    await clearCredentials();
    return null;
  }

  return result;
}

/**
 * Clear stored credentials
 */
export async function clearCredentials() {
  await db.credentials.delete(CRED_ID);
}

/**
 * Check if valid credentials exist
 */
export async function hasValidCredentials() {
  const creds = await getStoredCredentials();
  return creds !== null;
}

/**
 * Extend credential expiry (call on successful use)
 */
export async function refreshCredentialExpiry() {
  const record = await db.credentials.get(CRED_ID);
  if (record) {
    record.expiresAt = Date.now() + (AUTH_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    await db.credentials.put(record);
  }
}

// ===========================================
// Profile Cache
// ===========================================

const PROFILE_CACHE_HOURS = 24;

/**
 * Store profile in cache
 * @param {string} pubkey - Public key (hex)
 * @param {Object} profile - Profile data (name, picture, about, etc.)
 */
export async function cacheProfile(pubkey, profile) {
  await db.profiles.put({
    pubkey,
    profile,
    cachedAt: Date.now(),
  });
}

/**
 * Get cached profile
 * @param {string} pubkey - Public key (hex)
 * @returns {Object|null} Profile data or null if not cached/expired
 */
export async function getCachedProfile(pubkey) {
  const record = await db.profiles.get(pubkey);
  if (!record) return null;

  // Check if cache is still valid
  const maxAge = PROFILE_CACHE_HOURS * 60 * 60 * 1000;
  if (Date.now() - record.cachedAt > maxAge) {
    // Expired, delete and return null
    await db.profiles.delete(pubkey);
    return null;
  }

  return record.profile;
}

/**
 * Clear profile from cache
 * @param {string} pubkey - Public key (hex)
 */
export async function clearCachedProfile(pubkey) {
  await db.profiles.delete(pubkey);
}
