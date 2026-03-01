/**
 * Door Adapter — Bridges Door interface to BlockHandler
 *
 * doorToBlockHandler() wraps a Door into a BlockHandler that
 * the existing HandlerRegistry can register and dispatch.
 * Output is always stored on a child block with outputType 'door'.
 */

import type { BlockHandler, ExecutorActions } from './types';
import type {
  Door,
  DoorMeta,
  DoorResult,
  DoorViewOutput,
  DoorExecOutput,
} from './doorTypes';
import { createDoorContext } from './doorSandbox';
import { findOutputChild } from './utils';

/**
 * Create a BlockHandler from a Door + DoorMeta.
 * The adapter handles:
 * - Output child creation/reuse
 * - DoorContext construction per execution
 * - DoorEnvelope wrapping (view or exec)
 * - JSON serialization enforcement
 * - Error handling for both door kinds
 */
export function doorToBlockHandler(
  door: Door,
  meta: DoorMeta,
  settings: Record<string, unknown> = {}
): BlockHandler {
  return {
    prefixes: door.prefixes,

    async execute(blockId: string, content: string, actions: ExecutorActions): Promise<void> {
      // Find or create output child block
      let outputId = findOutputChild(blockId, actions, 'door');
      if (!outputId) {
        outputId = actions.createBlockInside(blockId);
      }

      const startedAt = Date.now();
      actions.setBlockStatus?.(outputId, 'running');
      actions.updateBlockContent(outputId, '');

      // Build fresh context per execution
      const ctx = createDoorContext({
        blockId,
        content,
        meta,
        actions,
        settings,
      });

      try {
        if (door.kind === 'view') {
          const result = await door.execute(blockId, content, ctx) as DoorResult;
          const data = result?.data ?? null;
          const error = result?.error;

          // Enforce JSON-serializable output
          try {
            structuredClone(data);
          } catch {
            throw new Error(
              `[door:${meta.id}] execute() returned non-serializable data. ` +
              'DoorResult.data must be JSON-safe (no functions, symbols, DOM nodes).'
            );
          }

          const envelope: DoorViewOutput = {
            kind: 'view',
            doorId: meta.id,
            schema: 1,
            data: data as DoorViewOutput['data'],
            error,
          };

          actions.setBlockOutput?.(outputId, envelope, 'door');
          actions.setBlockStatus?.(outputId, error ? 'error' : 'complete');

        } else {
          // Block door — execute for side effects (block creation, etc.)
          await door.execute(blockId, content, ctx);

          const envelope: DoorExecOutput = {
            kind: 'exec',
            schema: 1,
            doorId: meta.id,
            startedAt,
            finishedAt: Date.now(),
            ok: true,
            createdBlockIds: ctx._createdBlockIds?.() ?? [],
          };

          actions.setBlockOutput?.(outputId, envelope, 'door');
          actions.setBlockStatus?.(outputId, 'complete');
        }
      } catch (err) {
        console.error(`[door:${meta.id}] Execution error:`, err);

        const envelope: DoorViewOutput | DoorExecOutput = door.kind === 'view'
          ? {
              kind: 'view' as const,
              doorId: meta.id,
              schema: 1 as const,
              data: null,
              error: String(err),
            }
          : {
              kind: 'exec' as const,
              schema: 1 as const,
              doorId: meta.id,
              startedAt,
              finishedAt: Date.now(),
              ok: false,
              error: String(err),
            };

        actions.setBlockOutput?.(outputId, envelope, 'door');
        actions.setBlockStatus?.(outputId, 'error');
      }
    },
  };
}
