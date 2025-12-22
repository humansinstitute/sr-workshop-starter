const LOGIN_KIND = 27235;
    const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.devvul.com", "wss://purplepag.es"];
    const AUTO_LOGIN_METHOD_KEY = "nostr_auto_login_method";
    const AUTO_LOGIN_PUBKEY_KEY = "nostr_auto_login_pubkey";
    const state = { session: window.__NOSTR_SESSION__, summaries: { day: null, week: null } };

    const setSession = (nextSession) => {
      state.session = nextSession;
      refreshUI();
    };

    const setSummaries = (summaries) => {
      state.summaries = summaries;
      updateSummaryUI();
    };

    const focusInput = () => {
      const input = document.getElementById("title");
      if (input) input.focus();
    };

    window.addEventListener("load", focusInput);

    const loginPanel = document.querySelector("[data-login-panel]");
    const sessionControls = document.querySelector("[data-session-controls]");
    const errorTarget = document.querySelector("[data-login-error]");
    const logoutBtn = document.querySelector("[data-logout]");
    const copyIdBtn = document.querySelector("[data-copy-id]");
    const heroInput = document.querySelector("[data-hero-input]");
    const heroHint = document.querySelector("[data-hero-hint]");
    const avatarButton = document.querySelector("[data-avatar]");
    const avatarImg = document.querySelector("[data-avatar-img]");
    const avatarFallback = document.querySelector("[data-avatar-fallback]");
    const avatarMenu = document.querySelector("[data-avatar-menu]");
    const summaryPanel = document.querySelector("[data-summary-panel]");
    const summaryUpdated = document.querySelector("[data-summary-updated]");
    const summaryDay = document.querySelector("[data-summary-day]");
    const summaryDayText = document.querySelector("[data-summary-day-text]");
    const summaryWeek = document.querySelector("[data-summary-week]");
    const summaryWeekText = document.querySelector("[data-summary-week-text]");
    const summarySuggestions = document.querySelector("[data-summary-suggestions]");
    const summarySuggestionsText = document.querySelector("[data-summary-suggestions-text]");
    const qrModal = document.querySelector("[data-qr-modal]");
    const qrCloseBtn = document.querySelector("[data-qr-close]");
    const qrContainer = document.querySelector("[data-qr-container]");
    const showLoginQrBtn = document.querySelector("[data-show-login-qr]");

    const updatePanels = () => {
      if (state.session) {
        loginPanel?.setAttribute("hidden", "hidden");
        sessionControls?.removeAttribute("hidden");
        focusInput();
      } else {
        loginPanel?.removeAttribute("hidden");
        sessionControls?.setAttribute("hidden", "hidden");
        closeAvatarMenu();
      }
      updateHeroState();
      updateAvatar();
      updateSummaryUI();
    };

    // Single place to trigger a UI redraw after state mutations.
    const refreshUI = () => {
      updatePanels();
    };

    const updateHeroState = () => {
      if (heroInput instanceof HTMLInputElement) {
        heroInput.disabled = !state.session;
        heroInput.placeholder = state.session ? "Add something else…" : "Add a task";
        if (state.session) {
          heroInput.focus();
        }
      }
      if (heroHint instanceof HTMLElement) {
        heroHint.setAttribute("hidden", "hidden");
      }
    };

    const updateSummaryUI = () => {
      if (!summaryPanel) return;
      const { day, week } = state.summaries || {};
      const hasDay = !!day?.day_ahead;
      const hasWeek = !!week?.week_ahead;
      const suggestionsText = day?.suggestions || week?.suggestions;
      const latestUpdated = day?.updated_at || week?.updated_at || "";

      if (!state.session || (!hasDay && !hasWeek && !suggestionsText)) {
        summaryPanel.setAttribute("hidden", "hidden");
        return;
      }

      summaryPanel.removeAttribute("hidden");

      if (summaryDay && summaryDayText) {
        if (hasDay && day?.day_ahead) {
          summaryDayText.textContent = day.day_ahead;
          summaryDay.removeAttribute("hidden");
        } else {
          summaryDay.setAttribute("hidden", "hidden");
          summaryDayText.textContent = "";
        }
      }

      if (summaryWeek && summaryWeekText) {
        if (hasWeek && week?.week_ahead) {
          summaryWeekText.textContent = week.week_ahead;
          summaryWeek.removeAttribute("hidden");
        } else {
          summaryWeek.setAttribute("hidden", "hidden");
          summaryWeekText.textContent = "";
        }
      }

      if (summarySuggestions && summarySuggestionsText) {
        if (suggestionsText) {
          summarySuggestionsText.textContent = suggestionsText;
          summarySuggestions.removeAttribute("hidden");
        } else {
          summarySuggestionsText.textContent = "";
          summarySuggestions.setAttribute("hidden", "hidden");
        }
      }

      if (summaryUpdated) {
        summaryUpdated.textContent = latestUpdated ? `Updated ${new Date(latestUpdated).toLocaleString()}` : "";
      }
    };

    const showError = (message) => {
      if (!errorTarget) return;
      errorTarget.textContent = message;
      errorTarget.removeAttribute("hidden");
    };

    const clearError = () => {
      if (!errorTarget) return;
      errorTarget.textContent = "";
      errorTarget.setAttribute("hidden", "hidden");
    };

    const clearAutoLogin = () => {
      localStorage.removeItem(AUTO_LOGIN_METHOD_KEY);
      localStorage.removeItem(AUTO_LOGIN_PUBKEY_KEY);
    };

    const fetchSummaries = async () => {
      if (!state.session) return;
      try {
        const response = await fetch(`/ai/summary/latest?owner=${encodeURIComponent(state.session.npub)}`);
        if (!response.ok) throw new Error("Unable to fetch summaries.");
        const data = await response.json();
        setSummaries({ day: data?.day ?? null, week: data?.week ?? null });
      } catch (error) {
        console.error(error);
        setSummaries({ day: null, week: null });
      }
    };

    const loadNostrLibs = async () => {
      if (!window.__NOSTR_LIBS__) {
        const base = "https://esm.sh/nostr-tools@2.7.2";
        window.__NOSTR_LIBS__ = {
          pure: await import(`${base}/pure`),
          nip19: await import(`${base}/nip19`),
          nip46: await import(`${base}/nip46`),
        };
      }
      return window.__NOSTR_LIBS__;
    };

    const loadApplesauceLibs = async () => {
      if (!window.__APPLESAUCE_LIBS__) {
        window.__APPLESAUCE_LIBS__ = {
          relay: await import("https://esm.sh/applesauce-relay@4.0.0?bundle"),
          helpers: await import("https://esm.sh/applesauce-core@4.0.0/helpers?bundle"),
          rxjs: await import("https://esm.sh/rxjs@7.8.1?bundle"),
        };
      }
      return window.__APPLESAUCE_LIBS__;
    };

    const loadQRCodeLib = async () => {
      if (!window.__QRCODE_LIB__) {
        const mod = await import("https://esm.sh/qrcode@1.5.3");
        window.__QRCODE_LIB__ = mod.default || mod;
      }
      return window.__QRCODE_LIB__;
    };

    let profilePool;
    let avatarMenuWatcherActive = false;
    let avatarRequestId = 0;
    let autoLoginAttempted = false;

    const fallbackAvatarUrl = (pubkey) => `https://robohash.org/${pubkey || "nostr"}.png?set=set3`;

    const formatAvatarLabel = (npub) => {
      if (!npub) return "•••";
      const trimmed = npub.replace(/^npub1/, "");
      return trimmed.slice(0, 2).toUpperCase();
    };

    const updateAvatar = async () => {
      if (!avatarButton || !avatarFallback) return;
      if (!state.session) {
        avatarButton.setAttribute("hidden", "hidden");
        if (avatarImg) {
          avatarImg.src = "";
          avatarImg.setAttribute("hidden", "hidden");
        }
        avatarFallback.textContent = "•••";
        return;
      }
      avatarButton.removeAttribute("hidden");
      avatarFallback.textContent = formatAvatarLabel(state.session.npub);
      avatarFallback.removeAttribute("hidden");
      avatarImg?.setAttribute("hidden", "hidden");
      const currentRequest = ++avatarRequestId;
      const picture = await fetchProfilePicture(state.session.pubkey);
      if (currentRequest !== avatarRequestId) return;
      if (picture && avatarImg) {
        avatarImg.src = picture;
        avatarImg.removeAttribute("hidden");
        avatarFallback.setAttribute("hidden", "hidden");
      } else {
        avatarImg?.setAttribute("hidden", "hidden");
        avatarFallback.removeAttribute("hidden");
      }
    };

    const fetchProfilePicture = async (pubkey) => {
      if (!pubkey) return null;
      const fallback = fallbackAvatarUrl(pubkey);
      try {
        const libs = await loadApplesauceLibs();
        const { RelayPool, onlyEvents } = libs.relay;
        const { getProfilePicture } = libs.helpers;
        const { firstValueFrom, take, takeUntil, timer } = libs.rxjs;
        profilePool = profilePool || new RelayPool();
        const observable = profilePool
          .subscription(DEFAULT_RELAYS, [{ authors: [pubkey], kinds: [0], limit: 1 }])
          .pipe(onlyEvents(), take(1), takeUntil(timer(5000)));
        const event = await firstValueFrom(observable, { defaultValue: null });
        if (!event) return fallback;
        return getProfilePicture(event, fallback);
      } catch (error) {
        console.warn("Unable to load profile picture", error);
        return fallback;
      }
    };

    const openAvatarMenu = () => {
      if (!avatarMenu) return;
      avatarMenu.removeAttribute("hidden");
      if (!avatarMenuWatcherActive) {
        avatarMenuWatcherActive = true;
        document.addEventListener("click", handleAvatarOutside, { once: true });
      }
    };

    const closeAvatarMenu = () => {
      avatarMenu?.setAttribute("hidden", "hidden");
      avatarMenuWatcherActive = false;
    };

    const handleAvatarOutside = (event) => {
      avatarMenuWatcherActive = false;
      if (
        (avatarMenu && avatarMenu.contains(event.target)) ||
        (avatarButton && avatarButton.contains(event.target))
      ) {
        document.addEventListener("click", handleAvatarOutside, { once: true });
        avatarMenuWatcherActive = true;
        return;
      }
      closeAvatarMenu();
    };

    avatarButton?.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!state.session) return;
      if (avatarMenu?.hasAttribute("hidden")) openAvatarMenu();
      else closeAvatarMenu();
    });

    avatarMenu?.addEventListener("click", (event) => event.stopPropagation());

    // QR Modal functions
    const openQrModal = async () => {
      if (!qrModal || !qrContainer) return;
      if (state.session?.method !== "ephemeral") {
        alert("Login QR is only available for ephemeral accounts.");
        return;
      }
      const stored = localStorage.getItem("nostr_ephemeral_secret");
      if (!stored) {
        alert("No secret key found.");
        return;
      }
      try {
        const { nip19 } = await loadNostrLibs();
        const QRCode = await loadQRCodeLib();
        const secret = hexToBytes(stored);
        const nsec = nip19.nsecEncode(secret);
        const loginUrl = `${window.location.origin}/#code=${nsec}`;
        qrContainer.innerHTML = "";
        const canvas = document.createElement("canvas");
        await QRCode.toCanvas(canvas, loginUrl, { width: 256, margin: 2 });
        qrContainer.appendChild(canvas);
        qrModal.removeAttribute("hidden");
        document.addEventListener("keydown", handleQrEscape);
      } catch (err) {
        console.error("Failed to generate QR code", err);
        alert("Failed to generate QR code.");
      }
    };

    const closeQrModal = () => {
      qrModal?.setAttribute("hidden", "hidden");
      document.removeEventListener("keydown", handleQrEscape);
    };

    const handleQrEscape = (event) => {
      if (event.key === "Escape") closeQrModal();
    };

    const handleQrOverlayClick = (event) => {
      if (event.target === qrModal) closeQrModal();
    };

    qrCloseBtn?.addEventListener("click", closeQrModal);
    qrModal?.addEventListener("click", handleQrOverlayClick);

    showLoginQrBtn?.addEventListener("click", () => {
      closeAvatarMenu();
      openQrModal();
    });

    // URL fragment login detection
    const checkFragmentLogin = async () => {
      const hash = window.location.hash;
      if (!hash.startsWith("#code=")) return;
      const nsec = hash.slice(6);
      if (!nsec || !nsec.startsWith("nsec1")) {
        console.error("Invalid nsec in URL fragment");
        history.replaceState(null, "", window.location.pathname + window.location.search);
        return;
      }
      // Clear URL immediately for security
      history.replaceState(null, "", window.location.pathname + window.location.search);
      try {
        // Decode nsec and store in localStorage for auto-login persistence
        const { nip19 } = await loadNostrLibs();
        const secretBytes = decodeNsec(nip19, nsec);
        const secretHex = bytesToHex(secretBytes);
        localStorage.setItem("nostr_ephemeral_secret", secretHex);
        // Now login as ephemeral (so auto-login works on refresh)
        const signedEvent = await signLoginEvent("ephemeral");
        await completeLogin("ephemeral", signedEvent);
      } catch (err) {
        console.error("Fragment login failed", err);
        showError(err?.message || "Login failed.");
      }
    };

    const hexToBytes = (hex) => {
      if (!hex) return new Uint8Array();
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
      }
      return bytes;
    };

    const bytesToHex = (bytes) => Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");

    const decodeNsec = (nip19, input) => {
      try {
        const decoded = nip19.decode(input);
        if (decoded.type !== "nsec" || !decoded.data) throw new Error("Not a valid nsec key.");
        if (decoded.data instanceof Uint8Array) return decoded.data;
        if (Array.isArray(decoded.data)) return new Uint8Array(decoded.data);
        throw new Error("Unable to read nsec payload.");
      } catch (err) {
        throw new Error("Invalid nsec key.");
      }
    };

    const buildUnsignedEvent = (method) => ({
      kind: LOGIN_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["app", "other-stuff-to-do"],
        ["method", method],
      ],
      content: "Authenticate with Other Stuff To Do",
    });

    const loginButtons = document.querySelectorAll("[data-login-method]");
    loginButtons.forEach((button) => {
      button.addEventListener("click", async (event) => {
        const target = event.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null;
        if (!target) return;
        const method = target.getAttribute("data-login-method");
        if (!method) return;
        target.disabled = true;
        clearError();
        try {
          const signedEvent = await signLoginEvent(method);
          await completeLogin(method, signedEvent);
        } catch (err) {
          console.error(err);
          showError(err?.message || "Login failed.");
        } finally {
          target.disabled = false;
        }
      });
    });

    const maybeAutoLogin = async () => {
      if (autoLoginAttempted || state.session) return;
      autoLoginAttempted = true;
      const method = localStorage.getItem(AUTO_LOGIN_METHOD_KEY);
      const hasSecret = !!localStorage.getItem("nostr_ephemeral_secret");
      if (method !== "ephemeral" || !hasSecret) {
        autoLoginAttempted = false;
        return;
      }
      try {
        const signedEvent = await signLoginEvent("ephemeral");
        await completeLogin("ephemeral", signedEvent);
      } catch (err) {
        console.error("Auto login failed", err);
        clearAutoLogin();
        autoLoginAttempted = false;
      }
    };

    const bunkerForm = document.querySelector("[data-bunker-form]");
    const secretForm = document.querySelector("[data-secret-form]");
    bunkerForm?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = bunkerForm.querySelector("input[name='bunker']");
      if (!input?.value.trim()) {
        showError("Enter a bunker nostrconnect URI or NIP-05 handle.");
        return;
      }
      bunkerForm.classList.add("is-busy");
      clearError();
      try {
        const signedEvent = await signLoginEvent("bunker", input.value.trim());
        await completeLogin("bunker", signedEvent);
        input.value = "";
      } catch (err) {
        console.error(err);
        showError(err?.message || "Unable to connect to bunker.");
      } finally {
        bunkerForm.classList.remove("is-busy");
      }
    });

    secretForm?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const input = secretForm.querySelector("input[name='secret']");
      if (!input?.value.trim()) {
        showError("Paste an nsec secret key to continue.");
        return;
      }
      secretForm.classList.add("is-busy");
      clearError();
      try {
        const signedEvent = await signLoginEvent("secret", input.value.trim());
        await completeLogin("secret", signedEvent);
        input.value = "";
      } catch (err) {
        console.error(err);
        showError(err?.message || "Unable to sign in with secret.");
      } finally {
        secretForm.classList.remove("is-busy");
      }
    });

    async function signLoginEvent(method, supplemental) {
      if (method === "ephemeral") {
        const { pure } = await loadNostrLibs();
        let stored = localStorage.getItem("nostr_ephemeral_secret");
        if (!stored) {
          stored = bytesToHex(pure.generateSecretKey());
          localStorage.setItem("nostr_ephemeral_secret", stored);
        }
        const secret = hexToBytes(stored);
        return pure.finalizeEvent(buildUnsignedEvent(method), secret);
      }

      if (method === "extension") {
        if (!window.nostr?.signEvent) {
          throw new Error("No NIP-07 browser extension found.");
        }
        const event = buildUnsignedEvent(method);
        event.pubkey = await window.nostr.getPublicKey();
        return window.nostr.signEvent(event);
      }

      if (method === "bunker") {
        const { pure, nip46 } = await loadNostrLibs();
        const pointer = await nip46.parseBunkerInput(supplemental || "");
        if (!pointer) throw new Error("Unable to parse bunker details.");
        const clientSecret = pure.generateSecretKey();
        const signer = new nip46.BunkerSigner(clientSecret, pointer);
        await signer.connect();
        try {
          return await signer.signEvent(buildUnsignedEvent(method));
        } finally {
          await signer.close();
        }
      }
      if (method === "secret") {
        const { pure, nip19 } = await loadNostrLibs();
        const secret = decodeNsec(nip19, supplemental || "");
        return pure.finalizeEvent(buildUnsignedEvent(method), secret);
      }
      throw new Error("Unsupported login method.");
    }

    async function completeLogin(method, event) {
      const response = await fetch("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, event }),
      });
      if (!response.ok) {
        let message = "Login failed.";
        try {
          const data = await response.json();
          if (data?.message) message = data.message;
        } catch (_err) {}
        throw new Error(message);
      }
      const session = await response.json();
      setSession(session);
      if (method === "ephemeral") {
        localStorage.setItem(AUTO_LOGIN_METHOD_KEY, "ephemeral");
        localStorage.setItem(AUTO_LOGIN_PUBKEY_KEY, session.pubkey);
      } else {
        clearAutoLogin();
      }
      await fetchSummaries();
      window.location.reload();
    }

    const exportSecretBtn = document.querySelector("[data-export-secret]");
    exportSecretBtn?.addEventListener("click", async () => {
      closeAvatarMenu();
      if (state.session?.method !== "ephemeral") {
        alert("Export is only available for ephemeral accounts.");
        return;
      }
      const stored = localStorage.getItem("nostr_ephemeral_secret");
      if (!stored) {
        alert("No secret key found.");
        return;
      }
      try {
        const { nip19 } = await loadNostrLibs();
        const secret = hexToBytes(stored);
        const nsec = nip19.nsecEncode(secret);
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(nsec);
          alert("Secret key copied to clipboard!\\n\\nKeep this safe - anyone with this key can access your account.");
        } else {
          prompt("Copy your secret key (keep it safe):", nsec);
        }
      } catch (err) {
        console.error(err);
        alert("Failed to export secret key.");
      }
    });

    copyIdBtn?.addEventListener("click", async () => {
      closeAvatarMenu();
      const npub = state.session?.npub;
      if (!npub) {
        alert("No ID available.");
        return;
      }
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(npub);
          alert("ID copied to clipboard.");
        } else {
          prompt("Copy your ID:", npub);
        }
      } catch (err) {
        console.error(err);
        prompt("Copy your ID:", npub);
      }
    });

    logoutBtn?.addEventListener("click", async () => {
      closeAvatarMenu();
      await fetch("/auth/logout", { method: "POST" });
      setSummaries({ day: null, week: null });
      setSession(null);
      clearAutoLogin();
    });

    refreshUI();
    if (state.session) {
      void fetchSummaries();
    }
    // Check for fragment login first (takes precedence over auto-login)
    void checkFragmentLogin().then(() => {
      if (!state.session) {
        void maybeAutoLogin();
      }
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && !state.session) {
        void maybeAutoLogin();
      }
    });

    // Tag input functionality
    function initTagInputs() {
      document.querySelectorAll(".tag-input-wrapper").forEach((wrapper) => {
        const input = wrapper.querySelector("input[type='text']");
        const hiddenInput = wrapper.querySelector("input[type='hidden']");
        if (!input || !hiddenInput) return;

        function syncTags() {
          const chips = wrapper.querySelectorAll(".tag-chip");
          const tags = Array.from(chips).map((c) => c.dataset.tag).filter(Boolean);
          hiddenInput.value = tags.join(",");
        }

        function addTag(text) {
          const tag = text.trim().toLowerCase().replace(/,/g, "");
          if (!tag) return;
          // Check for duplicates
          const existing = wrapper.querySelectorAll(".tag-chip");
          for (const chip of existing) {
            if (chip.dataset.tag === tag) return;
          }
          const chip = document.createElement("span");
          chip.className = "tag-chip";
          chip.dataset.tag = tag;
          chip.innerHTML = tag + '<span class="remove-tag">&times;</span>';
          chip.querySelector(".remove-tag").addEventListener("click", () => {
            chip.remove();
            syncTags();
          });
          wrapper.insertBefore(chip, input);
          syncTags();
        }

        function removeLastTag() {
          const chips = wrapper.querySelectorAll(".tag-chip");
          if (chips.length > 0) {
            chips[chips.length - 1].remove();
            syncTags();
          }
        }

        input.addEventListener("keydown", (e) => {
          if (e.key === "," || e.key === "Enter") {
            e.preventDefault();
            addTag(input.value);
            input.value = "";
          } else if (e.key === "Backspace" && input.value === "") {
            removeLastTag();
          }
        });

        input.addEventListener("blur", () => {
          if (input.value.trim()) {
            addTag(input.value);
            input.value = "";
          }
        });

        wrapper.addEventListener("click", () => input.focus());

        // Initialize existing chips' remove buttons
        wrapper.querySelectorAll(".tag-chip .remove-tag").forEach((btn) => {
          btn.addEventListener("click", () => {
            btn.parentElement.remove();
            syncTags();
          });
        });
      });
    }

    initTagInputs();
