import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  resolvePropValue,
  createDirectiveRegistry,
  type PropResolutionContext,
} from "@json-render/core";
import {
  projectColorDirective,
  ctxColorDirective,
  wikilinkDirective,
  floattyDirectives,
  directiveOr,
} from "./directives";
import { UNKNOWN_COLOR } from "./colors";

function makeCtx(
  state: Record<string, unknown> = {},
  extra: Partial<PropResolutionContext> = {},
): PropResolutionContext {
  return {
    stateModel: state,
    directives: createDirectiveRegistry(floattyDirectives),
    ...extra,
  };
}

describe("$projectColor", () => {
  it("resolves a known project to its hex", () => {
    expect(resolvePropValue({ $projectColor: "floatty" }, makeCtx())).toBe(
      "#00e5ff",
    );
    expect(
      resolvePropValue({ $projectColor: "rangle/pharmacy" }, makeCtx()),
    ).toBe("#ffb300");
  });

  it("falls back to UNKNOWN_COLOR for unknown projects", () => {
    expect(
      resolvePropValue({ $projectColor: "made-up-project" }, makeCtx()),
    ).toBe(UNKNOWN_COLOR);
  });

  it("composes with $state for dynamic project lookup", () => {
    const ctx = makeCtx({ current: "floatty" });
    const result = resolvePropValue(
      { $projectColor: "floatty" }, // direct lookup keeps semantics
      ctx,
    );
    expect(result).toBe("#00e5ff");
    // Schema validation does NOT accept $state inside $projectColor today —
    // schema says z.string(). Documenting current contract; future enrichment
    // can widen to z.union([z.string(), stateExpression]).
    expect(ctx.directives?.get("$projectColor")).toBe(projectColorDirective);
  });
});

describe("$ctxColor", () => {
  it("resolves a known mode to its hex", () => {
    expect(resolvePropValue({ $ctxColor: "debugging" }, makeCtx())).toBe(
      "#ff4444",
    );
    expect(resolvePropValue({ $ctxColor: "meeting" }, makeCtx())).toBe(
      "#e040a0",
    );
  });

  it("falls back to UNKNOWN_COLOR for unknown modes", () => {
    expect(resolvePropValue({ $ctxColor: "not-a-mode" }, makeCtx())).toBe(
      UNKNOWN_COLOR,
    );
  });

  it("registry contains the ctxColor directive", () => {
    expect(makeCtx().directives?.get("$ctxColor")).toBe(ctxColorDirective);
  });
});

describe("$wikilink", () => {
  it("returns the target as a string (identity)", () => {
    expect(resolvePropValue({ $wikilink: "FLO-679" }, makeCtx())).toBe(
      "FLO-679",
    );
    expect(resolvePropValue({ $wikilink: "2026-05-13" }, makeCtx())).toBe(
      "2026-05-13",
    );
  });

  it("registry contains the wikilink directive", () => {
    expect(makeCtx().directives?.get("$wikilink")).toBe(wikilinkDirective);
  });
});

describe("floattyDirectives", () => {
  it("bundles standardDirectives + 3 floatty-specific entries", () => {
    // Count only the floatty-specific additions so the test doesn't break if
    // @json-render/directives gains or loses standardDirectives entries in
    // a future 0.19.x patch (Greptile suggestion on PR #308).
    const floattyNames = new Set(["$projectColor", "$ctxColor", "$wikilink"]);
    const floattyAdded = floattyDirectives.filter((d) =>
      floattyNames.has(d.name),
    );
    expect(floattyAdded).toHaveLength(3);
    const names = floattyDirectives.map((d) => d.name);
    // floatty-specific directives present
    expect(names).toContain("$projectColor");
    expect(names).toContain("$ctxColor");
    expect(names).toContain("$wikilink");
    // sanity-check that the bundled standardDirectives are still reachable
    // (drop entries if upstream removes them; don't pin to a fixed count).
    expect(names).toContain("$format");
    expect(names).toContain("$math");
    expect(names).toContain("$concat");
  });

  it("interleaves with $concat for composed agent emissions", () => {
    const ctx = makeCtx();
    const result = resolvePropValue(
      {
        $concat: ["see [[", { $wikilink: "FLO-679" }, "]] for details"],
      },
      ctx,
    );
    expect(result).toBe("see [[FLO-679]] for details");
  });
});

describe("directiveOr", () => {
  it("accepts plain string values", () => {
    const schema = directiveOr(z.string());
    expect(schema.safeParse("#00e5ff").success).toBe(true);
    expect(schema.safeParse("plain text").success).toBe(true);
  });

  it("accepts directive-shaped objects", () => {
    const schema = directiveOr(z.string());
    expect(schema.safeParse({ $projectColor: "floatty" }).success).toBe(true);
    expect(schema.safeParse({ $wikilink: "FLO-679" }).success).toBe(true);
  });

  it("rejects shapes that match neither branch", () => {
    const schema = directiveOr(z.string());
    expect(schema.safeParse(42).success).toBe(false);
    expect(schema.safeParse(true).success).toBe(false);
    expect(schema.safeParse(null).success).toBe(false);
  });

  it("rejects non-directive objects (keys must start with `$`)", () => {
    // CodeRabbit + Greptile flagged: previously z.record(z.string(), unknown)
    // accepted any object, so `{ color: "cyan" }` would pass validation but
    // resolve to undefined at render time (silent failure). Constrained the
    // record key shape to /^\$/ — non-directive objects now reject loudly.
    const schema = directiveOr(z.string());
    expect(schema.safeParse({ color: "cyan" }).success).toBe(false);
    expect(schema.safeParse({ foo: "bar", baz: 42 }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it("works with non-string base schemas (numeric slots)", () => {
    const schema = directiveOr(z.number());
    expect(schema.safeParse(42).success).toBe(true);
    expect(schema.safeParse({ $math: "add", a: 1, b: 2 }).success).toBe(true);
    expect(schema.safeParse("oops").success).toBe(false);
  });
});
