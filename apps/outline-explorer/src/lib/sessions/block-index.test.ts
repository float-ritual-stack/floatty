import { describe, expect, it } from "vitest";
import { extractBlockRefs, extractWikilinks } from "./block-index";

describe("extractWikilinks (bracket-balanced scan)", () => {
  it("extracts simple [[wikilinks]]", () => {
    expect(extractWikilinks("see [[FLO-679]] and [[FLO-680]]")).toEqual([
      "FLO-679",
      "FLO-680",
    ]);
  });

  it("strips aliases ([[target|alias]] → target)", () => {
    expect(extractWikilinks("link to [[2026-04-22|the daddy session]]")).toEqual([
      "2026-04-22",
    ]);
  });

  it("handles nested brackets — [[outer [[inner]]]]", () => {
    // Per inlineParser semantics, the OUTER target wins (the inner is part of
    // the outer's name). This matches the floatty rendering of nested links.
    const result = extractWikilinks("ref [[meeting:: [[scott-sync]]]]");
    expect(result).toContain("meeting:: [[scott-sync]]");
  });

  it("ignores unclosed brackets", () => {
    expect(extractWikilinks("dangling [[unclosed")).toEqual([]);
  });

  it("returns empty for plain text", () => {
    expect(extractWikilinks("no links here at all")).toEqual([]);
  });

  it("trims whitespace inside targets", () => {
    expect(extractWikilinks("[[  spaced  ]]")).toEqual(["spaced"]);
  });
});

describe("extractBlockRefs", () => {
  const uuid = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, "0")}`;

  it("captures origin context refs", () => {
    const refs = extractBlockRefs({
      messages: [],
      originPageId: uuid("01"),
      originSelectedIds: [uuid("02"), uuid("03")],
    });
    expect(refs.map((r) => r.source).sort()).toEqual([
      "context",
      "context",
      "context",
    ]);
    expect(refs.map((r) => r.blockId).sort()).toEqual(
      [uuid("01"), uuid("02"), uuid("03")].sort()
    );
  });

  it("derives tool-output refs from tool-* part inputs and outputs", () => {
    const refs = extractBlockRefs({
      messages: [
        {
          id: "m1",
          role: "assistant",
          parts: [
            {
              type: "tool-get_block",
              state: "output-available",
              input: { blockId: uuid("aa") },
              output: { block: { id: uuid("bb"), content: "..." } },
            },
          ],
        } as never,
      ],
    });
    const ids = refs.filter((r) => r.source === "tool-output").map((r) => r.blockId);
    expect(ids).toContain(uuid("aa"));
    expect(ids).toContain(uuid("bb"));
  });

  it("derives wikilink refs from assistant text", () => {
    const refs = extractBlockRefs({
      messages: [
        {
          id: "m1",
          role: "assistant",
          parts: [{ type: "text", text: "see [[FLO-679]] and [[2026-04-22|daddy]]" }],
        } as never,
      ],
    });
    const wikis = refs.filter((r) => r.source === "wikilink").map((r) => r.blockId);
    expect(wikis).toContain("page:FLO-679");
    expect(wikis).toContain("page:2026-04-22");
  });

  it("recognizes UUID-shaped wikilinks as bare IDs (no page: prefix)", () => {
    const refs = extractBlockRefs({
      messages: [
        {
          id: "m1",
          role: "assistant",
          parts: [{ type: "text", text: `direct ref [[${uuid("ff")}]]` }],
        } as never,
      ],
    });
    expect(refs.some((r) => r.blockId === uuid("ff") && r.source === "wikilink")).toBe(true);
  });

  it("dedupes (blockId, source) tuples — multiple appearances collapse", () => {
    const refs = extractBlockRefs({
      messages: [
        {
          id: "m1",
          role: "assistant",
          parts: [
            { type: "text", text: "first [[FLO-1]]" },
            { type: "text", text: "again [[FLO-1]] and [[FLO-1]]" },
          ],
        } as never,
      ],
    });
    expect(refs.filter((r) => r.blockId === "page:FLO-1" && r.source === "wikilink")).toHaveLength(1);
  });

  it("same blockId can appear under multiple sources without dedup colliding", () => {
    const refs = extractBlockRefs({
      messages: [
        {
          id: "m1",
          role: "assistant",
          parts: [
            {
              type: "tool-get_block",
              state: "output-available",
              input: { blockId: uuid("01") },
              output: {},
            },
            { type: "text", text: `[[${uuid("01")}]]` },
          ],
        } as never,
      ],
      originPageId: uuid("01"),
    });
    const sources = refs.filter((r) => r.blockId === uuid("01")).map((r) => r.source).sort();
    expect(sources).toEqual(["context", "tool-output", "wikilink"]);
  });

  it("walks data-spec parts and pulls blockId / target / page fields", () => {
    const refs = extractBlockRefs({
      messages: [
        {
          id: "m1",
          role: "assistant",
          parts: [
            {
              type: "data-spec",
              data: {
                root: "main",
                elements: {
                  main: {
                    type: "BlockRef",
                    props: { blockId: uuid("c1") },
                  },
                  ref2: {
                    type: "PageRef",
                    props: { target: "FLO-679" },
                  },
                },
              },
            },
          ],
        } as never,
      ],
    });
    const ids = refs.filter((r) => r.source === "wikilink").map((r) => r.blockId).sort();
    expect(ids).toContain(uuid("c1"));
    expect(ids).toContain("page:FLO-679");
  });

  it("ignores non-array parts gracefully", () => {
    const refs = extractBlockRefs({
      messages: [{ id: "m1", role: "user" } as never],
    });
    expect(refs).toEqual([]);
  });
});
