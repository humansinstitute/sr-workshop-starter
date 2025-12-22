import { elements as el, hide, setText, show } from "./dom.js";
import { state, setSummaries } from "./state.js";

export const updateSummaryUI = () => {
  if (!el.summaryPanel) return;
  const { day, week } = state.summaries || {};
  const hasDay = !!day?.day_ahead;
  const hasWeek = !!week?.week_ahead;
  const suggestionsText = day?.suggestions || week?.suggestions;
  const latestUpdated = day?.updated_at || week?.updated_at || "";

  if (!state.session || (!hasDay && !hasWeek && !suggestionsText)) {
    hide(el.summaryPanel);
    return;
  }

  show(el.summaryPanel);

  if (el.summaryDay && el.summaryDayText) {
    if (hasDay && day?.day_ahead) {
      setText(el.summaryDayText, day.day_ahead);
      show(el.summaryDay);
    } else {
      hide(el.summaryDay);
      setText(el.summaryDayText, "");
    }
  }

  if (el.summaryWeek && el.summaryWeekText) {
    if (hasWeek && week?.week_ahead) {
      setText(el.summaryWeekText, week.week_ahead);
      show(el.summaryWeek);
    } else {
      hide(el.summaryWeek);
      setText(el.summaryWeekText, "");
    }
  }

  if (el.summarySuggestions && el.summarySuggestionsText) {
    if (suggestionsText) {
      setText(el.summarySuggestionsText, suggestionsText);
      show(el.summarySuggestions);
    } else {
      setText(el.summarySuggestionsText, "");
      hide(el.summarySuggestions);
    }
  }

  if (el.summaryUpdated) {
    setText(el.summaryUpdated, latestUpdated ? `Updated ${new Date(latestUpdated).toLocaleString()}` : "");
  }
};

export const fetchSummaries = async () => {
  if (!state.session) return;
  try {
    const response = await fetch(`/ai/summary/latest?owner=${encodeURIComponent(state.session.npub)}`);
    if (!response.ok) throw new Error("Unable to fetch summaries.");
    const data = await response.json();
    setSummaries({ day: data?.day ?? null, week: data?.week ?? null });
  } catch (_error) {
    setSummaries({ day: null, week: null });
  }
};
