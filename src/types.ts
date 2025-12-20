export type TodoState = "new" | "ready" | "in_progress" | "done";
export type TodoPriority = "rock" | "pebble" | "sand";

export type Session = {
  token: string;
  pubkey: string;
  npub: string;
  method: LoginMethod;
  createdAt: number;
};

export type LoginMethod = "ephemeral" | "extension" | "bunker" | "secret";
