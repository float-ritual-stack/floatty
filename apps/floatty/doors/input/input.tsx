/**
 * input:: — minimal two-way-binding proof
 *
 * Usage:
 *   input:: [[blockId]]       bind to block with given id / short-hash
 *
 * Renders a native <input> whose value is the target block's content.
 * On every keystroke, PATCH /api/v1/blocks/:id with the new content.
 *
 * No json-render. No catalog. No spec. Just solid-js + one input.
 * Measurement-first: every user event logs to console.
 */

import { createSignal, Show, onCleanup, onMount } from 'solid-js';

const LOG = '[input]';

// ─── View ─────────────────────────────────────────────────────────

interface InputViewData {
  targetId?: string;
  content?: string;
  error?: string;
}

interface ServerAccess {
  url: string;
  fetch(path: string, init?: RequestInit): Promise<Response>;
  subscribeBlockChanges?(
    handler: () => void,
    options?: { fields?: string[] },
  ): () => void;
}

function InputView(props: { data: InputViewData; server: ServerAccess }) {
  const initial = () => props.data?.content ?? '';
  const targetId = () => props.data?.targetId;
  const error = () => props.data?.error;

  // Local signal for displayed value. Seeds from `data.content` at mount,
  // updates on every user keystroke.
  const [value, setValue] = createSignal(initial());
  const [status, setStatus] = createSignal<'idle' | 'writing' | 'error' | 'synced'>('idle');
  const [statusMsg, setStatusMsg] = createSignal('');

  // If the server capability for subscription is present, refresh-from-remote
  // when the target block changes from somewhere else (the outline itself).
  onMount(() => {
    if (!props.server.subscribeBlockChanges) {
      console.log(LOG, 'no subscribeBlockChanges on server — outline→input sync unavailable');
      return;
    }
    const unsub = props.server.subscribeBlockChanges(
      async () => {
        const id = targetId();
        if (!id) return;
        try {
          const resp = await props.server.fetch(`/api/v1/blocks/${id}`);
          if (!resp.ok) return;
          const block = await resp.json();
          const remote = block?.content ?? '';
          // Only overwrite local value if it was synced (not mid-typing)
          if (remote !== value() && status() === 'synced') {
            console.log(LOG, 'outline→input refresh', { id, remote: remote.slice(0, 40) });
            setValue(remote);
          }
        } catch (err) {
          console.log(LOG, 'refresh failed', err);
        }
      },
      { fields: ['content'] },
    );
    onCleanup(unsub);
  });

  const onInput = async (e: InputEvent) => {
    const next = (e.target as HTMLInputElement).value;
    setValue(next);
    const id = targetId();
    if (!id) return;
    setStatus('writing');
    setStatusMsg('writing…');
    console.log(LOG, 'onInput', { id, length: next.length });
    try {
      const resp = await props.server.fetch(`/api/v1/blocks/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ content: next }),
      });
      if (!resp.ok) {
        const body = await resp.text();
        setStatus('error');
        setStatusMsg(`PATCH ${resp.status}: ${body.slice(0, 80)}`);
        console.log(LOG, 'PATCH failed', { status: resp.status, body });
        return;
      }
      setStatus('synced');
      setStatusMsg(`synced · ${new Date().toLocaleTimeString()}`);
      console.log(LOG, 'PATCH ok', { id });
    } catch (err) {
      setStatus('error');
      setStatusMsg(`error: ${String(err).slice(0, 80)}`);
      console.log(LOG, 'PATCH threw', err);
    }
  };

  const statusColor = () => {
    switch (status()) {
      case 'writing': return '#ffb300';
      case 'synced':  return '#98c379';
      case 'error':   return '#ff4444';
      default:        return '#888';
    }
  };

  return (
    <div style={{
      padding: '8px',
      'font-family': 'JetBrains Mono, monospace',
      'font-size': '13px',
      background: '#0d0d0d',
      border: '1px solid #222',
      'border-radius': '6px',
      display: 'flex',
      'flex-direction': 'column',
      gap: '6px',
    }}>
      <Show when={error()} fallback={
        <>
          <div style={{
            'font-size': '10px',
            color: '#888',
            'text-transform': 'uppercase',
            'letter-spacing': '0.08em',
          }}>
            input → {targetId()?.slice(0, 8) ?? '?'}
          </div>
          <input
            type="text"
            value={value()}
            onInput={onInput}
            style={{
              background: '#161616',
              color: '#e0e0e0',
              border: '1px solid #333',
              'border-radius': '4px',
              padding: '8px 10px',
              'font-family': 'inherit',
              'font-size': 'inherit',
              outline: 'none',
            }}
            onFocus={(e) => { (e.target as HTMLInputElement).style.borderColor = '#00e5ff'; }}
            onBlur={(e) => { (e.target as HTMLInputElement).style.borderColor = '#333'; }}
          />
          <div style={{ 'font-size': '10px', color: statusColor(), 'font-family': 'inherit' }}>
            {statusMsg() || 'idle'}
          </div>
        </>
      }>
        <div style={{ color: '#ff4444' }}>error: {error()}</div>
      </Show>
    </div>
  );
}

// ─── Door export ──────────────────────────────────────────────────

function resolveTargetId(arg: string, ctx: any): { id?: string; error?: string } {
  const trimmed = arg.trim();
  if (!trimmed) {
    return { error: 'usage: input:: [[blockId]] (or bare id)' };
  }
  // Strip optional [[ ]]
  const inner = trimmed.replace(/^\[\[|\]\]$/g, '').trim();
  // Full UUID
  if (/^[0-9a-f-]{36}$/i.test(inner)) {
    const block = ctx.actions.getBlock?.(inner);
    return block ? { id: inner } : { error: `block not found: ${inner}` };
  }
  // Short prefix — scan for a match
  if (/^[0-9a-f]{6,}$/i.test(inner) && ctx.actions.rootIds) {
    const seen = new Set<string>();
    const queue = [...ctx.actions.rootIds()];
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      if (id.startsWith(inner)) return { id };
      queue.push(...(ctx.actions.getChildren?.(id) ?? []));
    }
    return { error: `no block id starts with: ${inner}` };
  }
  return { error: `cannot parse target: ${trimmed}` };
}

export const door = {
  kind: 'view' as const,
  prefixes: ['input::'],

  async execute(blockId: string, content: string, ctx: any) {
    ctx.actions.setBlockStatus?.(blockId, 'running');
    const arg = content.replace(/^input::\s*/i, '').trim();
    console.log(LOG, 'execute', { blockId: blockId.slice(0, 8), arg });

    const resolved = resolveTargetId(arg, ctx);
    if (resolved.error || !resolved.id) {
      ctx.actions.setBlockOutput?.(
        blockId,
        { kind: 'view', doorId: 'input', schema: 1, data: { error: resolved.error } },
        'door',
      );
      ctx.actions.setBlockStatus?.(blockId, 'error');
      return;
    }

    const target = ctx.actions.getBlock?.(resolved.id) as { id: string; content: string } | undefined;
    const data: InputViewData = {
      targetId: resolved.id,
      content: target?.content ?? '',
    };

    ctx.actions.setBlockOutput?.(
      blockId,
      { kind: 'view', doorId: 'input', schema: 1, data },
      'door',
    );
    ctx.actions.setBlockStatus?.(blockId, 'complete');
  },

  view: InputView,
};

export const meta = {
  id: 'input',
  name: 'Input',
  version: '0.1.0',
  selfRender: true,
};
