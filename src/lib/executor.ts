import { invoke } from '@tauri-apps/api/core';

export function isExecutableShellBlock(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.startsWith('sh::') || trimmed.startsWith('term::');
}

export function isExecutableAiBlock(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.startsWith('ai::') || trimmed.startsWith('chat::');
}

export function extractShellCommand(content: string): string | null {
  const trimmed = content.trim();
  if (trimmed.startsWith('sh::')) return trimmed.slice(4).trim();
  if (trimmed.startsWith('term::')) return trimmed.slice(6).trim();
  return null;
}

export function extractAiPrompt(content: string): string | null {
  const trimmed = content.trim();
  if (trimmed.startsWith('ai::')) return trimmed.slice(4).trim();
  if (trimmed.startsWith('chat::')) return trimmed.slice(6).trim();
  return null;
}

interface ExecutorActions {
  createBlockInside: (parentId: string) => string;
  createBlockInsideAtTop?: (parentId: string) => string;
  updateBlockContent: (id: string, content: string) => void;
}

export async function executeShellBlock(
  blockId: string, 
  command: string, 
  actions: ExecutorActions
) {
  const { createBlockInside, createBlockInsideAtTop, updateBlockContent } = actions;
  
  // Create output block immediately - prefer at top if available
  const outputId = createBlockInsideAtTop ? createBlockInsideAtTop(blockId) : createBlockInside(blockId);
  updateBlockContent(outputId, 'output::Running...');

  try {
    const result = await invoke<string>('execute_shell_command', { command });
    // Strip trailing newline
    const cleanResult = result.trimEnd();
    updateBlockContent(outputId, `output::${cleanResult}`);
  } catch (err) {
    updateBlockContent(outputId, `error::${String(err)}`);
  }
}

export async function executeAiBlock(
  blockId: string, 
  prompt: string, 
  actions: ExecutorActions
) {
  const { createBlockInside, createBlockInsideAtTop, updateBlockContent } = actions;
  
  // Create output block immediately
  const outputId = createBlockInsideAtTop ? createBlockInsideAtTop(blockId) : createBlockInside(blockId);
  updateBlockContent(outputId, 'ai::Thinking...');

  try {
    const result = await invoke<string>('execute_ai_command', { prompt });
    updateBlockContent(outputId, `ai::${result}`);
  } catch (err) {
    updateBlockContent(outputId, `error::${String(err)}`);
  }
}
