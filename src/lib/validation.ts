/**
 * validation.ts - Export validation (non-blocking warnings)
 *
 * FLO-349: Validates outline data before export. Returns warnings
 * but NEVER blocks export — user data access is P1.
 */

import type { ExportedOutline } from './jsonExport';

export type WarningType =
  | 'orphaned-block'
  | 'missing-child'
  | 'missing-root'
  | 'count-mismatch'
  | 'root-has-parent';

export interface ValidationWarning {
  type: WarningType;
  message: string;
  blockId?: string;
}

export interface ValidationResult {
  warnings: ValidationWarning[];
  canExport: true; // Always true — never block export
}

/**
 * Validate outline data and return warnings.
 * Always returns canExport: true.
 */
export function validateForExport(exported: ExportedOutline): ValidationResult {
  const warnings: ValidationWarning[] = [];

  // 1. Missing child references
  for (const [id, block] of Object.entries(exported.blocks)) {
    for (const childId of block.childIds) {
      if (!exported.blocks[childId]) {
        warnings.push({
          type: 'missing-child',
          message: `Block "${truncate(block.content)}" references missing child ${childId.slice(0, 8)}…`,
          blockId: id,
        });
      }
    }
  }

  // 2. Orphaned blocks (parentId points to nonexistent block)
  for (const [id, block] of Object.entries(exported.blocks)) {
    if (block.parentId && !exported.blocks[block.parentId]) {
      warnings.push({
        type: 'orphaned-block',
        message: `Block "${truncate(block.content)}" has missing parent ${block.parentId.slice(0, 8)}…`,
        blockId: id,
      });
    }
  }

  // 3. Missing root blocks
  for (const rootId of exported.rootIds) {
    if (!exported.blocks[rootId]) {
      warnings.push({
        type: 'missing-root',
        message: `Root ID ${rootId.slice(0, 8)}… not found in blocks`,
        blockId: rootId,
      });
    }
  }

  // 4. Block count mismatch
  const actualCount = Object.keys(exported.blocks).length;
  if (actualCount !== exported.blockCount) {
    warnings.push({
      type: 'count-mismatch',
      message: `Block count header says ${exported.blockCount} but found ${actualCount}`,
    });
  }

  // 5. Root blocks with non-null parentId
  for (const rootId of exported.rootIds) {
    const block = exported.blocks[rootId];
    if (block && block.parentId !== null) {
      warnings.push({
        type: 'root-has-parent',
        message: `Root block "${truncate(block.content)}" has parentId (should be null)`,
        blockId: rootId,
      });
    }
  }

  return { warnings, canExport: true };
}

/**
 * Group warnings by type for display.
 */
export function groupWarnings(warnings: ValidationWarning[]): Map<WarningType, ValidationWarning[]> {
  const groups = new Map<WarningType, ValidationWarning[]>();
  for (const warning of warnings) {
    const existing = groups.get(warning.type) || [];
    existing.push(warning);
    groups.set(warning.type, existing);
  }
  return groups;
}

/** Warning type labels for display */
export const WARNING_LABELS: Record<WarningType, string> = {
  'orphaned-block': 'Orphaned blocks',
  'missing-child': 'Missing children',
  'missing-root': 'Missing root blocks',
  'count-mismatch': 'Count mismatch',
  'root-has-parent': 'Root with parent',
};

function truncate(content: string, maxLen = 30): string {
  if (!content) return '(empty)';
  if (content.length <= maxLen) return content;
  return content.slice(0, maxLen) + '…';
}
