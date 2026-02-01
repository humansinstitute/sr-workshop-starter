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
  SyncNotifier,
  parseToken,
  verifyToken,
  saveToken,
  loadToken,
  clearToken,
  truncateNpub,
  getDeviceId,
} from './superbased.js';
import {
  formatForSync,
  formatTodosByIdForSync,
  mergeRemoteRecords,
  importParsedRecords,
  forceImportRecord,
  setLastSyncTime,
  getLastSyncTime,
} from './db.js';

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

  // SuperBased sync state
  showSuperBasedModal: false,
  superbasedTokenInput: '',
  superbasedConfig: null, // Parsed token config
  superbasedClient: null,
  superbasedSyncStatus: null, // 'connecting' | 'uploading' | 'downloading' | 'merging' | 'done' | 'error'
  superbasedError: null,
  superbasedConflicts: [], // Array of conflict objects for user resolution
  superbasedHasToken: false, // Whether a token is saved
  superbasedBackgroundSyncing: false, // Background sync in progress
  superbasedSyncNotifier: null, // SyncNotifier instance for event-based sync
  superbasedLastBackgroundSync: null, // Timestamp of last background sync
  superbasedChangeDebounce: null, // Debounce timer for change sync
  superbasedPollInterval: null, // 1s polling interval as fallback

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
    // Stop background sync if running
    this.stopBackgroundSync();

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
    this.todos = await getTodosByOwner(this.session.npub);
  },

  async addTodo() {
    if (!this.newTodoTitle.trim() || !this.session?.npub) return;

    await createTodo({
      title: this.newTodoTitle.trim(),
      owner: this.session.npub,
    });

    this.newTodoTitle = '';
    await this.loadTodos();
    this.syncAfterChange();
  },

  async updateTodoField(id, field, value) {
    await updateTodo(id, { [field]: value });
    await this.loadTodos();
    this.syncAfterChange();
  },

  async transitionState(id, newState) {
    await transitionTodoState(id, newState);
    await this.loadTodos();
    this.syncAfterChange();
  },

  async deleteTodoItem(id) {
    await deleteTodo(id);
    await this.loadTodos();
    this.syncAfterChange();
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

  async openSuperBasedModal() {
    this.showAvatarMenu = false;
    this.superbasedError = null;
    this.superbasedSyncStatus = null;
    this.superbasedConflicts = [];

    // Check for saved token (encrypted in IndexedDB)
    const savedToken = await loadToken();
    if (savedToken) {
      this.superbasedTokenInput = savedToken;
      this.superbasedHasToken = true;
      try {
        this.superbasedConfig = parseToken(savedToken);
      } catch (err) {
        this.superbasedConfig = null;
        this.superbasedHasToken = false;
      }
    } else {
      this.superbasedTokenInput = '';
      this.superbasedConfig = null;
      this.superbasedHasToken = false;
    }

    this.showSuperBasedModal = true;
  },

  closeSuperBasedModal() {
    this.showSuperBasedModal = false;
    this.superbasedTokenInput = '';
    // Don't clear superbasedConfig - keep it for background sync
    // Only clear temporary modal state
    this.superbasedError = null;
    this.superbasedSyncStatus = null;
    this.superbasedConflicts = [];
    if (this.superbasedClient) {
      this.superbasedClient.disconnect();
      this.superbasedClient = null;
    }
  },

  async parseSuperbaedToken() {
    this.superbasedError = null;
    this.superbasedConfig = null;

    const token = this.superbasedTokenInput.trim();
    if (!token) {
      this.superbasedError = 'Please paste a token';
      return;
    }

    try {
      // Parse token
      const config = parseToken(token);

      // Verify signature
      const valid = await verifyToken(token);
      if (!valid) {
        this.superbasedError = 'Invalid token signature';
        return;
      }

      this.superbasedConfig = config;
      await saveToken(token);
      this.superbasedHasToken = true;
    } catch (err) {
      this.superbasedError = err.message;
    }
  },

  async clearSuperbasedToken() {
    // Stop background sync when clearing token
    this.stopBackgroundSync();

    await clearToken();
    this.superbasedTokenInput = '';
    this.superbasedConfig = null;
    this.superbasedHasToken = false;
    this.superbasedError = null;
  },

  async syncToSuperbased() {
    if (!this.superbasedConfig || !this.session?.npub) return;

    this.superbasedError = null;
    this.superbasedSyncStatus = 'connecting';

    try {
      // Create client and connect
      const token = this.superbasedTokenInput.trim() || await loadToken();
      this.superbasedClient = new SuperBasedClient(token);
      await this.superbasedClient.connect();

      // Check health
      await this.superbasedClient.health();

      // Format local todos for sync
      this.superbasedSyncStatus = 'uploading';
      const records = await formatForSync(this.session.npub);

      if (records.length === 0) {
        this.superbasedError = 'No todos to sync';
        this.superbasedSyncStatus = null;
        return;
      }

      // Upload to SuperBased
      const result = await this.superbasedClient.syncRecords(records);
      console.log('Sync result:', result);

      // Update last sync time
      setLastSyncTime(this.session.npub, new Date().toISOString());

      this.superbasedSyncStatus = 'done';

      // Start background sync after successful manual sync
      this.startBackgroundSync();
    } catch (err) {
      console.error('SuperBased sync failed:', err);
      this.superbasedError = err.message;
      this.superbasedSyncStatus = 'error';
    }
  },

  async downloadFromSuperbased() {
    console.log('downloadFromSuperbased called, config:', !!this.superbasedConfig, 'session:', !!this.session?.npub);
    if (!this.superbasedConfig || !this.session?.npub) {
      console.log('downloadFromSuperbased: skipping, missing config or session');
      return;
    }

    this.superbasedError = null;
    this.superbasedSyncStatus = 'connecting';

    try {
      // Create client and connect
      const token = this.superbasedTokenInput.trim() || await loadToken();
      this.superbasedClient = new SuperBasedClient(token);
      await this.superbasedClient.connect();

      // Fetch records
      this.superbasedSyncStatus = 'downloading';
      console.log('downloadFromSuperbased: fetching records...');
      const result = await this.superbasedClient.fetchRecords({ collection: 'todos' });
      console.log('downloadFromSuperbased: fetch result:', result);
      const records = result?.records;

      if (!records || records.length === 0) {
        console.log('downloadFromSuperbased: no records found');
        this.superbasedError = 'No records found on server';
        this.superbasedSyncStatus = null;
        return;
      }
      console.log('downloadFromSuperbased: got', records.length, 'records');

      // Merge with local data
      this.superbasedSyncStatus = 'merging';
      const { toImport, conflicts, skipped } = await mergeRemoteRecords(this.session.npub, records);

      console.log('Merge result:', { toImport: toImport.length, conflicts: conflicts.length, skipped: skipped.length });

      // Import non-conflicting records
      if (toImport.length > 0) {
        await importParsedRecords(toImport);
      }

      // Handle conflicts
      if (conflicts.length > 0) {
        this.superbasedConflicts = conflicts;
        this.superbasedSyncStatus = 'conflicts';
        return;
      }

      // Update last sync time
      setLastSyncTime(this.session.npub, new Date().toISOString());

      // Reload todos
      await this.loadTodos();

      this.superbasedSyncStatus = 'done';

      // Start background sync after successful download
      this.startBackgroundSync();
    } catch (err) {
      console.error('SuperBased download failed:', err);
      this.superbasedError = err.message;
      this.superbasedSyncStatus = 'error';
    }
  },

  async resolveConflict(conflict, choice) {
    // choice: 'keep_local' | 'use_remote'
    if (choice === 'use_remote') {
      await forceImportRecord(conflict.remote);
    }
    // Remove from conflicts list
    this.superbasedConflicts = this.superbasedConflicts.filter(c => c !== conflict);

    // If no more conflicts, finish up
    if (this.superbasedConflicts.length === 0) {
      setLastSyncTime(this.session.npub, new Date().toISOString());
      await this.loadTodos();
      this.superbasedSyncStatus = 'done';
    }
  },

  async resolveAllConflicts(choice) {
    // choice: 'keep_all_local' | 'use_all_remote'
    if (choice === 'use_all_remote') {
      for (const conflict of this.superbasedConflicts) {
        await forceImportRecord(conflict.remote);
      }
    }
    this.superbasedConflicts = [];
    setLastSyncTime(this.session.npub, new Date().toISOString());
    await this.loadTodos();
    this.superbasedSyncStatus = 'done';

    // Start background sync after resolving conflicts
    this.startBackgroundSync();
  },

  // Trigger sync after a local change (debounced to batch rapid changes)
  syncAfterChange() {
    console.log('syncAfterChange called, superbasedConfig:', !!this.superbasedConfig);
    // Skip if no token configured
    if (!this.superbasedConfig) {
      console.log('syncAfterChange: no config, skipping');
      return;
    }

    // Clear existing debounce timer
    if (this.superbasedChangeDebounce) {
      clearTimeout(this.superbasedChangeDebounce);
    }

    console.log('syncAfterChange: scheduling upload in 100ms');
    // Debounce: wait 100ms after last change before syncing
    this.superbasedChangeDebounce = setTimeout(() => {
      this.superbasedChangeDebounce = null;
      this.uploadChanges();
    }, 100);
  },

  // Upload-only sync (doesn't download, for quick change sync)
  async uploadChanges() {
    console.log('uploadChanges called');
    if (!this.superbasedConfig || !this.session?.npub) {
      console.log('uploadChanges: no config or session, skipping');
      return;
    }
    if (this.superbasedBackgroundSyncing) {
      console.log('uploadChanges: background sync in progress, skipping');
      return;
    }
    if (this.superbasedSyncStatus) {
      console.log('uploadChanges: manual sync in progress, skipping');
      return;
    }

    console.log('SuperBased: uploading changes');

    try {
      const token = await loadToken();
      if (!token) return;

      const client = new SuperBasedClient(token);
      await client.connect();

      const records = await formatForSync(this.session.npub);
      if (records.length > 0) {
        await client.syncRecords(records);
        console.log('SuperBased: uploaded', records.length, 'records');

        // Publish notification to other devices
        console.log('SuperBased: publishing notification, notifier exists:', !!this.superbasedSyncNotifier);
        if (this.superbasedSyncNotifier) {
          const published = await this.superbasedSyncNotifier.publish();
          console.log('SuperBased: notification published:', published);
        } else {
          console.log('SuperBased: no notifier, skipping publish');
        }
      }

      setLastSyncTime(this.session.npub, new Date().toISOString());
      await client.disconnect();
    } catch (err) {
      console.error('SuperBased: upload failed:', err.message);
    }
  },

  // Initialize background sync from saved token (called on app startup)
  async initBackgroundSync() {
    const savedToken = await loadToken();
    if (!savedToken) return;

    try {
      this.superbasedConfig = parseToken(savedToken);
      this.superbasedHasToken = true;
      console.log('SuperBased: found saved token, starting background sync');
      this.startBackgroundSync();
    } catch (err) {
      console.error('SuperBased: invalid saved token:', err.message);
      await clearToken();
    }
  },

  // Background sync - download only, updates local with newer cloud records
  // Uses incremental sync with `since` parameter for efficiency
  async backgroundSync(fullSync = false) {
    // Skip if not configured or already syncing
    if (!this.superbasedConfig || !this.session?.npub) return;
    if (this.superbasedBackgroundSyncing) return;
    if (this.superbasedSyncStatus) return; // Manual sync in progress

    this.superbasedBackgroundSyncing = true;

    try {
      const token = await loadToken();
      if (!token) return;

      const client = new SuperBasedClient(token);
      await client.connect();

      // Use incremental sync - only fetch records updated since last sync
      const lastSync = fullSync ? null : getLastSyncTime(this.session.npub);
      console.log('SuperBased: background download starting', lastSync ? `(since ${lastSync})` : '(full sync)');

      // Download remote changes only - cloud overwrites local if newer
      const { records: remoteRecords } = await client.fetchRecords({
        collection: 'todos',
        since: lastSync || undefined,
      });

      console.log('SuperBased: fetched', remoteRecords?.length || 0, 'records from cloud');

      if (remoteRecords && remoteRecords.length > 0) {
        const { toImport, toUploadIds, skipped } = await mergeRemoteRecords(this.session.npub, remoteRecords);

        // Import newer records from cloud
        if (toImport.length > 0) {
          await importParsedRecords(toImport);
          await this.loadTodos();
          console.log('SuperBased: imported', toImport.length, 'newer records from cloud');
        }

        // Upload local records that are newer or missing from cloud
        if (toUploadIds.length > 0) {
          const recordsToUpload = await formatTodosByIdForSync(toUploadIds);
          if (recordsToUpload.length > 0) {
            await client.syncRecords(recordsToUpload);
            console.log('SuperBased: uploaded', recordsToUpload.length, 'newer local records to cloud');

            // Notify other devices about our upload
            if (this.superbasedSyncNotifier) {
              await this.superbasedSyncNotifier.publish();
            }
          }
        }
      }

      setLastSyncTime(this.session.npub, new Date().toISOString());
      this.superbasedLastBackgroundSync = Date.now();
      console.log('SuperBased: background sync complete');

      await client.disconnect();
    } catch (err) {
      console.error('SuperBased: background sync failed:', err.message);
    } finally {
      this.superbasedBackgroundSyncing = false;
    }
  },

  // Start event-based background sync (subscribes to Nostr notifications)
  async startBackgroundSync() {
    if (this.superbasedSyncNotifier) return;
    if (!this.superbasedConfig) return;

    const token = await loadToken();
    if (!token) return;

    try {
      // Create and initialize sync notifier
      this.superbasedSyncNotifier = new SyncNotifier(token);
      await this.superbasedSyncNotifier.init();

      // Subscribe to sync notifications from other devices
      this.superbasedSyncNotifier.startSubscription((payload) => {
        console.log('SuperBased: received sync notification from device:', payload.deviceId);
        // Trigger background download when another device publishes
        this.backgroundSync();
      });

      console.log('SuperBased: started event-based sync subscription');

      // Also sync when app becomes visible (in case we missed notifications)
      document.addEventListener('visibilitychange', this._handleVisibilityChange);

      // Start 1-second polling as fallback for missed notifications
      this._startPolling();

      // Initial sync after short delay
      setTimeout(() => this.backgroundSync(), 2000);
    } catch (err) {
      console.error('SuperBased: failed to start sync notifier:', err.message);
    }
  },

  // Start 1-second polling for missed notifications
  _startPolling() {
    if (this.superbasedPollInterval) return;

    this.superbasedPollInterval = setInterval(() => {
      // Only poll if app is visible and not already syncing
      if (!document.hidden && !this.superbasedBackgroundSyncing) {
        this.backgroundSync(); // Uses incremental sync (since last sync)
      }
    }, 1000);

    console.log('SuperBased: started 1s polling fallback');
  },

  // Stop polling
  _stopPolling() {
    if (this.superbasedPollInterval) {
      clearInterval(this.superbasedPollInterval);
      this.superbasedPollInterval = null;
      console.log('SuperBased: stopped polling');
    }
  },

  // Stop event-based background sync
  stopBackgroundSync() {
    if (this.superbasedSyncNotifier) {
      this.superbasedSyncNotifier.destroy();
      this.superbasedSyncNotifier = null;
      console.log('SuperBased: stopped sync subscription');
    }
    this._stopPolling();
    document.removeEventListener('visibilitychange', this._handleVisibilityChange);
  },

  // Handle visibility change (sync when returning to app)
  _handleVisibilityChange() {
    const store = Alpine.store('app');
    console.log('SuperBased: visibility changed, hidden:', document.hidden, 'config:', !!store.superbasedConfig);
    if (!document.hidden && store.superbasedConfig) {
      console.log('SuperBased: app became visible, restarting subscription and doing full sync');
      // Restart subscription (mobile browsers kill WebSockets when backgrounded)
      store.restartBackgroundSync();
      // Do full sync since we might have missed notifications while backgrounded
      store.backgroundSync(true); // fullSync = true
    }
  },

  // Restart the subscription (for when mobile browsers kill the connection)
  async restartBackgroundSync() {
    if (!this.superbasedConfig) return;

    // Stop existing subscription if any
    if (this.superbasedSyncNotifier) {
      this.superbasedSyncNotifier.stopSubscription();
    }

    const token = await loadToken();
    if (!token) return;

    try {
      // Recreate notifier if needed
      if (!this.superbasedSyncNotifier) {
        this.superbasedSyncNotifier = new SyncNotifier(token);
        await this.superbasedSyncNotifier.init();
      }

      // Restart the subscription
      this.superbasedSyncNotifier.startSubscription((payload) => {
        console.log('SuperBased: received sync notification from device:', payload.deviceId);
        this.backgroundSync();
      });

      console.log('SuperBased: restarted event-based sync subscription');
    } catch (err) {
      console.error('SuperBased: failed to restart sync:', err.message);
    }
  },

  truncateNpub,
});

// Todo item component
Alpine.data('todoItem', (todo) => ({
  todoId: todo.id,
  localTodo: { ...todo },
  tagInput: '',

  init() {
    // Watch for changes in the store's todos and sync localTodo
    this.$watch('$store.app.todos', (todos) => {
      const updated = todos.find(t => t.id === this.todoId);
      if (updated) {
        // Sync all fields from the updated todo
        this.localTodo = { ...updated };
      }
    });
  },

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
      store.syncAfterChange();
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
