import { closeAvatarMenu, updateAvatar } from "./avatar.js";
import { elements as el, focusHeroInput, hide, show } from "./dom.js";
import { onRefresh, state } from "./state.js";
import { updateSummaryUI } from "./summary.js";

export const initUI = () => {
  onRefresh(() => {
    updatePanels();
    updateSummaryUI();
    void updateAvatar();
  });
  updatePanels();
  updateSummaryUI();
  void updateAvatar();
};

const updatePanels = () => {
  if (state.session) {
    hide(el.loginPanel);
    show(el.sessionControls);
    focusHeroInput();
  } else {
    show(el.loginPanel);
    hide(el.sessionControls);
    closeAvatarMenu();
  }
  updateHeroState();
};

const updateHeroState = () => {
  if (el.heroInput instanceof HTMLInputElement) {
    el.heroInput.disabled = !state.session;
    el.heroInput.placeholder = state.session ? "Add something else…" : "Add a task";
    if (state.session) {
      el.heroInput.focus();
    }
  }
  if (el.heroHint instanceof HTMLElement) {
    el.heroHint.setAttribute("hidden", "hidden");
  }
};

export const showError = (message) => {
  if (!el.errorTarget) return;
  el.errorTarget.textContent = message;
  el.errorTarget.removeAttribute("hidden");
};

export const clearError = () => {
  if (!el.errorTarget) return;
  el.errorTarget.textContent = "";
  el.errorTarget.setAttribute("hidden", "hidden");
};
