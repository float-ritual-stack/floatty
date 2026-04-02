/**
 * TV Fuzzy Finder Resolver
 *
 * Resolves $tv(channel) patterns in commands before execution.
 * Spawns tv in a temporary picker block, waits for selection, substitutes result.
 *
 * Pattern: $tv(files) → spawns `tv files` → returns selected path
 *
 * @see FLO-96 for architecture details
 */

import { terminalManager } from './terminalManager';
import type { ExecutorActions } from './handlers';
import { createLogger } from './logger';

const logger = createLogger('tvResolver');

// Pattern to detect $tv(channel) in command strings
const TV_PATTERN = /\$tv\(([^)]+)\)/g;

/**
 * Check if a command contains $tv() patterns
 */
export function hasTvVariables(command: string): boolean {
  return TV_PATTERN.test(command);
}

/**
 * Resolve all $tv() patterns in a command string.
 *
 * For each $tv(channel):
 * 1. Create a picker:: child block with embedded xterm
 * 2. Spawn tv with picker-mode flags in that xterm
 * 3. Wait for tv to exit
 * 4. Capture stdout (selected path)
 * 5. Delete picker block
 * 6. Substitute the selection into the command
 *
 * @param command - The extracted command (after prefix stripped)
 * @param blockId - The parent block ID (sh:: block)
 * @param actions - Block store actions for creating/deleting picker blocks
 * @param paneId - Pane ID for scoping DOM queries in split layouts
 * @returns The command with all $tv() patterns replaced with selections
 */
export async function resolveTvVariables(
  command: string,
  blockId: string,
  actions: ExecutorActions,
  paneId?: string
): Promise<string> {
  // Reset regex state (global regex is stateful)
  TV_PATTERN.lastIndex = 0;
  const matches = [...command.matchAll(TV_PATTERN)];

  if (matches.length === 0) {
    return command;
  }

  let result = command;

  for (const match of matches) {
    const [fullMatch, channel] = match;

    // Create picker block as first child of the sh:: block
    const pickerId = actions.createBlockInsideAtTop?.(blockId) ?? actions.createBlockInside(blockId);
    actions.updateBlockContent(pickerId, `picker::${channel}`);

    try {
      // Spawn tv in the picker block and wait for selection
      const selection = await spawnTvPicker(pickerId, channel, paneId);

      // Substitute the selection (or empty string if cancelled)
      result = result.replace(fullMatch, selection);
    } finally {
      // Always clean up picker block
      actions.deleteBlock?.(pickerId);
    }
  }

  return result;
}

/**
 * Spawn tv in a temporary PTY and wait for selection.
 *
 * TV picker-mode flags:
 * - --no-help-panel: Clean interface for embedded use
 * - Remote control left enabled for channel switching
 *
 * Output capture now happens in Rust for better performance:
 * - No JS string accumulation (zero GC pressure)
 * - ANSI stripping done in Rust (no regex on main thread)
 *
 * @param pickerId - The picker block ID (for xterm container lookup)
 * @param channel - TV channel (files, text, git-log, etc.)
 * @param paneId - Pane ID for scoping DOM queries in split layouts
 * @returns The selected path, or empty string if cancelled
 */
async function spawnTvPicker(pickerId: string, channel: string, paneId?: string): Promise<string> {
  return new Promise((resolve) => {
    // Wait for the picker block to render and get its container
    // Poll with timeout since SolidJS reactivity might not flush immediately
    const findContainer = (attempts = 0): HTMLElement | null => {
      // Scope query to specific pane when in split layout (FLO-99)
      // Without paneId, falls back to first match (legacy behavior)
      // CSS.escape handles any special characters in IDs (defensive)
      const selector = paneId
        ? `.picker-terminal[data-block-id="${CSS.escape(pickerId)}"][data-pane-id="${CSS.escape(paneId)}"]`
        : `.picker-terminal[data-block-id="${CSS.escape(pickerId)}"]`;
      const container = document.querySelector(selector);
      if (container instanceof HTMLElement) return container;
      if (attempts < 10) {
        // Retry after a short delay (SolidJS batch updates)
        return null;
      }
      return null;
    };

    const trySpawn = async (attempts = 0) => {
      const container = findContainer(attempts);
      if (!container) {
        if (attempts < 10) {
          // Retry after 50ms (give SolidJS time to render)
          setTimeout(() => trySpawn(attempts + 1), 50);
          return;
        }
        logger.error(`Picker container not found after retries for ${pickerId}`);
        resolve('');
        return;
      }

      logger.info('Found picker container, spawning tv...');

      // Mark picker as active (CSS uses this for height - prevents black box on undo)
      container.classList.add('picker-terminal--active');

      // Scroll picker into view for better UX
      container.scrollIntoView({ behavior: 'smooth', block: 'center' });

      try {
        // Build tv command for the channel
        const command = buildTvCommand(channel);

        // Use terminalManager's interactive picker spawn
        // Output capture now happens in Rust (captureOutput: true)
        const result = await terminalManager.spawnInteractivePicker(
          pickerId,
          container,
          command
        );

        if (result.exitCode === 0 && result.output) {
          // Selection already extracted and cleaned by Rust
          logger.info(`Selection from Rust: ${result.output}`);
          resolve(result.output);
        } else {
          // User cancelled (Escape) or tv failed
          logger.info(`tv exited with code ${result.exitCode}, output: ${result.output ?? '(none)'}`);
          resolve('');
        }
      } catch (err) {
        logger.error('TV picker failed', { err });
        resolve('');
      }
    };

    // Start the retry loop
    trySpawn(0);
  });
}

// Whitelist regex: only letters, numbers, hyphens, underscores allowed in channel names
const SAFE_CHANNEL_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Build tv command with picker-mode flags
 */
function buildTvCommand(channel: string): string {
  const trimmedChannel = channel.trim();

  // Default channel is 'files' if not specified
  let ch = trimmedChannel || 'files';

  // Validate channel to prevent command injection
  // Only allow alphanumeric, hyphen, underscore
  if (!SAFE_CHANNEL_PATTERN.test(ch)) {
    logger.warn(`Invalid channel name "${ch}", falling back to 'files'`);
    ch = 'files';
  }

  // Built-in channels that benefit from cwd scoping
  const cwdChannels = ['files', 'text', 'gitlog', 'gitbranch', 'gitstatus'];
  const useCwd = cwdChannels.includes(ch.toLowerCase().replace(/-/g, ''));

  // Only pass "." for built-in channels; custom cable channels handle their own paths
  // Don't use --source-output so cable config's [source].output field is respected
  const pathArg = useCwd ? ' .' : '';
  // --preview-size=35: Give 65% to results list (better for narrow picker terminals)
  // --no-help-panel: Clean interface for embedded use
  return `tv ${ch}${pathArg} --preview-size=35 --no-help-panel`;
}
