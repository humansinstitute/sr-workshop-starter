const refreshers = new Set();

export const state = {
  session: window.__NOSTR_SESSION__,
  summaries: { day: null, week: null },
};

export const setSession = (nextSession) => {
  state.session = nextSession;
  refreshUI();
};

export const setSummaries = (summaries) => {
  state.summaries = summaries;
  refreshUI();
};

export const onRefresh = (callback) => {
  refreshers.add(callback);
};

export const refreshUI = () => {
  refreshers.forEach((cb) => cb());
};
