// Main Alpine.js application
import Alpine from 'https://esm.sh/alpinejs@3.14.8';
import { createTodo, getTodosByOwner, updateTodo, deleteTodo, transitionTodoState, getAiReviewsByOwner } from './db.js';
import snarkdown from 'https://esm.sh/snarkdown@2.0.0';
import {
  signLoginEvent,
  getPubkeyFromEvent,
  pubkeyToNpub,
  clearAutoLogin,
  setAutoLogin,
  getAutoLoginMethod,
  hasEphemeralSecret,
  exportNsec,
  generateLoginQrUrl,
  parseFragmentLogin,
  loadQRCodeLib,
  clearMemoryCredentials,
  setMemoryPubkey,
  tryAutoLoginFromStorage,
  fetchProfile,
  loadNostrLibs,
  getMemorySecret,
  getMemoryPubkey,
  bytesToHex,
  STORAGE_KEYS,
} from './nostr.js';
import {
  ALLOWED_STATE_TRANSITIONS,
  formatStateLabel,
  formatPriorityLabel,
  formatTransitionLabel,
  formatAvatarFallback,
  parseTags,
  formatTags,
} from './utils.js';
import {
  getInstanceNpub,
  generateRegistrationBlob,
  checkForTeleportInUrl,
  decodeTeleportBlob,
  decryptWithUnlockCode,
} from './keyteleport.js';
import {
  SuperBasedClient,
  parseToken,
  performSync,
} from './superbased.js';
import { SyncNotifier, DelegationNotifier } from './sync-notifier.js';
import {
  publishSuperBasedToken,
  fetchSuperBasedTokenByApp,
  fetchAllSuperBasedTokens,
  deleteSuperBasedToken,
} from './superbased-nostr.js';

// Configure this per deployment - the expected app identity for token lookup
// Set both to enable direct lookup, or leave null to fetch all and use if exactly 1
const EXPECTED_APP_NPUB = null; // e.g., 'npub1abc...'
const EXPECTED_BACKEND_URL = null; // e.g., 'https://superbasedtodo.ritoh.com'

// Make Alpine available globally for debugging
window.Alpine = Alpine;

// Main app store
Alpine.store('app', {
  // Auth state
  session: null,
  isLoggingIn: false,
  loginError: null,
  profile: null, // { name, picture, about, nip05, ... }

  // Todos
  todos: [],
  filterTags: [],
  showArchive: false,

  // UI state
  showAvatarMenu: false,
  showQrModal: false,
  showProfileModal: false,
  justSavedTodoId: null,

  // Key Teleport state
  showTeleportSetupModal: false,
  showTeleportUnlockModal: false,
  instanceNpub: '',
  teleportNpub: '',
  teleportUnlockCode: '',
  teleportError: null,
  isProcessingTeleport: false,
  pendingTeleport: null, // Stores { encryptedNsec, npub } during unlock

  // SuperBased state
  showSuperBasedModal: false,
  superbasedTokenInput: '',
  superbasedError: null,
  superbasedConnected: false,
  isSavingSuperBased: false,
  isSyncing: false,
  useCvmSync: localStorage.getItem('use_cvm_sync') === 'true',

  // Agent Connect
  showAgentConnectModal: false,
  agentConnectJson: '',
  agentConfigCopied: false,
  lastSyncTime: null,
  superbasedClient: null,
  syncNotifier: null,
  delegationNotifier: null,
  syncPollInterval: null,
  // Sync status tracking
  hasUnsyncedChanges: false,
  lastLocalChangeTime: null,
  lastSuccessfulSyncTime: null,

  // Delegation state
  showDelegationsModal: false,
  delegations: [],
  newDelegateNpub: '',
  delegatePermRead: true,
  delegatePermWrite: false,
  delegationError: null,
  isLoadingDelegations: false,
  delegatedTodos: [],
  delegateProfiles: {},

  // AI Reviews
  aiReviews: [],
  aiReviewIndex: 0,

  // Edit modal
  editModalTodoId: null,

  // New todo input
  newTodoTitle: '',

  // Computed
  get isLoggedIn() {
    return !!this.session;
  },

  get activeTodos() {
    let todos = this.todos.filter(t => t.state !== 'done' && !t.deleted);
    if (this.filterTags.length > 0) {
      todos = todos.filter(t => {
        const todoTags = parseTags(t.tags);
        return this.filterTags.some(ft => todoTags.includes(ft.toLowerCase()));
      });
    }
    return todos;
  },

  get doneTodos() {
    let todos = this.todos.filter(t => t.state === 'done' && !t.deleted);
    if (this.filterTags.length > 0) {
      todos = todos.filter(t => {
        const todoTags = parseTags(t.tags);
        return this.filterTags.some(ft => todoTags.includes(ft.toLowerCase()));
      });
    }
    return todos;
  },

  get allTags() {
    const tagSet = new Set();
    this.todos.filter(t => !t.deleted).forEach(t => {
      parseTags(t.tags).forEach(tag => tagSet.add(tag));
    });
    return Array.from(tagSet).sort();
  },


  // Sync status: 'disconnected' | 'syncing' | 'unsynced' | 'synced'
  get syncStatus() {
    if (!this.superbasedConnected) return 'disconnected';
    if (this.isSyncing) return 'syncing';
    if (this.hasUnsyncedChanges) return 'unsynced';
    return 'synced';
  },

  get avatarFallback() {
    return formatAvatarFallback(this.session?.npub);
  },

  get displayName() {
    if (this.profile?.name) return this.profile.name;
    if (this.profile?.display_name) return this.profile.display_name;
    if (this.session?.npub) return this.session.npub.slice(0, 12) + '...';
    return 'Anonymous';
  },

  get avatarUrl() {
    return this.profile?.picture || null;
  },

  get remainingText() {
    if (!this.isLoggedIn) return '';
    const count = this.activeTodos.length;
    return count === 0 ? 'All clear.' : `${count} left to go.`;
  },

  // Actions
  async init() {
    // Check for Key Teleport first (highest priority)
    const teleportBlob = checkForTeleportInUrl();
    if (teleportBlob) {
      await this.handleIncomingTeleport(teleportBlob);
      return;
    }

    // Check for fragment login
    const fragmentMethod = await parseFragmentLogin();
    if (fragmentMethod) {
      await this.login(fragmentMethod);
      return;
    }

    // Try auto-login
    await this.maybeAutoLogin();

    // Check for existing SuperBased connection
    await this.checkSuperBasedConnection();

    // Open todo from URL if ?todo=<id> is present
    this.openTodoFromUrl();

    // Handle browser back/forward
    window.addEventListener('popstate', () => {
      const params = new URLSearchParams(window.location.search);
      const todoId = params.get('todo');
      if (todoId && this.todos.some(t => t.record_id === todoId)) {
        this.editModalTodoId = todoId;
      } else {
        this.editModalTodoId = null;
      }
    });
  },

  async maybeAutoLogin() {
    // Try new secure storage first
    const storedAuth = await tryAutoLoginFromStorage();
    if (storedAuth) {
      // Handle bunker reconnection
      if (storedAuth.needsReconnect && storedAuth.method === 'bunker') {
        // Auto-reconnect to bunker
        try {
          await this.login('bunker', storedAuth.bunkerUri);
          return;
        } catch (err) {
          console.error('Bunker reconnect failed:', err);
          // Fall through to manual login
        }
      } else {
        // Direct restore for ephemeral/secret/extension
        const npub = await pubkeyToNpub(storedAuth.pubkey);
        this.session = {
          pubkey: storedAuth.pubkey,
          npub,
          method: storedAuth.method,
        };
        setMemoryPubkey(storedAuth.pubkey);
        await this.loadTodos();
        // Fetch profile in background
        this.loadProfile(storedAuth.pubkey);
        // Check for saved SuperBased token and start background sync
        this.initBackgroundSync();
        return;
      }
    }

    // Fall back to legacy auto-login
    const method = getAutoLoginMethod();
    if (!method) return;

    if (method === 'ephemeral' && hasEphemeralSecret()) {
      await this.login('ephemeral');
    }
  },

  async login(method, supplemental = null) {
    this.isLoggingIn = true;
    this.loginError = null;

    try {
      const signedEvent = await signLoginEvent(method, supplemental);
      const pubkey = getPubkeyFromEvent(signedEvent);
      const npub = await pubkeyToNpub(pubkey);

      // Set pubkey for NIP-44 encryption
      setMemoryPubkey(pubkey);

      this.session = {
        pubkey,
        npub,
        method,
      };

      setAutoLogin(method, pubkey);
      await this.loadTodos();

      // Fetch profile in background (don't block login)
      this.loadProfile(pubkey);

      // Check for saved SuperBased token and start background sync
      this.initBackgroundSync();
    } catch (err) {
      console.error('Login failed:', err);
      this.loginError = err.message || 'Login failed.';
    } finally {
      this.isLoggingIn = false;
    }
  },

  async logout() {
    // Stop auto-sync if running
    this.stopAutoSync();

    // Clean up notifiers
    if (this.syncNotifier) {
      this.syncNotifier.destroy();
      this.syncNotifier = null;
    }
    if (this.delegationNotifier) {
      this.delegationNotifier.destroy();
      this.delegationNotifier = null;
    }

    // Clear all local data
    try {
      // Clear IndexedDB
      const { db } = await import('./db.js');
      await db.todos.clear();
      console.log('Cleared IndexedDB todos');

      // Clear all localStorage
      localStorage.clear();
      console.log('Cleared localStorage');

      // Clear service worker caches
      if ('caches' in window) {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames.map(name => caches.delete(name)));
        console.log('Cleared service worker caches');
      }

      // Unregister service worker
      if ('serviceWorker' in navigator) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map(reg => reg.unregister()));
        console.log('Unregistered service workers');
      }
    } catch (err) {
      console.error('Error clearing data:', err);
    }

    // Reset app state
    this.session = null;
    this.profile = null;
    this.todos = [];
    this.filterTags = [];
    this.showAvatarMenu = false;
    this.superbasedClient = null;
    this.superbasedConnected = false;
    await clearAutoLogin();
    clearMemoryCredentials();

    // Reload page for clean state
    window.location.reload();
  },

  async loadProfile(pubkeyHex) {
    try {
      const profile = await fetchProfile(pubkeyHex);
      if (profile) {
        this.profile = profile;
      }
    } catch (err) {
      console.error('Failed to load profile:', err);
    }
  },

  async loadTodos() {
    if (!this.session?.npub) return;

    this.todos = await getTodosByOwner(this.session.npub);
    await this.loadAiReviews();

    // Check SuperBased connection after todos are loaded
    if (!this.superbasedClient) {
      await this.checkSuperBasedConnection();
    }
  },

  async addTodo() {
    if (!this.newTodoTitle.trim() || !this.session?.npub) return;

    await createTodo({
      title: this.newTodoTitle.trim(),
      owner: this.session.npub,
    });

    this.newTodoTitle = '';
    await this.loadTodos();

    // Mark as having unsynced changes
    this.hasUnsyncedChanges = true;
    this.lastLocalChangeTime = Date.now();

    // Auto-sync if connected
    if (this.superbasedClient && !this.isSyncing) {
      this.syncNow();
    }
  },

  async updateTodoField(id, field, value) {
    await updateTodo(id, { [field]: value });
    await this.loadTodos();

    // Mark as having unsynced changes
    this.hasUnsyncedChanges = true;
    this.lastLocalChangeTime = Date.now();

    // Auto-sync if connected
    if (this.superbasedClient && !this.isSyncing) {
      this.syncNow();
    }
  },

  async transitionState(id, newState) {
    await transitionTodoState(id, newState);
    await this.loadTodos();

    // Mark as having unsynced changes
    this.hasUnsyncedChanges = true;
    this.lastLocalChangeTime = Date.now();

    // Auto-sync if connected
    if (this.superbasedClient && !this.isSyncing) {
      this.syncNow();
    }
  },

  async deleteTodoItem(id) {
    this.closeEditModal();
    await deleteTodo(id);
    await this.loadTodos();

    // Mark as having unsynced changes
    this.hasUnsyncedChanges = true;
    this.lastLocalChangeTime = Date.now();

    // Auto-sync if connected
    if (this.superbasedClient && !this.isSyncing) {
      this.syncNow();
    }
  },

  toggleTag(tag) {
    const idx = this.filterTags.indexOf(tag.toLowerCase());
    if (idx >= 0) {
      this.filterTags.splice(idx, 1);
    } else {
      this.filterTags.push(tag.toLowerCase());
    }
  },

  clearFilters() {
    this.filterTags = [];
  },

  isTagActive(tag) {
    return this.filterTags.includes(tag.toLowerCase());
  },

  // Edit modal methods
  openEditModal(todoId) {
    this.editModalTodoId = todoId;
    const url = new URL(window.location);
    url.searchParams.set('todo', todoId);
    history.pushState({ todo: todoId }, '', url);
  },

  closeEditModal() {
    if (!this.editModalTodoId) return;
    this.editModalTodoId = null;
    const url = new URL(window.location);
    url.searchParams.delete('todo');
    history.pushState({}, '', url);
  },

  // Check URL for ?todo=<id> and open that modal
  openTodoFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const todoId = params.get('todo');
    if (todoId && this.todos.some(t => t.record_id === todoId)) {
      this.editModalTodoId = todoId;
    }
  },

  async copyTodoLink(todoId) {
    const url = new URL(window.location);
    url.searchParams.set('todo', todoId);
    try {
      await navigator.clipboard.writeText(url.toString());
    } catch {
      prompt('Copy link:', url.toString());
    }
  },

  toggleArchive() {
    this.showArchive = !this.showArchive;
  },

  getTransitions(state) {
    return ALLOWED_STATE_TRANSITIONS[state] || [];
  },

  formatState: formatStateLabel,
  formatPriority: formatPriorityLabel,
  formatTransition: formatTransitionLabel,
  parseTags,  // Expose for live template rendering

  async copyId() {
    if (!this.session?.npub) return;
    this.showAvatarMenu = false;
    try {
      await navigator.clipboard.writeText(this.session.npub);
      alert('ID copied to clipboard.');
    } catch {
      prompt('Copy your ID:', this.session.npub);
    }
  },

  async exportSecret() {
    if (this.session?.method !== 'ephemeral') {
      alert('Export is only available for ephemeral accounts.');
      return;
    }
    this.showAvatarMenu = false;
    const nsec = await exportNsec();
    if (!nsec) {
      alert('No secret key found.');
      return;
    }
    try {
      await navigator.clipboard.writeText(nsec);
      alert('Secret key copied! Keep it safe.');
    } catch {
      prompt('Copy your secret key:', nsec);
    }
  },

  async showLoginQr() {
    // Allow QR login for sessions that have access to the decrypted nsec in memory
    // - ephemeral: generated on sign up
    // - secret: BYO nsec or Key Teleport (which uses 'secret' internally)
    const allowedMethods = ['ephemeral', 'secret'];
    if (!allowedMethods.includes(this.session?.method)) {
      alert('Login QR is only available for accounts with a local secret key.');
      return;
    }
    this.showAvatarMenu = false;
    const url = await generateLoginQrUrl();
    if (!url) {
      alert('No secret key found.');
      return;
    }
    try {
      const QRCode = await loadQRCodeLib();
      const container = document.querySelector('[data-qr-container]');
      if (container) {
        container.innerHTML = '';
        const canvas = document.createElement('canvas');
        await QRCode.toCanvas(canvas, url, { width: 256, margin: 2 });
        container.appendChild(canvas);
      }
      this.showQrModal = true;
    } catch (err) {
      console.error('Failed to generate QR:', err);
      alert('Failed to generate QR code.');
    }
  },

  // ===========================================
  // Key Teleport Methods
  // ===========================================

  async setupKeyTeleport() {
    try {
      // Generate registration blob (creates instance key if needed)
      const blob = await generateRegistrationBlob();

      // Copy to clipboard
      await navigator.clipboard.writeText(blob);

      // Get instance npub for display
      this.instanceNpub = await getInstanceNpub();

      // Show confirmation modal
      this.showTeleportSetupModal = true;
    } catch (err) {
      console.error('Key Teleport setup failed:', err);
      this.loginError = 'Failed to generate teleport registration: ' + err.message;
    }
  },

  async handleIncomingTeleport(blob) {
    try {
      // Decode and decrypt the blob
      const { encryptedNsec, npub } = await decodeTeleportBlob(blob);

      // Store pending teleport data
      this.pendingTeleport = { encryptedNsec, npub };
      this.teleportNpub = npub;
      this.teleportUnlockCode = '';
      this.teleportError = null;

      // Show unlock modal
      this.showTeleportUnlockModal = true;

      // Try to auto-paste from clipboard
      try {
        const clipText = await navigator.clipboard.readText();
        if (clipText && clipText.startsWith('nsec1')) {
          this.teleportUnlockCode = clipText;
        }
      } catch {
        // Clipboard access denied, user will paste manually
      }
    } catch (err) {
      console.error('Key Teleport decode failed:', err);
      this.loginError = err.message;
    }
  },

  async completeTeleport() {
    if (!this.pendingTeleport || !this.teleportUnlockCode) {
      this.teleportError = 'Please enter the unlock code';
      return;
    }

    this.isProcessingTeleport = true;
    this.teleportError = null;

    try {
      // Decrypt the user's nsec
      const nsec = await decryptWithUnlockCode(
        this.pendingTeleport.encryptedNsec,
        this.pendingTeleport.npub,
        this.teleportUnlockCode
      );

      // Close modal
      this.showTeleportUnlockModal = false;

      // Login with the decrypted nsec (uses existing 'secret' flow)
      await this.login('secret', nsec);

      // Clear sensitive data
      this.pendingTeleport = null;
      this.teleportUnlockCode = '';
    } catch (err) {
      console.error('Key Teleport unlock failed:', err);
      this.teleportError = err.message;
    } finally {
      this.isProcessingTeleport = false;
    }
  },

  cancelTeleport() {
    this.showTeleportUnlockModal = false;
    this.pendingTeleport = null;
    this.teleportUnlockCode = '';
    this.teleportError = null;
  },

  // ===========================================
  // SuperBased Sync Methods
  // ===========================================

  openSuperBasedSettings() {
    this.showAvatarMenu = false;
    // Load existing token if any
    const existingToken = localStorage.getItem('superbased_token');
    if (existingToken) {
      this.superbasedTokenInput = existingToken;
    }
    this.superbasedError = null;
    this.showSuperBasedModal = true;
  },

  // Agent Connect - show connection config for AI agents
  async showAgentConnect() {
    this.showAvatarMenu = false;
    this.agentConfigCopied = false;

    // Decode appNpub to hex pubkey so agents don't need to convert
    const appNpub = this.superbasedClient?.config?.appNpub || '';
    let appPubkey = '';
    if (appNpub) {
      try {
        const { nip19 } = await loadNostrLibs();
        const decoded = nip19.decode(appNpub);
        appPubkey = decoded.data;
      } catch (e) {
        console.warn('Could not decode appNpub:', e);
      }
    }

    // Build the config JSON
    const config = {
      agentConnectGuide: `${window.location.origin}/agentconnect.md`,
      superbasedURL: this.superbasedClient?.config?.httpUrl || '',
      appNpub,
      appPubkey,
      ownerPubkey: this.session?.pubkey || '',
      ownerNpub: this.session?.npub || '',
    };

    this.agentConnectJson = JSON.stringify(config, null, 2);
    this.showAgentConnectModal = true;
  },

  async copyAgentConfig() {
    try {
      await navigator.clipboard.writeText(this.agentConnectJson);
      this.agentConfigCopied = true;
      setTimeout(() => {
        this.agentConfigCopied = false;
      }, 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  },

  // Hardcoded OtherStuff Superbased token for workshop (superbased-sync)
  OTHERSTUFF_TOKEN: 'eyJraW5kIjozMDA3OCwiY3JlYXRlZF9hdCI6MTc3MDgwMDAyMiwidGFncyI6W1siZCIsInN1cGVyYmFzZWQtdG9rZW4iXSxbImFwcCIsIm5wdWIxNTh6M3FyMzh5dmR2bTd3eGR3dWc3bDlnNDc5NmpjcHVma3c0bnF1MnNlZmdqMDhrdjMzczJ3YXgzNSJdLFsic2VydmVyIiwibnB1YjE0Z2s1MHdwd3BldGE4ZmZrNmY0NnhsdDV5NHlwdXNwd3RlMjBlazR0OXltMzl1djh0dGRzNHVuNm11Il0sWyJyZWxheSIsImN2bS5vdGhlcnN0dWZmLmFpIl0sWyJhdHRlc3RhdGlvbiIsImV5SnJhVzVrSWpvek1EQTNPU3dpWTNKbFlYUmxaRjloZENJNk1UYzNNRGd3TURBd01pd2lkR0ZuY3lJNlcxc2laQ0lzSW5OMWNHVnlZbUZ6WldRdGNtVm5hWE4wY21GMGFXOXVJbDBzV3lKelpYSjJaWElpTENKdWNIVmlNVFJuYXpVd2QzQjNjR1YwWVRobVptczJaalEyZUd4ME5YazBlWEIxYzNCM2RHVXlNR1ZyTkhRNWVXMHpPWFYyT0hSMFpITTBkVzQyYlhVaVhTeGJJbTVoYldVaUxDSnpkWEJpWVhObFpDMXplVzVqSWwxZExDSmpiMjUwWlc1MElqb2lJaXdpY0hWaWEyVjVJam9pWVRGak5URXdNR1V5TnpJek1XRmpaR1k1WXpZMlltSTRPR1kzWTJFNFlXWTRZbUU1TmpBell6UmtPV1ExT1Rnek9HRTROalV5T0RrelkyWTJOalEyTXlJc0ltbGtJam9pWTJRd01tWm1ZamRtTTJNeE5qZzBPVGc1WVRZeE9UQTJZamd4TmpjM09URmtNalZrWm1Vd05HUXhObVkwTUdGbU4ySTNOVGszTVdZNVltRTNNVEE0WkNJc0luTnBaeUk2SW1VM09UZG1NbVkzWkRFeU5UZzJZelF4T1RneE5qZ3hOREppTmpnNE1XRXpaalV4WkRJd05UZ3dNelZpWXpkaU9UVXhZV1F4WkRabU5HWTBOelUxTVRoa1ptWTFZakJrWXprek9EQmxNREEzTmpFeU1HSmtaR1F5TVRsbE1qQTRNekE0TkRJellqVTNaalprWVRKak4yTTFPRGc1TmpRNU5qTXpNekk1TlRKa0luMD0iXSxbImh0dHAiLCJodHRwczovL3NiLm90aGVyc3R1ZmYuc3R1ZGlvIl1dLCJjb250ZW50IjoiIiwicHVia2V5IjoiYWEyZDQ3YjgyZTBlNTdkM2E1MzZkMjZiYTM3ZDc0MjU0ODFlNDAyZTVlNTRmY2RhYWIyOTM3MTJmMTg3NWFkYiIsImlkIjoiMGMxZWY5ZTAxYTdhOWFkYzU5OTIzMDNkMWI5ZWRkY2E3NDVmYzc4ZWY5NzhhNDdhYjZhNjJiN2U1Nzc4NmNhOCIsInNpZyI6IjBhMWQ3MDQ5YWE3NWI1NDJmNjdmZTdjYjBhNGRlY2YzMjM0MTQ3M2U2YjEwYzE0YjBlMTgzMTZhN2M1YjhkMzIwNDg0MjY1ZDlkNDg3NTBlNDNjYjRmYWRlYTMwMjViZjM5YzVkYWZkZTNmNDhhY2U4NzdlMDIzODZlNDc4YzNlIn0=',

  async toggleCvmSync() {
    this.useCvmSync = !this.useCvmSync;
    localStorage.setItem('use_cvm_sync', this.useCvmSync.toString());

    // Reconnect seamlessly with new transport (keep same token)
    if (this.superbasedConnected) {
      const token = localStorage.getItem('superbased_token') || this.OTHERSTUFF_TOKEN;
      this.stopAutoSync();

      try {
        const client = await this.createSyncClient(token);
        await client.whoami();
        this.superbasedClient = client;
        console.log(`SuperBased: Switched to ${client.isCvm ? 'CVM relay' : 'HTTPS'} transport`);
        this.startAutoSync();
      } catch (err) {
        console.error('SuperBased: Failed to switch transport:', err);
        this.superbasedError = `Transport switch failed: ${err.message}`;
      }
    }
  },

  getCvmSignerOptions() {
    const secret = getMemorySecret();
    if (secret) {
      return { privateKeyHex: bytesToHex(secret) };
    }
    const pubkey = getMemoryPubkey();
    if (pubkey && window.nostr) {
      return { extensionPubkey: pubkey };
    }
    throw new Error('No signing method available for CVM');
  },

  async createSyncClient(token) {
    if (this.useCvmSync && window.SuperBasedSDK?.createCvmSyncAdapter) {
      const signerOpts = this.getCvmSignerOptions();
      return window.SuperBasedSDK.createCvmSyncAdapter(token, signerOpts);
    }
    return new SuperBasedClient(token);
  },

  async connectWithOtherStuff() {
    this.superbasedTokenInput = this.OTHERSTUFF_TOKEN;
    await this.saveSuperBasedToken();
  },

  async saveSuperBasedToken() {
    const token = this.superbasedTokenInput.trim();
    if (!token) {
      this.superbasedError = 'Please paste a token';
      return;
    }


    this.isSavingSuperBased = true;
    this.superbasedError = null;

    try {
      // Validate token by parsing it
      const config = parseToken(token);
      if (!config.isValid) {
        throw new Error('Invalid token - missing attestation');
      }

      // Try to create client and test connection
      const client = await this.createSyncClient(token);
      const whoami = await client.whoami();
      console.log(`SuperBased: Connected${client.isCvm ? ' via CVM' : ''} as`, whoami.npub || whoami.status || 'OK');

      // Save token locally
      localStorage.setItem('superbased_token', token);
      this.superbasedClient = client;
      this.superbasedConnected = true;

      // Publish token to Nostr for cross-device sync (in background)
      if (config.appNpub && config.httpUrl) {
        publishSuperBasedToken(token, config.appNpub, config.httpUrl).catch(err => {
          console.error('SuperBased: Failed to publish token to Nostr:', err);
          // Non-fatal - local storage still works
        });
      }

      // Start auto-sync (polling + visibility)
      this.startAutoSync();

      // Close modal immediately, sync in background
      this.showSuperBasedModal = false;

      // Do initial sync in background
      this.syncNow().catch(err => {
        console.error('Initial sync failed:', err);
      });
    } catch (err) {
      console.error('SuperBased token error:', err);
      this.superbasedError = err.message || 'Failed to connect';
    } finally {
      this.isSavingSuperBased = false;
    }
  },

  async initSuperBasedClient(token) {
    try {
      const client = await this.createSyncClient(token);
      // Test connection
      await client.whoami();
      this.superbasedClient = client;
      console.log(`SuperBased: Client initialized${client.isCvm ? ' (CVM relay transport)' : ''}`);

      // Load delegations so addTodo() can derive delegates (don't block)
      this.loadDelegations().catch(err => {
        console.error('SuperBased: Failed to load delegations on init:', err);
      });

      // Initialize SyncNotifier in background (don't block connection)
      const config = parseToken(token);
      if (config.appNpub) {
        this.initSyncNotifier(config.appNpub);
      }
    } catch (err) {
      console.error('SuperBased: Failed to initialize client:', err);
      this.superbasedClient = null;
      this.superbasedConnected = false;
      throw err;
    }
  },

  // Initialize SyncNotifier in background
  async initSyncNotifier(appNpub) {
    try {
      this.syncNotifier = new SyncNotifier(appNpub);
      await this.syncNotifier.init();

      // Subscribe to notifications from other devices
      this.syncNotifier.startSubscription(async (payload) => {
        console.log('SuperBased: Received sync notification, fetching updates...');
        await this.syncNow(true);
      });

      console.log('SuperBased: SyncNotifier ready');
    } catch (err) {
      console.error('SuperBased: SyncNotifier failed (non-fatal):', err);
      // Don't fail the connection, just disable real-time notifications
      this.syncNotifier = null;
    }

    // Initialize DelegationNotifier for task assignment notifications
    try {
      this.delegationNotifier = new DelegationNotifier(appNpub);
      await this.delegationNotifier.init();
      console.log('SuperBased: DelegationNotifier ready');
    } catch (err) {
      console.error('SuperBased: DelegationNotifier failed (non-fatal):', err);
      this.delegationNotifier = null;
    }
  },

  // Initialize background sync from saved token (called on auto-login)
  // Alias for checkSuperBasedConnection - kept for compatibility
  async initBackgroundSync() {
    return this.checkSuperBasedConnection();
  },

  // Start auto-sync polling (always runs in background)
  startAutoSync() {
    if (!this.syncPollInterval) {
      this.syncPollInterval = setInterval(() => {
        if (this.superbasedClient && !this.isSyncing) {
          this.syncNow(true).catch(() => {});
        }
      }, 3000);
    }
  },

  // Stop auto-sync
  stopAutoSync() {
    if (this.syncPollInterval) {
      clearInterval(this.syncPollInterval);
      this.syncPollInterval = null;
    }
  },

  async disconnectSuperBased(deleteFromNostr = false) {
    // Stop auto-sync
    this.stopAutoSync();

    // Clean up SyncNotifier
    if (this.syncNotifier) {
      this.syncNotifier.destroy();
      this.syncNotifier = null;
    }

    // Clean up DelegationNotifier
    if (this.delegationNotifier) {
      this.delegationNotifier.destroy();
      this.delegationNotifier = null;
    }

    // Optionally delete from Nostr
    if (deleteFromNostr && this.superbasedClient) {
      const { appNpub, httpUrl } = this.superbasedClient.config || {};
      if (appNpub && httpUrl) {
        deleteSuperBasedToken(appNpub, httpUrl).catch(err => {
          console.error('SuperBased: Failed to delete token from Nostr:', err);
        });
      }
    }

    localStorage.removeItem('superbased_token');
    localStorage.removeItem('superbased_last_sync');
    this.superbasedConnected = false;
    this.superbasedClient = null;
    this.superbasedTokenInput = '';
    this.lastSyncTime = null;
    this.lastSuccessfulSyncTime = null;
    this.lastLocalChangeTime = null;
    this.hasUnsyncedChanges = false;
    this.showSuperBasedModal = false;
  },

  async syncNow(skipNotify = false) {
    if (!this.superbasedClient || !this.session?.npub) return;
    if (this.isSyncing) return; // Prevent concurrent syncs

    this.isSyncing = true;
    const syncStartTime = Date.now();

    try {
      const delegatePubkeys = this.delegations
        .filter(d => d.delegate_pubkey)
        .map(d => d.delegate_pubkey);
      const result = await performSync(this.superbasedClient, this.session.npub, delegatePubkeys);

      // Update last sync time for display
      this.lastSyncTime = new Date().toLocaleString();
      this.lastSuccessfulSyncTime = Date.now();

      // Clear unsynced flag if no local changes occurred during sync
      if (!this.lastLocalChangeTime || this.lastLocalChangeTime <= syncStartTime) {
        this.hasUnsyncedChanges = false;
      }

      // Reload UI if we pulled, updated, or deleted records (avoids unnecessary redraws)
      if (result.pulled > 0 || result.updated > 0 || result.deletedLocally > 0 ||
          result.aiReviewsPulled > 0 || result.aiReviewsUpdated > 0) {
        this.todos = await getTodosByOwner(this.session.npub);
        await this.loadAiReviews();
      }

      // Notify other devices if we pushed changes
      if (!skipNotify && this.syncNotifier && result.pushed > 0) {
        await this.syncNotifier.publish();
      }

    } catch (err) {
      // Silent fail for background polling, but keep hasUnsyncedChanges true
      if (!skipNotify) {
        this.superbasedError = err.message;
      }
    } finally {
      this.isSyncing = false;
    }
  },

  async checkSuperBasedConnection() {
    // WORKSHOP MODE: Always use hardcoded token
    let token = this.OTHERSTUFF_TOKEN;

    if (token && this.session?.npub) {
      try {
        const config = parseToken(token);
        if (config.isValid) {
          await this.initSuperBasedClient(token);
          this.superbasedConnected = true;
          this.superbasedTokenInput = token;

          // Start auto-sync
          this.startAutoSync();

          // Initial sync on restore
          this.syncNow(true).catch(err => console.error('Restore sync failed:', err));
        }
      } catch (err) {
        console.error('Failed to restore SuperBased connection:', err);
        // Token might be invalid or server down - don't remove it, just mark disconnected
        this.superbasedConnected = false;
      }
    }
  },

  async tryFetchTokenFromNostr() {
    try {
      // If we have a specific expected app identity, query for that directly
      if (EXPECTED_APP_NPUB && EXPECTED_BACKEND_URL) {
        console.log('SuperBased: Checking Nostr for token (app:', EXPECTED_APP_NPUB, ', URL:', EXPECTED_BACKEND_URL, ')');
        const payload = await fetchSuperBasedTokenByApp(EXPECTED_APP_NPUB, EXPECTED_BACKEND_URL);
        if (payload?.token) {
          console.log('SuperBased: Found token on Nostr for this app');
          // Save locally for future use
          localStorage.setItem('superbased_token', payload.token);
          return payload.token;
        }
        return null;
      }

      // No specific app configured - fetch all tokens and check count
      console.log('SuperBased: Checking Nostr for any stored tokens');
      const tokens = await fetchAllSuperBasedTokens();

      if (tokens.length === 0) {
        console.log('SuperBased: No tokens found on Nostr');
        return null;
      }

      if (tokens.length === 1) {
        console.log('SuperBased: Found exactly 1 token on Nostr, using it');
        // Save locally for future use
        localStorage.setItem('superbased_token', tokens[0].token);
        return tokens[0].token;
      }

      // Multiple tokens found - can't auto-select
      console.warn('SuperBased: Multiple tokens found on Nostr (' + tokens.length + '). Please add token manually.');
      return null;
    } catch (err) {
      console.error('SuperBased: Failed to fetch token from Nostr:', err);
      return null;
    }
  },

  // ===========================================
  // AI Review Methods
  // ===========================================

  async loadAiReviews() {
    if (!this.session?.npub) return;
    const reviews = await getAiReviewsByOwner(this.session.npub);
    // Sort by date descending (newest first)
    reviews.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    this.aiReviews = reviews;
    // Clamp index
    if (this.aiReviewIndex >= this.aiReviews.length) {
      this.aiReviewIndex = Math.max(0, this.aiReviews.length - 1);
    }
  },

  get currentReview() {
    if (this.aiReviews.length === 0) return null;
    return this.aiReviews[this.aiReviewIndex] || null;
  },

  prevReview() {
    if (this.aiReviewIndex > 0) this.aiReviewIndex--;
  },

  nextReview() {
    if (this.aiReviewIndex < this.aiReviews.length - 1) this.aiReviewIndex++;
  },

  renderMarkdown(md) {
    if (!md) return '';
    // snarkdown returns HTML; sanitize script tags
    const html = snarkdown(md);
    return html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  },

  // ===========================================
  // Delegation Methods
  // ===========================================

  openDelegationsModal() {
    this.showAvatarMenu = false;
    this.delegationError = null;
    this.newDelegateNpub = '';
    this.delegatePermRead = true;
    this.delegatePermWrite = false;
    this.showDelegationsModal = true;
    this.loadDelegations();
  },

  async loadDelegations() {
    if (!this.superbasedClient) return;

    this.isLoadingDelegations = true;
    try {
      const result = await this.superbasedClient.listDelegations();
      this.delegations = result.delegations || [];
      // Resolve profiles for each delegate
      for (const d of this.delegations) {
        if (d.delegate_pubkey) {
          this.resolveDelegateProfile(d.delegate_pubkey);
        }
      }
    } catch (err) {
      console.error('Failed to load delegations:', err);
      this.delegationError = err.message;
    } finally {
      this.isLoadingDelegations = false;
    }
  },

  async addDelegation() {
    if (!this.newDelegateNpub.trim()) {
      this.delegationError = 'Please enter an npub';
      return;
    }

    const permissions = [];
    if (this.delegatePermRead) permissions.push('read');
    if (this.delegatePermWrite) permissions.push('write');

    if (permissions.length === 0) {
      this.delegationError = 'Select at least one permission';
      return;
    }

    this.delegationError = null;

    try {
      // Grant delegation on SuperBased server
      await this.superbasedClient.grantDelegation(
        this.newDelegateNpub.trim(),
        permissions
      );

      this.newDelegateNpub = '';
      this.delegatePermRead = true;
      this.delegatePermWrite = false;
      await this.loadDelegations();

      // Trigger sync to re-encrypt records with the new delegate list
      if (this.superbasedClient && !this.isSyncing) {
        this.syncNow();
      }
    } catch (err) {
      console.error('Failed to grant delegation:', err);
      this.delegationError = err.message;
    }
  },

  async revokeDelegation(delegatePubkey) {
    if (!confirm('Revoke access for this user?')) return;

    try {
      // Need to convert pubkey hex to npub for the API
      const { nip19 } = await loadNostrLibs();
      const delegateNpub = nip19.npubEncode(delegatePubkey);
      await this.superbasedClient.revokeDelegation(delegateNpub);

      await this.loadDelegations();

      // Trigger sync to re-encrypt records without the revoked delegate
      if (this.superbasedClient && !this.isSyncing) {
        this.syncNow();
      }
    } catch (err) {
      console.error('Failed to revoke delegation:', err);
      this.delegationError = err.message;
    }
  },

  formatNpubShort(pubkeyHex) {
    if (!pubkeyHex) return '';
    return pubkeyHex.slice(0, 8) + '...' + pubkeyHex.slice(-4);
  },

  formatPermissions(permissions) {
    return (permissions || []).join(', ');
  },

  async resolveDelegateProfile(hexPubkey) {
    if (!hexPubkey || this.delegateProfiles[hexPubkey]) return;
    try {
      const { nip19 } = await loadNostrLibs();
      const npub = nip19.npubEncode(hexPubkey);
      // Set npub immediately so UI has something to show
      this.delegateProfiles[hexPubkey] = { name: null, npub, picture: null };
      const profile = await fetchProfile(hexPubkey);
      if (profile) {
        this.delegateProfiles[hexPubkey] = {
          name: profile.display_name || profile.name || null,
          npub,
          picture: profile.picture || null,
        };
      }
    } catch (err) {
      console.error('Failed to resolve delegate profile:', hexPubkey.slice(0, 8), err.message);
    }
  },

});

// Todo item component
Alpine.data('todoItem', (todo) => ({
  todoId: todo.record_id,
  localTodo: { ...todo },
  tagInput: '',
  _lastSyncedAt: todo.updated_at,

  // Watch for external changes (sync) and refresh localTodo
  init() {
    // Initial sync - ensure localTodo has latest from store
    const initialTodo = this.$store.app.todos.find(t => t.record_id === todo.record_id);
    if (initialTodo) {
      this.localTodo = { ...initialTodo };
      this._lastSyncedAt = initialTodo.updated_at;
    }

    // Watch for store changes
    this.$watch('$store.app.todos', () => {
      const freshTodo = this.$store.app.todos.find(t => t.record_id === this.localTodo.record_id);
      if (freshTodo && freshTodo.updated_at !== this._lastSyncedAt) {
        // External update detected - refresh localTodo
        this.localTodo = { ...freshTodo };
        this._lastSyncedAt = freshTodo.updated_at;
      }
    });

  },

  get tagsArray() {
    return parseTags(this.localTodo.tags);
  },

  async save() {
    const store = Alpine.store('app');
    try {
      await updateTodo(this.localTodo.record_id, {
        title: this.localTodo.title,
        description: this.localTodo.description,
        priority: this.localTodo.priority,
        state: this.localTodo.state,
        scheduled_for: this.localTodo.scheduled_for || null,
        tags: this.localTodo.tags,
        assigned_to: this.localTodo.assigned_to || null,
      });

      const savedId = this.localTodo.record_id;
      store.closeEditModal();

      // Set BEFORE loadTodos so new component sees it on init
      store.justSavedTodoId = savedId;

      await store.loadTodos();

      // Clear after animation completes
      setTimeout(() => {
        if (store.justSavedTodoId === savedId) {
          store.justSavedTodoId = null;
        }
      }, 700);

      // Mark as having unsynced changes
      store.hasUnsyncedChanges = true;
      store.lastLocalChangeTime = Date.now();

      // Trigger sync after save
      if (store.superbasedClient && !store.isSyncing) {
        store.syncNow();
      }
    } catch (err) {
      console.error('Failed to save todo:', err);
      alert('Failed to save: ' + err.message);
    }
  },

  addTag() {
    const tag = this.tagInput.trim().toLowerCase();
    if (!tag) return;
    const tags = parseTags(this.localTodo.tags);
    if (!tags.includes(tag)) {
      tags.push(tag);
      this.localTodo.tags = formatTags(tags);
    }
    this.tagInput = '';
  },

  removeTag(tag) {
    const tags = parseTags(this.localTodo.tags).filter(t => t !== tag);
    this.localTodo.tags = formatTags(tags);
  },

  handleTagKeydown(e) {
    if (e.key === ',' || e.key === 'Enter') {
      e.preventDefault();
      this.addTag();
    }
  },
}));

// Initialize Alpine
document.addEventListener('DOMContentLoaded', () => {
  Alpine.start();
  // Initialize app after Alpine starts
  setTimeout(() => {
    Alpine.store('app').init();
  }, 0);
});
