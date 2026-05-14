import { describe, expect, it } from "vitest";
import { EXPLORER_INSTRUCTIONS } from "./explorer-agent";

/**
 * Catalog-binding tests.
 *
 * Per the lesson banked in PR #309 (`mode: "standalone"` preamble leaked raw
 * JSON into chat prose), binding-existence tests catch regressions but DON'T
 * catch bug-shape issues. These tests assert BOTH:
 *
 *   • Presence: the inlined catalog is actually present (canary names from
 *     `@float/render-catalog` appear in the prompt).
 *   • Absence: the standalone-mode preamble does NOT appear. If `catalog.prompt`
 *     is ever called with `mode: "standalone"` (or with no mode at all once
 *     defaults change), the prompt would include "Output JSONL ... no surrounding
 *     text" — which is the exact phrasing the model latched onto last time it
 *     leaked raw ops into chat. Assert its absence as an invariant.
 */
describe("EXPLORER_INSTRUCTIONS — catalog binding", () => {
  it("inlines catalog component vocabulary (presence)", () => {
    // Canary components from the explorer catalog. If the catalog binding
    // breaks or the catalog is no longer inlined, these go missing.
    expect(EXPLORER_INSTRUCTIONS).toContain("ObservationCard");
    expect(EXPLORER_INSTRUCTIONS).toContain("BlockRef");
    expect(EXPLORER_INSTRUCTIONS).toContain("PageRef");
  });

  it("uses inline mode preamble (text + JSONL in spec fences)", () => {
    // The inline-mode preamble explicitly mentions ```spec fences. If this
    // disappears, the catalog likely flipped to standalone mode (the bug we
    // fixed in PR #309 commit fddac0c).
    expect(EXPLORER_INSTRUCTIONS).toMatch(/```spec/);
  });

  it("does NOT emit standalone-mode 'JSON on stdout' guidance (bug-shape absence)", () => {
    // The standalone preamble says variants of "Output JSONL (one JSON object
    // per line)" and "ONLY JSON" — when this slips into the chat prompt, the
    // model dumps raw ops into prose. Assert its absence.
    expect(EXPLORER_INSTRUCTIONS).not.toMatch(/output only json/i);
    expect(EXPLORER_INSTRUCTIONS).not.toMatch(/no surrounding text/i);
    expect(EXPLORER_INSTRUCTIONS).not.toMatch(/respond with only json/i);
  });

  it("does NOT instruct against markdown fences (another standalone telltale)", () => {
    // Standalone mode tells the model "No markdown fences" — directly
    // contradicts our inline-mode requirement that JSONL be IN a ```spec
    // fence. Absence of this phrasing is a load-bearing invariant.
    expect(EXPLORER_INSTRUCTIONS).not.toMatch(/no markdown fences/i);
  });

  it("keeps the explorer prose preamble intact", () => {
    // Sanity check that the human-written portion (graph vocabulary, tools)
    // hasn't been accidentally truncated when the catalog was appended.
    expect(EXPLORER_INSTRUCTIONS).toContain("knowledge graph called floatty");
    expect(EXPLORER_INSTRUCTIONS).toContain("get_block");
  });
});
