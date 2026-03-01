/**
 * extractTo:: Door
 *
 * Block door: reparents the current block (with children) under a page in pages::,
 * leaving a breadcrumb `extractedTo:: [[PageName]]` at the original position.
 *
 * Usage: `extractTo:: [[PageName]]`
 *
 * Compile: node scripts/compile-door.mjs doors/extractTo/extractTo.tsx
 */

// ═══════════════════════════════════════════════════════════════
// TYPES (inline — doors are self-contained)
// ═══════════════════════════════════════════════════════════════

interface ScopedActions {
  createBlockInside(parentId: string): string;
  createBlockInsideAtTop(parentId: string): string;
  createBlockAfter(afterId: string): string;
  updateBlockContent(id: string, content: string): void;
  deleteBlock(id: string): boolean;
  moveBlock(blockId: string, targetParentId: string | null, targetIndex: number): boolean;
  getBlock(id: string): any;
  getParentId(id: string): string | undefined;
  getChildren(id: string): string[];
  rootIds(): readonly string[];
  setBlockOutput(id: string, output: unknown, outputType: string): void;
  setBlockStatus(id: string, status: 'idle' | 'running' | 'complete' | 'error'): void;
  focusBlock(id: string): void;
}

interface DoorContext {
  server: { url: string; wsUrl: string; fetch(path: string, init?: RequestInit): Promise<Response> };
  actions: ScopedActions;
  settings: Record<string, unknown>;
  blockId: string;
  content: string;
  doorId: string;
  log: (...args: unknown[]) => void;
  fs: any;
  fetch: any;
  invoke: any;
}

interface BlockDoor {
  kind: 'block';
  prefixes: string[];
  execute(blockId: string, content: string, ctx: DoorContext): Promise<void>;
  view?: never;
}

interface DoorMeta {
  id: string;
  name: string;
  description?: string;
  version?: string;
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

/** Parse extract variants:
 *  - `extractTo:: [[PageName]] optional trailing` → pageName + trailing
 *  - `extract:: page name here` → pageName = everything after prefix, no trailing
 */
function parseTarget(content: string): { pageName: string; trailing: string } | null {
  // extractTo:: [[PageName]] with optional trailing content
  const toMatch = content.match(/^extractTo::\s*\[\[(.+?)\]\](.*)/is);
  if (toMatch) return { pageName: toMatch[1].trim(), trailing: toMatch[2].trim() };

  // extract:: everything after is the page name (strip heading markers)
  const bareMatch = content.match(/^extract::\s*(.+)/is);
  if (bareMatch) {
    const raw = bareMatch[1].trim().replace(/^#+\s*/, '');
    return { pageName: raw, trailing: '' };
  }

  return null;
}

/** Find the `pages::` container block among root blocks */
function findPagesContainer(actions: ScopedActions): string | null {
  const roots = actions.rootIds();
  for (const id of roots) {
    const block = actions.getBlock(id) as { content?: string } | undefined;
    if (block?.content?.trim() === 'pages::') return id;
  }
  return null;
}

/** Find existing page under pages:: by name (case-insensitive, strips `# ` prefix) */
function findPageBlock(actions: ScopedActions, pagesId: string, pageName: string): string | null {
  const children = actions.getChildren(pagesId);
  const target = pageName.toLowerCase();
  for (const childId of children) {
    const block = actions.getBlock(childId) as { content?: string } | undefined;
    const content = block?.content?.trim() ?? '';
    // Pages are stored with `# ` prefix
    const stripped = content.startsWith('# ') ? content.slice(2).trim() : content;
    if (stripped.toLowerCase() === target) return childId;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// DOOR
// ═══════════════════════════════════════════════════════════════

export const door: BlockDoor = {
  kind: 'block',
  prefixes: ['extractto::', 'extract::'],

  async execute(blockId: string, content: string, ctx: DoorContext): Promise<void> {
    const { actions, log } = ctx;

    // 1. Parse target page name + trailing content
    const parsed = parseTarget(content);
    if (!parsed) {
      log('Could not parse page name from:', content);
      actions.updateBlockContent(blockId, `extractTo:: ERROR: expected [[PageName]]`);
      return;
    }
    const { pageName, trailing } = parsed;

    // Detect which variant: extractTo:: has trailing (or [[PageName]]), extract:: has empty trailing
    const isExtractTo = /^extractTo::/i.test(content);

    // 2. Find or create pages:: container
    let pagesId = findPagesContainer(actions);
    if (!pagesId) {
      log('No pages:: container found, creating one');
      const roots = actions.rootIds();
      if (roots.length > 0) {
        pagesId = actions.createBlockAfter(roots[roots.length - 1]);
      } else {
        log('Empty document, cannot extract');
        actions.updateBlockContent(blockId, `extractTo:: ERROR: document is empty`);
        return;
      }
      actions.updateBlockContent(pagesId, 'pages::');
    }

    // 3. Find or create page under pages::
    let pageBlockId = findPageBlock(actions, pagesId, pageName);
    if (!pageBlockId) {
      log('Creating page:', pageName);
      pageBlockId = actions.createBlockInside(pagesId);
      actions.updateBlockContent(pageBlockId, `# ${pageName}`);
    }

    if (isExtractTo) {
      // ═══ extractTo:: [[PageName]] optional trailing ═══
      // Block + children move together to page, breadcrumb left behind

      // 4. Snapshot original position BEFORE move
      const oldParentId = actions.getParentId(blockId);
      const oldSiblings = oldParentId ? actions.getChildren(oldParentId) : [...actions.rootIds()];
      const blockIndex = oldSiblings.indexOf(blockId);
      const prevSiblingId = blockIndex > 0 ? oldSiblings[blockIndex - 1] : null;

      // 5. Rewrite block content — strip extractTo:: prefix, keep trailing text
      if (trailing) {
        actions.updateBlockContent(blockId, trailing);
      } else {
        actions.updateBlockContent(blockId, `(extracted to [[${pageName}]])`);
      }

      // 6. Move block (with children) to target page at position 0
      const moved = actions.moveBlock(blockId, pageBlockId, 0);
      if (!moved) {
        log('moveBlock failed');
        actions.updateBlockContent(blockId, `extractTo:: ERROR: move failed`);
        return;
      }

      // 7. Create breadcrumb at original position
      const breadcrumbContent = `extractedTo:: [[${pageName}]]`;
      let breadcrumbId: string;

      if (prevSiblingId) {
        breadcrumbId = actions.createBlockAfter(prevSiblingId);
      } else if (oldParentId) {
        breadcrumbId = actions.createBlockInsideAtTop(oldParentId);
      } else {
        const currentRoots = actions.rootIds();
        if (currentRoots.length > 0) {
          breadcrumbId = actions.createBlockAfter(currentRoots[0]);
        } else {
          breadcrumbId = actions.createBlockInside(pagesId);
        }
      }

      actions.updateBlockContent(breadcrumbId, breadcrumbContent);
      log(`extractTo:: moved block+children to [[${pageName}]], breadcrumb at ${breadcrumbId}`);

    } else {
      // ═══ extract:: page name here ═══
      // Children reparented directly under page, block becomes breadcrumb in-place

      // 4. Reparent each child to the page (in order)
      const childIds = actions.getChildren(blockId);
      for (let i = 0; i < childIds.length; i++) {
        const moved = actions.moveBlock(childIds[i], pageBlockId, i);
        if (!moved) {
          log(`moveBlock failed for child ${childIds[i]}`);
        }
      }

      // 5. Block stays in place, becomes the breadcrumb
      actions.updateBlockContent(blockId, `extractedTo:: [[${pageName}]]`);
      log(`extract:: reparented ${childIds.length} children to [[${pageName}]], block is breadcrumb`);
    }
  },
};

export const meta: DoorMeta = {
  id: 'extractTo',
  name: 'Extract to Page',
  version: '0.1.0',
};
