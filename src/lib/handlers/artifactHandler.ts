/**
 * Artifact Handler (artifact::)
 *
 * Reads a JSX file from disk, transforms it via Sucrase,
 * and renders it in an inline iframe via the existing UrlViewer pipeline.
 *
 * Usage: `artifact:: ~/float-hub/inbox/some-component.jsx`
 */

import { readTextFile } from '@tauri-apps/plugin-fs';
import type { BlockHandler, ExecutorActions } from './types';
import { transformArtifact } from './artifactTransform';

/**
 * Resolve ~ to the user's home directory.
 * Tauri's fs plugin handles $HOME but not ~.
 */
function resolveTilde(filePath: string): string {
  if (filePath.startsWith('~/')) {
    // Use $HOME env or fallback — Tauri resolves $HOME in paths
    return filePath.replace('~', '$HOME');
  }
  return filePath;
}

export const artifactHandler: BlockHandler = {
  prefixes: ['artifact::'],

  async execute(blockId: string, content: string, actions: ExecutorActions): Promise<void> {
    const filePath = content.trim().replace(/^artifact::\s*/i, '').trim();

    if (!filePath) {
      actions.setBlockOutput?.(blockId, { type: 'error', data: 'No file path provided' }, 'eval-result');
      actions.setBlockStatus?.(blockId, 'error');
      return;
    }

    actions.setBlockStatus?.(blockId, 'running');

    try {
      const resolvedPath = resolveTilde(filePath);
      const source = await readTextFile(resolvedPath);

      const result = transformArtifact(source);
      if (result.error) {
        actions.setBlockOutput?.(blockId, { type: 'error', data: `Transform error: ${result.error}` }, 'eval-result');
        actions.setBlockStatus?.(blockId, 'error');
        return;
      }

      // Use 'url' type — EvalOutput routes this to UrlViewer (inline iframe)
      actions.setBlockOutput?.(blockId, { type: 'url', data: result.blobUrl }, 'eval-result');
      actions.setBlockStatus?.(blockId, 'complete');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      actions.setBlockOutput?.(blockId, { type: 'error', data: `File read error: ${msg}` }, 'eval-result');
      actions.setBlockStatus?.(blockId, 'error');
    }
  },
};
