import { Show, createSignal } from 'solid-js';
import { invoke, type VoiceSession } from '../../lib/tauriTypes';
import type { VoiceSessionOutput } from '../../lib/handlers/voice';

interface VoiceSessionViewProps {
  data: VoiceSessionOutput;
  setSessionOutput: (output: VoiceSessionOutput) => void;
  setSessionStatus: (status: 'idle' | 'running' | 'complete' | 'error') => void;
  syncProjectionMarker: (session: VoiceSessionOutput) => void;
}

function statLabel(value: number, singular: string, plural: string): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

export function VoiceSessionView(props: VoiceSessionViewProps) {
  const [draft, setDraft] = createSignal('');
  const [speaker, setSpeaker] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  const [isSaving, setIsSaving] = createSignal(false);
  const [isChangingStatus, setIsChangingStatus] = createSignal(false);

  const isActive = () => props.data.status === 'active';
  const isMutating = () => isSaving() || isChangingStatus();

  const applySessionUpdate = (session: VoiceSession) => {
    const nextOutput: VoiceSessionOutput = {
      ...session,
      transcriptUrl: props.data.transcriptUrl,
      metadataUrl: props.data.metadataUrl,
    };

    props.setSessionOutput(nextOutput);
    props.syncProjectionMarker(nextOutput);
  };

  const openUrl = async (url: string) => {
    try {
      await invoke('open_url', { url });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const appendTranscript = async () => {
    const text = draft().trim();
    if (!text || isMutating() || !isActive()) return;

    setError(null);
    setIsSaving(true);
    props.setSessionStatus('running');

    try {
      const next = await invoke<VoiceSession>('append_voice_transcript', {
        sessionId: props.data.id,
        text,
        speaker: speaker().trim() || null,
        kind: 'transcript',
      });

      applySessionUpdate(next);
      setDraft('');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      props.setSessionStatus('error');
      return;
    } finally {
      setIsSaving(false);
    }
  };

  const updateStatus = async (status: VoiceSessionOutput['status']) => {
    if (isMutating() || props.data.status === status) return;

    setError(null);
    setIsChangingStatus(true);
    props.setSessionStatus('running');

    try {
      const next = await invoke<VoiceSession>('update_voice_session_status', {
        sessionId: props.data.id,
        status,
      });
      applySessionUpdate(next);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      props.setSessionStatus('error');
      return;
    } finally {
      setIsChangingStatus(false);
    }
  };

  return (
    <div
      class="voice-session-view"
      style={{
        padding: '10px 12px',
        border: '1px solid var(--color-border, #3f3f46)',
        'border-radius': '8px',
        background: 'linear-gradient(180deg, rgba(18, 18, 24, 0.98), rgba(26, 28, 38, 0.98))',
        display: 'grid',
        gap: '10px',
      }}
    >
      <div style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'flex-start', gap: '12px' }}>
        <div style={{ display: 'grid', gap: '4px' }}>
          <div style={{ 'font-size': '13px', 'font-weight': 700, color: 'var(--color-text, #f4f4f5)' }}>
            {props.data.title}
          </div>
          <div style={{ display: 'flex', gap: '6px', 'flex-wrap': 'wrap' }}>
            <span style={{ padding: '2px 7px', 'border-radius': '999px', background: 'rgba(99, 102, 241, 0.18)', color: '#c7d2fe', 'font-size': '11px', 'text-transform': 'uppercase', 'letter-spacing': '0.04em' }}>
              {props.data.mode}
            </span>
            <span style={{ padding: '2px 7px', 'border-radius': '999px', background: 'rgba(16, 185, 129, 0.15)', color: '#bbf7d0', 'font-size': '11px', 'text-transform': 'uppercase', 'letter-spacing': '0.04em' }}>
              {props.data.status}
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px', 'flex-wrap': 'wrap', 'justify-content': 'flex-end' }}>
          <button
            type="button"
            onClick={() => void openUrl(props.data.transcriptUrl)}
            style={{
              padding: '6px 10px',
              'border-radius': '6px',
              border: '1px solid rgba(125, 211, 252, 0.25)',
              background: 'rgba(8, 47, 73, 0.35)',
              color: '#bae6fd',
              cursor: 'pointer',
            }}
          >
            Open transcript
          </button>
          <button
            type="button"
            onClick={() => void openUrl(props.data.metadataUrl)}
            style={{
              padding: '6px 10px',
              'border-radius': '6px',
              border: '1px solid rgba(244, 114, 182, 0.25)',
              background: 'rgba(80, 7, 36, 0.35)',
              color: '#fbcfe8',
              cursor: 'pointer',
            }}
          >
            Open metadata
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '12px', 'flex-wrap': 'wrap', color: 'var(--color-muted, #a1a1aa)', 'font-size': '12px' }}>
        <span>{statLabel(props.data.transcriptChunks, 'chunk', 'chunks')}</span>
        <span>{statLabel(props.data.transcriptLines, 'line', 'lines')}</span>
        <span>{statLabel(props.data.transcriptWords, 'word', 'words')}</span>
      </div>

      <div style={{ display: 'flex', gap: '8px', 'flex-wrap': 'wrap', 'align-items': 'center' }}>
        <Show when={props.data.status === 'active'}>
          <button
            type="button"
            onClick={() => void updateStatus('paused')}
            disabled={isMutating()}
            style={{
              padding: '6px 10px',
              'border-radius': '6px',
              border: '1px solid rgba(250, 204, 21, 0.25)',
              background: 'rgba(113, 63, 18, 0.4)',
              color: '#fde68a',
              cursor: isMutating() ? 'wait' : 'pointer',
              opacity: isMutating() ? 0.7 : 1,
            }}
          >
            Pause
          </button>
        </Show>
        <Show when={props.data.status === 'paused'}>
          <button
            type="button"
            onClick={() => void updateStatus('active')}
            disabled={isMutating()}
            style={{
              padding: '6px 10px',
              'border-radius': '6px',
              border: '1px solid rgba(74, 222, 128, 0.25)',
              background: 'rgba(20, 83, 45, 0.55)',
              color: '#dcfce7',
              cursor: isMutating() ? 'wait' : 'pointer',
              opacity: isMutating() ? 0.7 : 1,
            }}
          >
            Resume
          </button>
        </Show>
        <Show when={props.data.status !== 'complete'}>
          <button
            type="button"
            onClick={() => void updateStatus('complete')}
            disabled={isMutating()}
            style={{
              padding: '6px 10px',
              'border-radius': '6px',
              border: '1px solid rgba(244, 114, 182, 0.25)',
              background: 'rgba(80, 7, 36, 0.35)',
              color: '#fbcfe8',
              cursor: isMutating() ? 'wait' : 'pointer',
              opacity: isMutating() ? 0.7 : 1,
            }}
          >
            Complete
          </button>
        </Show>
        <Show when={props.data.status === 'paused'}>
          <span style={{ color: 'var(--color-muted, #a1a1aa)', 'font-size': '12px' }}>
            Session is paused. Resume to append more transcript.
          </span>
        </Show>
        <Show when={props.data.status === 'complete'}>
          <span style={{ color: 'var(--color-muted, #a1a1aa)', 'font-size': '12px' }}>
            Session is complete. Transcript appends are locked.
          </span>
        </Show>
      </div>

      <div style={{ display: 'grid', gap: '8px' }}>
        <label style={{ display: 'grid', gap: '6px' }}>
          <span style={{ 'font-size': '12px', color: 'var(--color-muted, #a1a1aa)' }}>Speaker (optional)</span>
          <input
            value={speaker()}
            onInput={(event) => setSpeaker(event.currentTarget.value)}
            placeholder="me"
            disabled={!isActive() || isMutating()}
            style={{
              padding: '7px 9px',
              'border-radius': '6px',
              border: '1px solid rgba(255,255,255,0.12)',
              background: 'rgba(0,0,0,0.22)',
              color: 'var(--color-text, #f4f4f5)',
            }}
          />
        </label>
        <label style={{ display: 'grid', gap: '6px' }}>
          <span style={{ 'font-size': '12px', color: 'var(--color-muted, #a1a1aa)' }}>Append transcript chunk</span>
          <textarea
            value={draft()}
            onInput={(event) => setDraft(event.currentTarget.value)}
            rows={5}
            placeholder="Paste or type a transcript chunk here. This appends to the durable transcript file, not the outline."
            disabled={!isActive() || isMutating()}
            style={{
              padding: '9px 10px',
              'border-radius': '6px',
              border: '1px solid rgba(255,255,255,0.12)',
              background: 'rgba(0,0,0,0.22)',
              color: 'var(--color-text, #f4f4f5)',
              resize: 'vertical',
              'font-family': 'inherit',
            }}
          />
        </label>
      </div>

      <div style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center', gap: '12px', 'flex-wrap': 'wrap' }}>
        <Show when={error()}>
          <div style={{ color: '#fca5a5', 'font-size': '12px' }}>{error()}</div>
        </Show>
        <button
          type="button"
          onClick={() => void appendTranscript()}
          disabled={isMutating() || !draft().trim() || !isActive()}
          style={{
            padding: '7px 12px',
            'border-radius': '6px',
            border: '1px solid rgba(74, 222, 128, 0.25)',
            background: isSaving() ? 'rgba(34, 197, 94, 0.12)' : 'rgba(20, 83, 45, 0.55)',
            color: '#dcfce7',
            cursor: isMutating() ? 'wait' : 'pointer',
            opacity: isMutating() || !draft().trim() || !isActive() ? 0.7 : 1,
          }}
        >
          {isSaving() ? 'Appending…' : 'Append to transcript'}
        </button>
      </div>
    </div>
  );
}
