// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { SessionPicker } from "./session-picker";
import type { SessionListItem } from "@/lib/sessions/types";

function session(id: string, title = `t-${id}`, preview = ""): SessionListItem {
  return { id, title, createdAt: 1, updatedAt: 2, preview };
}

function mockListResponse(sessions: SessionListItem[]) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.includes("/api/sessions") && !url.includes("/api/sessions/")) {
      return new Response(JSON.stringify({ sessions }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("SessionPicker", () => {
  it("opens on trigger click and lists fetched sessions", async () => {
    mockListResponse([session("a", "Alpha"), session("b", "Beta")]);
    render(<SessionPicker activeSessionId={null} onLoad={vi.fn()} />);

    fireEvent.click(screen.getByLabelText("Open session history"));
    await waitFor(() => expect(screen.getByText("Alpha")).toBeTruthy());
    expect(screen.getByText("Beta")).toBeTruthy();
  });

  it("calls onLoad when a session row is clicked (non-active)", async () => {
    mockListResponse([session("a", "Alpha")]);
    const onLoad = vi.fn();
    render(<SessionPicker activeSessionId={null} onLoad={onLoad} />);

    fireEvent.click(screen.getByLabelText("Open session history"));
    await waitFor(() => expect(screen.getByText("Alpha")).toBeTruthy());

    fireEvent.click(screen.getByText("Alpha"));
    await waitFor(() => expect(onLoad).toHaveBeenCalledTimes(1));
    expect(onLoad).toHaveBeenCalledWith({ id: "a", title: "Alpha" });
  });

  it("does NOT call onLoad when clicking the currently active row", async () => {
    mockListResponse([session("a", "Alpha")]);
    const onLoad = vi.fn();
    render(<SessionPicker activeSessionId="a" onLoad={onLoad} />);

    fireEvent.click(screen.getByLabelText("Open session history"));
    await waitFor(() => expect(screen.getByText("Alpha")).toBeTruthy());

    fireEvent.click(screen.getByText("Alpha"));
    // Allow microtasks to flush
    await waitFor(() => expect(true).toBe(true));
    expect(onLoad).not.toHaveBeenCalled();
  });

  it("filters by title and preview when the search box is typed in", async () => {
    mockListResponse([
      session("a", "Alpha", "first preview"),
      session("b", "Beta", "second"),
      session("c", "Carlos", "third"),
    ]);
    render(<SessionPicker activeSessionId={null} onLoad={vi.fn()} />);

    fireEvent.click(screen.getByLabelText("Open session history"));
    await waitFor(() => expect(screen.getByText("Alpha")).toBeTruthy());

    const search = screen.getByPlaceholderText("search sessions…");
    fireEvent.change(search, { target: { value: "Bet" } });

    expect(screen.queryByText("Alpha")).toBeNull();
    expect(screen.getByText("Beta")).toBeTruthy();
    expect(screen.queryByText("Carlos")).toBeNull();
  });

  it("disabled prop blocks the trigger", () => {
    mockListResponse([]);
    render(<SessionPicker activeSessionId={null} onLoad={vi.fn()} disabled />);
    expect((screen.getByLabelText("Open session history") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows empty-state copy when no sessions exist", async () => {
    mockListResponse([]);
    render(<SessionPicker activeSessionId={null} onLoad={vi.fn()} />);

    fireEvent.click(screen.getByLabelText("Open session history"));
    await waitFor(() => expect(screen.getByText("no sessions yet")).toBeTruthy());
  });

  it("shows 'no matches' when search filters everything out", async () => {
    mockListResponse([session("a", "Alpha")]);
    render(<SessionPicker activeSessionId={null} onLoad={vi.fn()} />);

    fireEvent.click(screen.getByLabelText("Open session history"));
    await waitFor(() => expect(screen.getByText("Alpha")).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText("search sessions…"), {
      target: { value: "zzzz-no-match" },
    });
    expect(screen.getByText("no matches")).toBeTruthy();
  });
});
