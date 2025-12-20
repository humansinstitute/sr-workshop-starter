import { rm } from "fs/promises";
import { join } from "path";

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as pure from "nostr-tools/pure";

const TEST_DB_PATH = join(import.meta.dir, "tmp-test.sqlite");
await rm(TEST_DB_PATH, { force: true });
process.env.DB_PATH = TEST_DB_PATH;

const db = await import("../src/db");
const todos = await import("../src/services/todos");
const { AuthService } = await import("../src/services/auth");

const OWNER = "npub1testowner";
const APP_TAG = "other-stuff-to-do";
const LOGIN_EVENT_KIND = 27235;

beforeEach(async () => {
  await db.resetDatabase();
});

describe("todo services", () => {
  test("creates todos and enforces allowed transitions", () => {
    const created = todos.quickAddTodo(OWNER, "Write tests", "");
    expect(created).toBeTruthy();
    const ready = todos.transitionTodoState(OWNER, created!.id, "ready");
    expect(ready?.state).toBe("ready");
    const invalid = todos.transitionTodoState(OWNER, created!.id, "new");
    expect(invalid).toBeNull();
  });

  test("bulk task creation validates input", () => {
    const { created, failed } = todos.createTodosFromTasks(OWNER, [
      { title: "Ship feature", priority: "rock" },
      { title: "   ", state: "done" },
    ]);
    expect(created.length).toBe(1);
    expect(failed.length).toBe(1);
    expect(failed[0].reason).toContain("Missing");
  });
});

describe("auth service", () => {
  test("accepts a signed login event with matching tags", async () => {
    const authService = new AuthService("test_session", APP_TAG, LOGIN_EVENT_KIND, 120, false, 3600);
    const event = pure.finalizeEvent(
      {
        kind: LOGIN_EVENT_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["app", APP_TAG],
          ["method", "ephemeral"],
        ],
        content: "Authenticate with Other Stuff To Do",
      },
      pure.generateSecretKey()
    );

    const response = authService.login("ephemeral", event as any);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.npub).toBeDefined();
  });

  test("rejects login events without method tag", () => {
    const authService = new AuthService("test_session", APP_TAG, LOGIN_EVENT_KIND, 120, false, 3600);
    const event = pure.finalizeEvent(
      {
        kind: LOGIN_EVENT_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["app", APP_TAG]],
        content: "Authenticate with Other Stuff To Do",
      },
      pure.generateSecretKey()
    );

    const response = authService.login("ephemeral", event as any);
    expect(response.status).toBe(422);
  });
});

afterAll(async () => {
  await rm(TEST_DB_PATH, { force: true });
});
