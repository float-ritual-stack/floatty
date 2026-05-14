import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSession,
  deleteSession,
  getSession,
  getSessionBlocks,
  listSessions,
  listSessionsByBlock,
  resetDb,
  updateSession,
} from "./store";

beforeEach(() => {
  process.env.OUTLINE_EXPLORER_DB = ":memory:";
  resetDb();
});

afterEach(() => {
  resetDb();
});

describe("session store CRUD", () => {
  it("creates + retrieves a session", () => {
    const created = createSession({ title: "first" });
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.title).toBe("first");
    expect(created.messages).toEqual([]);

    const fetched = getSession(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(created.id);
    expect(fetched?.title).toBe("first");
  });

  it("defaults title when omitted", () => {
    const s = createSession();
    expect(s.title).toBe("New conversation");
  });

  it("truncates absurdly long titles to 200 chars", () => {
    const long = "x".repeat(500);
    const s = createSession({ title: long });
    expect(s.title.length).toBe(200);
  });

  it("returns null for missing session", () => {
    expect(getSession("nope")).toBeNull();
  });

  it("updates messages and reflects in subsequent reads", () => {
    const s = createSession();
    const msgs = [
      {
        id: "m1",
        role: "user",
        parts: [{ type: "text", text: "hello" }],
      },
    ];

    const updated = updateSession(s.id, { messages: msgs as never });
    expect(updated).not.toBeNull();
    expect(updated?.messages).toHaveLength(1);

    const refetched = getSession(s.id);
    expect(refetched?.messages).toHaveLength(1);
    expect(refetched?.updatedAt).toBeGreaterThanOrEqual(s.createdAt);
  });

  it("update on missing session returns null", () => {
    expect(updateSession("nope", { title: "x" })).toBeNull();
  });

  it("delete removes session and cascades to session_blocks", () => {
    const s = createSession();
    updateSession(s.id, {
      messages: [],
      blockRefs: [
        { blockId: "block-1", source: "context" },
        { blockId: "block-2", source: "tool-output" },
      ],
    });
    expect(getSessionBlocks(s.id)).toHaveLength(2);

    const ok = deleteSession(s.id);
    expect(ok).toBe(true);
    expect(getSession(s.id)).toBeNull();
    expect(getSessionBlocks(s.id)).toHaveLength(0);
  });

  it("delete on missing session returns false", () => {
    expect(deleteSession("nope")).toBe(false);
  });
});

describe("session listing", () => {
  it("returns sessions ordered by updated_at desc", async () => {
    const a = createSession({ title: "older" });
    // Force the second session to have a strictly later updated_at, even if
    // Date.now() rolls within the same millisecond.
    await new Promise((r) => setTimeout(r, 2));
    const b = createSession({ title: "newer" });

    const list = listSessions();
    expect(list[0].id).toBe(b.id);
    expect(list[1].id).toBe(a.id);
  });

  it("preview pulls from the first user message text", () => {
    const s = createSession();
    updateSession(s.id, {
      messages: [
        { id: "m1", role: "user", parts: [{ type: "text", text: "what is FLO-679?" }] },
        { id: "m2", role: "assistant", parts: [{ type: "text", text: "long answer" }] },
      ] as never,
    });
    const list = listSessions();
    expect(list[0].preview).toBe("what is FLO-679?");
  });

  it("respects limit + offset", () => {
    for (let i = 0; i < 5; i++) createSession({ title: `s${i}` });
    expect(listSessions({ limit: 2 })).toHaveLength(2);
    expect(listSessions({ limit: 2, offset: 4 })).toHaveLength(1);
  });
});

describe("session_blocks index (bidirectional lookup)", () => {
  it("listSessionsByBlock returns sessions that touched a given block", () => {
    const a = createSession({ title: "a" });
    const b = createSession({ title: "b" });
    const c = createSession({ title: "c" });

    updateSession(a.id, {
      messages: [],
      blockRefs: [{ blockId: "block-1", source: "tool-output" }],
    });
    updateSession(b.id, {
      messages: [],
      blockRefs: [
        { blockId: "block-1", source: "wikilink" },
        { blockId: "block-2", source: "context" },
      ],
    });
    updateSession(c.id, {
      messages: [],
      blockRefs: [{ blockId: "block-99", source: "context" }],
    });

    const hits = listSessionsByBlock("block-1");
    expect(hits.map((h) => h.id).sort()).toEqual([a.id, b.id].sort());

    const noHits = listSessionsByBlock("block-99");
    expect(noHits.map((h) => h.id)).toEqual([c.id]);
  });

  it("primary-key constraint prevents duplicate (session, block, source) rows", () => {
    const s = createSession();
    // Insert same triple twice — second call (via re-update) replaces, so no
    // duplicate accumulates.
    updateSession(s.id, {
      messages: [],
      blockRefs: [
        { blockId: "block-1", source: "context" },
        { blockId: "block-1", source: "context" },
      ],
    });
    expect(getSessionBlocks(s.id)).toHaveLength(1);

    // Same block under different sources IS allowed.
    updateSession(s.id, {
      messages: [],
      blockRefs: [
        { blockId: "block-1", source: "context" },
        { blockId: "block-1", source: "wikilink" },
      ],
    });
    expect(getSessionBlocks(s.id)).toHaveLength(2);
  });

  it("replaces session_blocks on update (no stale rows)", () => {
    const s = createSession();
    updateSession(s.id, {
      messages: [],
      blockRefs: [{ blockId: "block-1", source: "context" }],
    });
    updateSession(s.id, {
      messages: [],
      blockRefs: [{ blockId: "block-2", source: "context" }],
    });
    const blocks = getSessionBlocks(s.id);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].blockId).toBe("block-2");
  });
});
