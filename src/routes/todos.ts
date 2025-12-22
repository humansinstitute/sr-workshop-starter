import { redirect, unauthorized } from "../http";
import { quickAddTodo, removeTodo, transitionTodoState, updateTodoFromForm } from "../services/todos";
import { normalizeStateInput } from "../validation";

import type { Session } from "../types";

export async function handleTodoCreate(req: Request, session: Session | null) {
  if (!session) return unauthorized();
  const form = await req.formData();
  const title = String(form.get("title") ?? "");
  const tags = String(form.get("tags") ?? "");
  quickAddTodo(session.npub, title, tags);
  return redirect("/");
}

export async function handleTodoUpdate(req: Request, session: Session | null, id: number) {
  if (!session) return unauthorized();
  const form = await req.formData();
  updateTodoFromForm(session.npub, id, form);
  return redirect("/");
}

export async function handleTodoState(req: Request, session: Session | null, id: number) {
  if (!session) return unauthorized();
  const form = await req.formData();
  const nextState = normalizeStateInput(String(form.get("state") ?? "ready"));
  transitionTodoState(session.npub, id, nextState);
  return redirect("/");
}

export function handleTodoDelete(session: Session | null, id: number) {
  if (!session) return unauthorized();
  removeTodo(session.npub, id);
  return redirect("/");
}
