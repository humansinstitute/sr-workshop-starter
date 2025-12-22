import { renderHomePage } from "../render/home";
import { listOwnerTodos } from "../services/todos";

import type { Session } from "../types";

export function handleHome(url: URL, session: Session | null) {
  const tagsParam = url.searchParams.get("tags");
  const filterTags = tagsParam ? tagsParam.split(",").map((t) => t.trim()).filter(Boolean) : [];
  const showArchive = url.searchParams.get("archive") === "1";
  const todos = session ? listOwnerTodos(session.npub) : [];
  const page = renderHomePage({ showArchive, session, filterTags, todos });
  return new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
