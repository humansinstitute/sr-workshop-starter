import { DEFAULT_RELAYS } from "./constants.js";
import { elements as el, hide, show } from "./dom.js";
import { loadApplesauceLibs } from "./nostr.js";
import { state } from "./state.js";

let profilePool;
let avatarMenuWatcherActive = false;
let avatarRequestId = 0;

export const initAvatarMenu = () => {
  el.avatarButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!state.session) return;
    if (el.avatarMenu?.hasAttribute("hidden")) openAvatarMenu();
    else closeAvatarMenu();
  });

  el.avatarMenu?.addEventListener("click", (event) => event.stopPropagation());
};

export const updateAvatar = async () => {
  if (!el.avatarButton || !el.avatarFallback) return;
  if (!state.session) {
    hide(el.avatarButton);
    if (el.avatarImg) {
      el.avatarImg.src = "";
      hide(el.avatarImg);
    }
    el.avatarFallback.textContent = "•••";
    return;
  }
  show(el.avatarButton);
  el.avatarFallback.textContent = formatAvatarLabel(state.session.npub);
  show(el.avatarFallback);
  el.avatarImg?.setAttribute("hidden", "hidden");
  const currentRequest = ++avatarRequestId;
  const picture = await fetchProfilePicture(state.session.pubkey);
  if (currentRequest !== avatarRequestId) return;
  if (picture && el.avatarImg) {
    el.avatarImg.src = picture;
    show(el.avatarImg);
    hide(el.avatarFallback);
  } else {
    hide(el.avatarImg);
    show(el.avatarFallback);
  }
};

export const closeAvatarMenu = () => {
  hide(el.avatarMenu);
  avatarMenuWatcherActive = false;
};

function openAvatarMenu() {
  show(el.avatarMenu);
  if (!avatarMenuWatcherActive) {
    avatarMenuWatcherActive = true;
    document.addEventListener("click", handleAvatarOutside, { once: true });
  }
}

function handleAvatarOutside(event) {
  avatarMenuWatcherActive = false;
  if ((el.avatarMenu && el.avatarMenu.contains(event.target)) || (el.avatarButton && el.avatarButton.contains(event.target))) {
    document.addEventListener("click", handleAvatarOutside, { once: true });
    avatarMenuWatcherActive = true;
    return;
  }
  closeAvatarMenu();
}

async function fetchProfilePicture(pubkey) {
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
  } catch (_error) {
    return fallback;
  }
}

function fallbackAvatarUrl(pubkey) {
  return `https://robohash.org/${pubkey || "nostr"}.png?set=set3`;
}

function formatAvatarLabel(npub) {
  if (!npub) return "•••";
  const trimmed = npub.replace(/^npub1/, "");
  return trimmed.slice(0, 2).toUpperCase();
}
