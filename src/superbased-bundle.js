// SuperBased SDK bundle - exact copy of ctxcn SuperbasedClient pattern
// All SDK usage stays inside this bundle to avoid window export issues

import { Client } from '@modelcontextprotocol/sdk/client';
import {
  NostrClientTransport,
  PrivateKeySigner,
  ApplesauceRelayPool,
} from '@contextvm/sdk';
import { nip19, verifyEvent } from 'nostr-tools';
import { bytesToHex } from '@noble/hashes/utils';

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

// Export to window
window.SuperBasedSDK = {
  createClient,
  parseToken,
  verifyEvent,
  nip19,
  bytesToHex,
};

console.log('SuperBased SDK loaded');
