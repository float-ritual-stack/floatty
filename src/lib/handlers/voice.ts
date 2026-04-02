/**
 * Voice Handler (voice::)
 *
 * Starts a durable voice session, stores transcript artifacts outside the outline,
 * and projects an operational session subtree back into the outliner.
 *
 * Usage:
 *   voice:: solo Thinking through sync
 *   voice:: quick-note
 *   voice:: 1:1 Staff sync
 *   voice:: group Weekly planning
 *   voice:: dump
 */

import type { BlockHandler, ExecutorActions } from './types';
import type { BatchBlockOp } from '../../hooks/useBlockStore';
import { invoke, type VoiceSession } from '../tauriTypes';
import type { ServerInfo } from '../httpClient';

export interface VoiceSessionOutput extends VoiceSession {
  transcriptUrl: string;
  metadataUrl: string;
}

const VOICE_PREFIX = 'voice::';

const MODE_ALIASES: Record<string, VoiceSession['mode']> = {
  quick: 'quick-note',
  'quick-note': 'quick-note',
  note: 'quick-note',
  solo: 'solo',
  thinking: 'solo',
  'solo-thinking': 'solo',
  '1:1': 'one-on-one',
  '1on1': 'one-on-one',
  'one-on-one': 'one-on-one',
  meeting: 'group',
  group: 'group',
  dump: 'dump',
  passive: 'dump',
};

function parseVoiceCommand(content: string): { mode: string; title?: string } {
  const trimmed = content.trim();
  const prefixEnd = trimmed.toLowerCase().indexOf(VOICE_PREFIX) + VOICE_PREFIX.length;
  const rest = trimmed.slice(prefixEnd).trim();
  if (!rest) {
    return { mode: 'solo' };
  }

  const [first, ...remaining] = rest.split(/\s+/);
  const normalizedMode = MODE_ALIASES[first.toLowerCase()];
  if (normalizedMode) {
    const title = remaining.join(' ').trim();
    return { mode: normalizedMode, title: title || undefined };
  }

  return { mode: 'solo', title: rest };
}

function attachmentUrl(serverInfo: ServerInfo, filename: string): string {
  return `${serverInfo.url}/api/v1/attachments/${encodeURIComponent(filename)}`;
}

function createOutputPayload(session: VoiceSession, serverInfo: ServerInfo): VoiceSessionOutput {
  return {
    ...session,
    transcriptUrl: attachmentUrl(serverInfo, session.transcriptAttachmentName),
    metadataUrl: attachmentUrl(serverInfo, session.metadataAttachmentName),
  };
}

function buildProjectionTemplate(session: VoiceSessionOutput): BatchBlockOp[] {
  const evidenceChildren: BatchBlockOp[] = [
    { content: `link::${session.transcriptUrl}` },
    { content: `link::${session.metadataUrl}` },
    { content: `- transcript file: \`${session.transcriptPath}\`` },
    { content: `- metadata file: \`${session.metadataPath}\`` },
  ];

  const summarySection: BatchBlockOp = {
    content: '## Summary',
    children: [{ content: '- awaiting transcript or manual notes' }],
  };

  const meetingSections: BatchBlockOp[] = [
    {
      content: '## Key Points',
      children: [{ content: '- capture the durable signal here' }],
    },
    {
      content: '## Decisions',
      children: [{ content: '- extract commitments with evidence links' }],
    },
    {
      content: '## Action Items',
      children: [{ content: '- turn promises into operational blocks' }],
    },
    {
      content: '## Follow Ups',
      children: [{ content: '- unresolved follow-through lives here' }],
    },
    {
      content: '## Open Questions',
      children: [{ content: '- keep questions linked to transcript evidence' }],
    },
  ];

  const soloSections: BatchBlockOp[] = [
    {
      content: '## Candidate Ideas',
      children: [{ content: '- preserve promising fragments without over-normalizing them' }],
    },
    {
      content: '## Thought Threads',
      children: [{ content: '- cluster the lines of thought worth revisiting' }],
    },
    {
      content: '## Decisions',
      children: [{ content: '- separate real decisions from exploratory talk' }],
    },
    {
      content: '## Action Items',
      children: [{ content: '- capture tasks that emerged from self-talk' }],
    },
    {
      content: '## Open Questions',
      children: [{ content: '- keep live uncertainties visible in the runtime' }],
    },
  ];

  const modeSpecificSections =
    session.mode === 'group' || session.mode === 'one-on-one'
      ? meetingSections
      : soloSections;

  return [
    { content: `# ${session.title}` },
    {
      content:
        `- [voice::session] [session::${session.id}] [mode::${session.mode}] ` +
        `[status::${session.status}] [transcript::${session.transcriptAttachmentName}] ` +
        `[metadata::${session.metadataAttachmentName}]`,
    },
    summarySection,
    {
      content: '## Evidence',
      children: evidenceChildren,
    },
    ...modeSpecificSections,
  ];
}

function insertFallback(parentId: string, ops: BatchBlockOp[], actions: ExecutorActions): void {
  for (const op of ops) {
    const nextId = actions.createBlockInside(parentId);
    actions.updateBlockContent(nextId, op.content);
    if (op.children?.length) {
      insertFallback(nextId, op.children, actions);
    }
  }
}

export const voiceHandler: BlockHandler = {
  prefixes: ['voice::'],

  async execute(blockId: string, content: string, actions: ExecutorActions): Promise<void> {
    const { mode, title } = parseVoiceCommand(content);

    // Create a dedicated child output block for each started session.
    // Re-running voice:: is intentional session creation, not refresh.
    const outputId = actions.createBlockInsideAtTop?.(blockId) ?? actions.createBlockInside(blockId);

    actions.updateBlockContent(outputId, '');
    if (actions.setBlockStatus) {
      actions.setBlockStatus(outputId, 'running');
    }

    try {
      const [session, serverInfo] = await Promise.all([
        invoke<VoiceSession>('create_voice_session', {
          mode,
          title,
          sourceBlockId: blockId,
        }),
        invoke<ServerInfo>('get_server_info', {}),
      ]);

      const output = createOutputPayload(session, serverInfo);
      const template = buildProjectionTemplate(output);

      if (actions.batchCreateBlocksInside) {
        actions.batchCreateBlocksInside(outputId, template);
      } else {
        insertFallback(outputId, template, actions);
      }

      if (actions.setBlockOutput) {
        actions.setBlockOutput(outputId, output, 'voice-session');
      }
      if (actions.setBlockStatus) {
        actions.setBlockStatus(outputId, 'complete');
      }
      actions.focusBlock?.(outputId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      actions.updateBlockContent(outputId, `error::${message}`);
      if (actions.setBlockStatus) {
        actions.setBlockStatus(outputId, 'error');
      }
    }
  },
};
