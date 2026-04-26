/**
 * render:: door catalog — Zod schema catalog for @json-render/solid
 *
 * Defines the component vocabulary that LLMs and specs target.
 * 44 components + 3 actions. Single source of truth for both
 * prompt generation (catalog.prompt()) and runtime rendering.
 */

import { z } from 'zod';
import { defineCatalog } from '@json-render/core';
import { schema } from '@json-render/solid/schema';
import {
  sharedComponentDefinitions,
  doorComponentDefinitions,
} from '@float/render-catalog/components';

// ═══════════════════════════════════════════════════════════════
// CATALOG
// ═══════════════════════════════════════════════════════════════
//
// All component definitions live in @float/render-catalog. This file
// composes Set A (shared) + Set B (door-only) into a single catalog +
// declares door-specific actions.

export const bbsCatalog = defineCatalog(schema, {
  components: {
    ...sharedComponentDefinitions,
    ...doorComponentDefinitions,

  },

  actions: {
    navigate: {
      params: z.object({ target: z.string() }),
      description: 'Navigate to a page or block in the outline',
    },
    createChild: {
      params: z.object({ content: z.string() }),
      description: 'Create a child block under the current render:: block with the given content',
    },
    upsertChild: {
      params: z.object({ content: z.string(), match: z.string().optional(), prefix: z.string().optional() }),
      description: 'Find or create a child block by prefix match ("match" or "prefix" param). Updates content if found, creates if not.',
    },
    setState: {
      params: z.object({ statePath: z.string(), value: z.unknown() }),
      description: 'Set a value at a state path. Built-in — no handler needed. Used by FilterButtons/TabNav to switch views.',
    },
  },
});

export type BbsCatalog = typeof bbsCatalog;
