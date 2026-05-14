// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { invalidateBlockSessions, useBlockSessions } from "./use-block-sessions";
import type { SessionListItem } from "@/lib/sessions/types";

function mockFetchOnce(sessions: SessionListItem[], opts: { delay?: number; status?: number } = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
    if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay));
    return new Response(JSON.stringify({ sessions }), {
      status: opts.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

const session = (id: string, title = `t-${id}`): SessionListItem => ({
  id,
  title,
  createdAt: 1,
  updatedAt: 2,
  preview: "",
});

beforeEach(() => {
  invalidateBlockSessions();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useBlockSessions", () => {
  it("fetches sessions for a block id", async () => {
    const spy = mockFetchOnce([session("a"), session("b")]);
    const { result } = renderHook(() => useBlockSessions("block-1"));

    await waitFor(() => expect(result.current.sessions).toHaveLength(2));
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    // URL-encoded blockId in the path
    expect((spy.mock.calls[0][0] as string)).toContain("blockId=block-1");
  });

  it("dedupes across instances via module-level cache", async () => {
    const spy = mockFetchOnce([session("a")]);
    const { result: r1 } = renderHook(() => useBlockSessions("block-cache"));
    await waitFor(() => expect(r1.current.sessions).toHaveLength(1));

    // Second mount should NOT trigger another fetch — cache hit.
    const { result: r2 } = renderHook(() => useBlockSessions("block-cache"));
    await waitFor(() => expect(r2.current.sessions).toHaveLength(1));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("refetch() bypasses cache", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessions: [session("v1")] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessions: [session("v2")] }), { status: 200 }));

    const { result } = renderHook(() => useBlockSessions("block-refetch"));
    await waitFor(() => expect(result.current.sessions[0]?.id).toBe("v1"));

    result.current.refetch();
    await waitFor(() => expect(result.current.sessions[0]?.id).toBe("v2"));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("surfaces fetch errors via the error field", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network down"));
    const { result } = renderHook(() => useBlockSessions("block-err"));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.message).toContain("network down");
    expect(result.current.sessions).toEqual([]);
  });

  it("no-ops when blockId is null", () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const { result } = renderHook(() => useBlockSessions(null));
    expect(result.current.sessions).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("no-ops when enabled=false", () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const { result } = renderHook(() => useBlockSessions("block-disabled", { enabled: false }));
    expect(result.current.sessions).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("non-OK response sets error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("nope", { status: 500 })
    );
    const { result } = renderHook(() => useBlockSessions("block-500"));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.message).toContain("500");
  });

  it("invalidateBlockSessions(id) clears single entry", async () => {
    mockFetchOnce([session("first")]);
    const { result: r1 } = renderHook(() => useBlockSessions("block-clear"));
    await waitFor(() => expect(r1.current.sessions).toHaveLength(1));

    invalidateBlockSessions("block-clear");

    // Next mount should fetch again.
    mockFetchOnce([session("second")]);
    const { result: r2 } = renderHook(() => useBlockSessions("block-clear"));
    await waitFor(() => expect(r2.current.sessions[0]?.id).toBe("second"));
  });
});
