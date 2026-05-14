/**
 * Session persistence types.
 *
 * `SessionRow` matches the `sessions` table 1:1; `messages_json` is the
 * serialized UIMessage[] from useChat. Re-hydrate via JSON.parse.
 *
 * `SessionBlockRow` matches the `session_blocks` table 1:1 — bidirectional
 * index between sessions and the floatty blocks they touched.
 */

import type { UIMessage } from "ai";

export interface SessionRow {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messagesJson: string;
  originPageId: string | null;
  originSelected: string | null;
}

export type SessionBlockSource = "context" | "tool-output" | "wikilink";

export interface SessionBlockRow {
  sessionId: string;
  blockId: string;
  source: SessionBlockSource;
  touchedAt: number;
}

/** Hydrated session — messages parsed back into the array. */
export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: UIMessage[];
  originPageId: string | null;
  originSelected: string[];
}

export interface CreateSessionInput {
  title?: string;
  originPageId?: string | null;
  originSelectedIds?: string[];
}

export interface UpdateSessionInput {
  title?: string;
  messages?: UIMessage[];
  /** When messages change, the route handler also re-derives session_blocks. */
  blockRefs?: Array<{ blockId: string; source: SessionBlockSource }>;
}

export interface SessionListItem {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** First user message preview (up to 100 chars). */
  preview: string;
}
