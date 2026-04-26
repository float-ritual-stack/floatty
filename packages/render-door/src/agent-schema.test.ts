/**
 * Snapshot + invariant tests for the agent-side schemas.
 *
 * Why this exists: catalog edits silently drift the constraints we ship to
 * the LLM. A contributor adds a `record(...)`-typed prop; in strict mode it
 * collapses to opaque per `~/projects/_reference/json-render/packages/core/
 * src/schema.ts:1486-1500` and the `--json-schema` decoder stops constraining
 * it. In loose mode the same change is fine, but `BBS_AGENT_REQUEST_SCHEMA`
 * must keep `additionalProperties: false` at the top so unexpected new
 * top-level fields don't slip through unflagged.
 *
 * These tests freeze the contract. When they fail, that is the catch — open
 * the diff, decide whether the catalog change should be reflected in the
 * agent contract (regenerate the snapshot) or backed out.
 *
 * See `<floatty-repo>/.claude/rules/render-door-agent.md` for the operational
 * rule and `apps/outline-explorer/.claude/skills/designing-json-render-
 * catalogs/SKILL.md` for the catalog↔agent contract section.
 */

import { describe, it, expect } from 'vitest';
import {
  BBS_SPEC_JSON_SCHEMA_STRICT,
  BBS_SPEC_JSON_SCHEMA_LOOSE,
  BBS_AGENT_REQUEST_SCHEMA,
} from './agent-schema';
import { bbsCatalog } from './catalog';

type JsonSchema = Record<string, unknown> & {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: unknown[];
};

function isObjectSchema(s: unknown): s is JsonSchema {
  return typeof s === 'object' && s !== null;
}

function walk(schema: unknown, visit: (node: JsonSchema, path: string) => void, path = '$'): void {
  if (!isObjectSchema(schema)) return;
  visit(schema, path);
  if (schema.properties) {
    for (const [k, v] of Object.entries(schema.properties)) {
      walk(v, visit, `${path}.properties.${k}`);
    }
  }
  if (schema.items) walk(schema.items, visit, `${path}.items`);
  if (typeof schema.additionalProperties === 'object') {
    walk(schema.additionalProperties, visit, `${path}.additionalProperties`);
  }
}

// =============================================================================
// BBS_SPEC_JSON_SCHEMA_STRICT — envelope-only protection
// =============================================================================

describe('BBS_SPEC_JSON_SCHEMA_STRICT', () => {
  const strict = BBS_SPEC_JSON_SCHEMA_STRICT as JsonSchema;

  it('matches LLM-strict subset constraints (additionalProperties: false everywhere)', () => {
    walk(strict, (node, path) => {
      if (node.type === 'object') {
        expect(
          node.additionalProperties,
          `${path}: strict-mode object must set additionalProperties: false`,
        ).toBe(false);
      }
    });
  });

  it('declares root + elements + (extension) state at top level, both required', () => {
    expect(strict.required).toEqual(expect.arrayContaining(['root', 'elements']));
    expect(Object.keys(strict.properties || {}).sort()).toEqual(['elements', 'root']);
  });

  it('collapses elements (record-typed) to an opaque object — known caveat', () => {
    // This is the documented strict-mode caveat: record-keyed fields can't be
    // expressed in the LLM strict subset. If this test starts failing because
    // the collapse no longer happens, that's a json-render upstream change
    // worth investigating — the strict path may have become usable.
    const elements = strict.properties?.elements;
    expect(elements?.type).toBe('object');
    expect(elements?.properties).toEqual({});
    expect(elements?.additionalProperties).toBe(false);
  });
});

// =============================================================================
// BBS_SPEC_JSON_SCHEMA_LOOSE — per-element type/props protection
// =============================================================================

describe('BBS_SPEC_JSON_SCHEMA_LOOSE', () => {
  const loose = BBS_SPEC_JSON_SCHEMA_LOOSE as JsonSchema;

  it('preserves the per-element type enum from the catalog', () => {
    const elementSchema = (loose.properties?.elements?.additionalProperties) as JsonSchema | undefined;
    const typeField = elementSchema?.properties?.type;
    expect(typeField?.enum, 'elements[*].type should expose enum from catalog.componentNames').toBeDefined();
    expect((typeField?.enum as string[]).length, 'should constrain to at least 10 named components').toBeGreaterThan(10);

    // Spot-check a few well-known component names — these are part of the
    // catalog's stable surface; if they disappear the catalog has been
    // restructured and this test should fail loudly.
    const names = new Set(typeField?.enum as string[]);
    for (const known of ['Card', 'Text', 'Stack', 'Section']) {
      expect(names, `loose schema must include "${known}" as a valid type`).toContain(known);
    }
  });

  it('keeps additionalProperties: false at the top so unknown top-level fields are caught', () => {
    expect(loose.additionalProperties).toBe(false);
  });
});

// =============================================================================
// BBS_AGENT_REQUEST_SCHEMA — the schema actually shipped to claude --json-schema
// =============================================================================

describe('BBS_AGENT_REQUEST_SCHEMA', () => {
  const agent = BBS_AGENT_REQUEST_SCHEMA as JsonSchema;

  it('extends loose with optional title + state at top level', () => {
    const props = agent.properties;
    expect(props).toBeDefined();
    expect(props).toMatchObject({
      title: { type: 'string' },
      state: { type: 'object' },
      // root + elements come from the loose base
      root: expect.any(Object),
      elements: expect.any(Object),
    });
  });

  it('keeps required: ["root", "elements"] (title + state are optional)', () => {
    expect(agent.required?.sort()).toEqual(['elements', 'root']);
  });

  it('keeps additionalProperties: false at the top — unknown fields are caught', () => {
    expect(agent.additionalProperties).toBe(false);
  });

  it('inherits the per-element type enum from the catalog (no drift from loose)', () => {
    const elementSchema = (agent.properties?.elements?.additionalProperties) as JsonSchema | undefined;
    const typeField = elementSchema?.properties?.type;
    const names = typeField?.enum as string[] | undefined;
    expect(names).toBeDefined();
    // Sanity: agent schema's type enum should match catalog.componentNames.
    expect(new Set(names)).toEqual(new Set(bbsCatalog.componentNames));
  });
});

// =============================================================================
// Round-trip — bbsCatalog.validate accepts a minimal valid spec
// =============================================================================

describe('bbsCatalog.validate', () => {
  it('accepts a minimal Card-with-Text spec', () => {
    const spec = {
      root: 'card',
      elements: {
        card: { type: 'Card', props: { title: 'hi' }, children: ['text'] },
        text: { type: 'Text', props: { content: 'hello' }, children: [] },
      },
    };
    const result = bbsCatalog.validate(spec);
    expect(result.success, JSON.stringify(result.error?.message)).toBe(true);
  });

  it('rejects an unknown component type (defense the constrained decoder also enforces)', () => {
    const spec = {
      root: 'x',
      elements: {
        x: { type: 'NotARealComponent', props: {}, children: [] },
      },
    };
    const result = bbsCatalog.validate(spec);
    expect(result.success).toBe(false);
  });
});
