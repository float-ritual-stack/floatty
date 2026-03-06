/**
 * Artifact Handler (artifact::)
 *
 * Reads a JSX file from disk, transforms it via Sucrase,
 * and renders it in an inline iframe via the existing UrlViewer pipeline.
 *
 * Usage: `artifact:: ~/float-hub/inbox/some-component.jsx`
 */

import { readTextFile } from '@tauri-apps/plugin-fs';
import { homeDir } from '@tauri-apps/api/path';
import type { BlockHandler, ExecutorActions } from './types';
import { transformArtifact } from './artifactTransform';

async function resolveTilde(filePath: string): Promise<string> {
  if (filePath.startsWith('~/')) {
    const home = await homeDir();
    return filePath.replace('~', home.replace(/\/$/, ''));
  }
  return filePath;
}

// Track blob URLs per block for cleanup on re-execute
const activeBlobUrls = new Map<string, string>();

export const artifactHandler: BlockHandler = {
  prefixes: ['artifact::'],

  async execute(blockId: string, content: string, actions: ExecutorActions): Promise<void> {
    const filePath = content.trim().replace(/^artifact::\s*/i, '').trim();

    if (!filePath) {
      actions.setBlockOutput?.(blockId, { type: 'error', data: 'No file path provided' }, 'eval-result');
      actions.setBlockStatus?.(blockId, 'error');
      return;
    }

    // Revoke previous blob URL to prevent memory leak
    const prevUrl = activeBlobUrls.get(blockId);
    if (prevUrl) URL.revokeObjectURL(prevUrl);

    actions.setBlockStatus?.(blockId, 'running');

    try {
      const resolvedPath = await resolveTilde(filePath);
      const source = await readTextFile(resolvedPath);

      const result = transformArtifact(source);
      if (result.error) {
        activeBlobUrls.delete(blockId);
        actions.setBlockOutput?.(blockId, { type: 'error', data: `Transform error: ${result.error}` }, 'eval-result');
        actions.setBlockStatus?.(blockId, 'error');
        return;
      }

      activeBlobUrls.set(blockId, result.blobUrl);
      // Use 'url' type — EvalOutput routes this to UrlViewer (inline iframe)
      actions.setBlockOutput?.(blockId, { type: 'url', data: result.blobUrl }, 'eval-result');
      actions.setBlockStatus?.(blockId, 'complete');
    } catch (err) {
      activeBlobUrls.delete(blockId);
      const msg = err instanceof Error ? err.message : String(err);
      actions.setBlockOutput?.(blockId, { type: 'error', data: `File read error: ${msg}` }, 'eval-result');
      actions.setBlockStatus?.(blockId, 'error');
    }
  },
};
