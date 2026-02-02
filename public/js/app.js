// Main Alpine.js application
import Alpine from 'https://esm.sh/alpinejs@3.14.8';
import { createTodo, getTodosByOwner, updateTodo, deleteTodo, transitionTodoState } from './db.js';
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
import { SyncNotifier } from './sync-notifier.js';

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
  editingTodoId: null,

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
  lastSyncTime: null,
  superbasedClient: null,
  syncNotifier: null,
  syncPollInterval: null,

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
    // Debug: check raw IndexedDB contents at startup
    const { db } = await import('./db.js');
    const allTodos = await db.todos.toArray();
    console.log('INIT: IndexedDB contains', allTodos.length, 'raw todos:', allTodos);

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
    } catch (err) {
      console.error('Login failed:', err);
      this.loginError = err.message || 'Login failed.';
    } finally {
      this.isLoggingIn = false;
    }
  },

  async logout() {
    this.session = null;
    this.profile = null;
    this.todos = [];
    this.filterTags = [];
    this.showAvatarMenu = false;
    await clearAutoLogin();
    clearMemoryCredentials();
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

    console.log('loadTodos: Querying for owner:', this.session.npub);
    this.todos = await getTodosByOwner(this.session.npub);
    console.log('loadTodos: Found', this.todos.length, 'todos');

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

    // Auto-sync if connected
    if (this.superbasedClient && !this.isSyncing) {
      this.syncNow();
    }
  },

  async updateTodoField(id, field, value) {
    await updateTodo(id, { [field]: value });
    await this.loadTodos();
  },

  async transitionState(id, newState) {
    await transitionTodoState(id, newState);
    await this.loadTodos();

    // Auto-sync if connected
    if (this.superbasedClient && !this.isSyncing) {
      this.syncNow();
    }
  },

  async deleteTodoItem(id) {
    await deleteTodo(id);
    await this.loadTodos();

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

  toggleArchive() {
    this.showArchive = !this.showArchive;
  },

  startEditing(id) {
    this.editingTodoId = id;
  },

  stopEditing() {
    this.editingTodoId = null;
  },

  isEditing(id) {
    return this.editingTodoId === id;
  },

  getTransitions(state) {
    return ALLOWED_STATE_TRANSITIONS[state] || [];
  },

  formatState: formatStateLabel,
  formatPriority: formatPriorityLabel,
  formatTransition: formatTransitionLabel,

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
    if (this.session?.method !== 'ephemeral') {
      alert('Login QR is only available for ephemeral accounts.');
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
      const client = new SuperBasedClient(token);
      const whoami = await client.whoami();
      console.log('SuperBased: Connected as', whoami.npub);

      // Save token
      localStorage.setItem('superbased_token', token);
      this.superbasedClient = client;
      this.superbasedConnected = true;

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
      const client = new SuperBasedClient(token);
      // Test connection
      await client.whoami();
      this.superbasedClient = client;
      console.log('SuperBased: Client initialized');

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
  },

  // Start auto-sync polling and visibility listener
  startAutoSync() {
    // Poll every 5 seconds (2s is too aggressive)
    if (!this.syncPollInterval) {
      this.syncPollInterval = setInterval(() => {
        if (this.superbasedClient && !this.isSyncing && document.visibilityState === 'visible') {
          console.log('SuperBased: Poll sync');
          this.syncNow(true).catch(err => console.error('Poll sync failed:', err));
        }
      }, 5000);
      console.log('SuperBased: Started poll sync (5s)');
    }

    // Sync on visibility change (tab becomes visible)
    if (!this._visibilityHandler) {
      this._visibilityHandler = () => {
        if (document.visibilityState === 'visible' && this.superbasedClient && !this.isSyncing) {
          console.log('SuperBased: Visibility sync');
          this.syncNow(true).catch(err => console.error('Visibility sync failed:', err));
        }
      };
      document.addEventListener('visibilitychange', this._visibilityHandler);
      console.log('SuperBased: Added visibility listener');
    }

    // Sync on window focus
    if (!this._focusHandler) {
      this._focusHandler = () => {
        if (this.superbasedClient && !this.isSyncing) {
          console.log('SuperBased: Focus sync');
          this.syncNow(true).catch(err => console.error('Focus sync failed:', err));
        }
      };
      window.addEventListener('focus', this._focusHandler);
      console.log('SuperBased: Added focus listener');
    }
  },

  // Stop auto-sync
  stopAutoSync() {
    if (this.syncPollInterval) {
      clearInterval(this.syncPollInterval);
      this.syncPollInterval = null;
    }
    if (this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }
    if (this._focusHandler) {
      window.removeEventListener('focus', this._focusHandler);
      this._focusHandler = null;
    }
    console.log('SuperBased: Stopped auto-sync');
  },

  async disconnectSuperBased() {
    // Stop auto-sync
    this.stopAutoSync();

    // Clean up SyncNotifier
    if (this.syncNotifier) {
      this.syncNotifier.destroy();
      this.syncNotifier = null;
    }

    localStorage.removeItem('superbased_token');
    localStorage.removeItem('superbased_last_sync');
    this.superbasedConnected = false;
    this.superbasedClient = null;
    this.superbasedTokenInput = '';
    this.lastSyncTime = null;
    this.showSuperBasedModal = false;
  },

  async syncNow(skipNotify = false) {
    if (!this.superbasedClient || !this.session?.npub) return;

    this.isSyncing = true;
    this.superbasedError = null;

    try {
      const lastSync = localStorage.getItem('superbased_last_sync');
      const result = await performSync(this.superbasedClient, this.session.npub, lastSync);

      // Save last sync time
      localStorage.setItem('superbased_last_sync', result.syncTime);
      this.lastSyncTime = new Date().toLocaleString();

      console.log('SuperBased: Sync complete', result);

      // Reload todos to show any new items from sync
      await this.loadTodos();

      // Notify other devices (unless this sync was triggered by a notification)
      if (!skipNotify && this.syncNotifier && result.pushed > 0) {
        await this.syncNotifier.publish();
      }
    } catch (err) {
      console.error('Sync failed:', err);
      this.superbasedError = err.message;
    } finally {
      this.isSyncing = false;
    }
  },

  async checkSuperBasedConnection() {
    const token = localStorage.getItem('superbased_token');
    if (token && this.session?.npub) {
      try {
        const config = parseToken(token);
        if (config.isValid) {
          await this.initSuperBasedClient(token);
          this.superbasedConnected = true;
          this.superbasedTokenInput = token;

          // Restore last sync time
          const lastSync = localStorage.getItem('superbased_last_sync');
          if (lastSync) {
            this.lastSyncTime = new Date(lastSync).toLocaleString();
          }

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
});

// Todo item component
Alpine.data('todoItem', (todo) => ({
  localTodo: { ...todo },
  tagInput: '',

  get tagsArray() {
    return parseTags(this.localTodo.tags);
  },

  async save() {
    const store = Alpine.store('app');
    try {
      await updateTodo(this.localTodo.id, {
        title: this.localTodo.title,
        description: this.localTodo.description,
        priority: this.localTodo.priority,
        state: this.localTodo.state,
        scheduled_for: this.localTodo.scheduled_for || null,
        tags: this.localTodo.tags,
      });
      store.stopEditing();
      // Close the details element
      const details = this.$el.querySelector('details');
      if (details) details.open = false;
      await store.loadTodos();
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
