import { jsonResponse, safeJson } from "../http";
import {
  createTodosFromTasks,
  latestSummaries,
  listOwnerScheduled,
  listOwnerUnscheduled,
  normalizeSummaryText,
  persistSummary,
} from "../services/todos";
import { isValidDateString, MAX_TASKS_PER_REQUEST } from "../validation";

type TaskInput = {
  title?: string;
  description?: string;
  priority?: string;
  state?: string;
  scheduled_for?: string | null;
  tags?: string;
};

type AiTasksPostBody = {
  owner?: string;
  tasks?: TaskInput[];
};

type SummaryPayload = Partial<{
  owner: string;
  summary_date: string;
  day_ahead: string | null;
  week_ahead: string | null;
  suggestions: string | null;
}>;

export function handleAiTasks(url: URL, match: RegExpMatchArray) {
  const owner = url.searchParams.get("owner");
  if (!owner) return jsonResponse({ message: "Missing owner." }, 400);

  const days = Number(match[1]);
  if (!Number.isFinite(days) || days <= 0) return jsonResponse({ message: "Invalid day range." }, 400);

  const includeUnscheduled = (match[2] || "yes").toLowerCase() !== "no";
  const endDate = formatLocalDate(addDays(new Date(), Math.max(days - 1, 0)));

  const scheduled = listOwnerScheduled(owner, endDate);
  const unscheduled = includeUnscheduled ? listOwnerUnscheduled(owner) : [];

  return jsonResponse({
    owner,
    range_days: days,
    generated_at: new Date().toISOString(),
    scheduled,
    unscheduled: includeUnscheduled ? unscheduled : [],
  });
}

export async function handleAiTasksPost(req: Request) {
  const body = (await safeJson(req)) as AiTasksPostBody | null;

  if (!body?.owner) {
    return jsonResponse({ message: "Missing owner." }, 400);
  }

  if (!Array.isArray(body.tasks) || body.tasks.length === 0) {
    return jsonResponse({ message: "Missing or empty tasks array." }, 400);
  }

  if (body.tasks.length > MAX_TASKS_PER_REQUEST) {
    return jsonResponse({ message: `Maximum ${MAX_TASKS_PER_REQUEST} tasks per request.` }, 400);
  }

  const { created, failed } = createTodosFromTasks(body.owner, body.tasks);

  return jsonResponse({
    owner: body.owner,
    created_at: new Date().toISOString(),
    created,
    failed,
  });
}

export async function handleSummaryPost(req: Request) {
  const body = (await safeJson(req)) as SummaryPayload | null;
  if (!body?.owner || !body.summary_date) {
    return jsonResponse({ message: "Missing owner or summary_date." }, 400);
  }

  if (!isValidDateString(body.summary_date)) {
    return jsonResponse({ message: "Invalid summary_date format. Use YYYY-MM-DD." }, 422);
  }

  const payload = {
    owner: body.owner,
    summary_date: body.summary_date,
    day_ahead: normalizeSummaryText(body.day_ahead),
    week_ahead: normalizeSummaryText(body.week_ahead),
    suggestions: normalizeSummaryText(body.suggestions),
  };

  if (!payload.day_ahead && !payload.week_ahead && !payload.suggestions) {
    return jsonResponse({ message: "Provide at least one of day_ahead, week_ahead, or suggestions." }, 422);
  }

  const summary = persistSummary(payload);

  if (!summary) return jsonResponse({ message: "Unable to save summary." }, 500);

  return jsonResponse({
    owner: summary.owner,
    summary_date: summary.summary_date,
    updated_at: summary.updated_at,
  });
}

export function handleLatestSummary(url: URL) {
  const owner = url.searchParams.get("owner");
  if (!owner) return jsonResponse({ message: "Missing owner." }, 400);
  const { day, week } = latestSummaries(owner, new Date());
  return jsonResponse({
    owner,
    day,
    week,
  });
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function formatLocalDate(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

