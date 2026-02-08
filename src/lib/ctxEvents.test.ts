import { describe, it, expect, vi } from 'vitest';
import { emitCtxMarkersChanged, onCtxMarkersChanged } from './ctxEvents';

describe('ctxEvents', () => {
  it('delivers emitted reason to subscribers', () => {
    const handler = vi.fn();
    const unsubscribe = onCtxMarkersChanged(handler);

    emitCtxMarkersChanged('terminal');

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('terminal');
    unsubscribe();
  });

  it('stops delivering after unsubscribe', () => {
    const handler = vi.fn();
    const unsubscribe = onCtxMarkersChanged(handler);

    unsubscribe();
    emitCtxMarkersChanged('focus');

    expect(handler).not.toHaveBeenCalled();
  });
});
