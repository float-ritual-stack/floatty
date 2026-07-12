import { describe, it, expect, vi } from 'vitest';
import { emitRecentFilesChanged, onRecentFilesChanged } from './fileEvents';

describe('fileEvents', () => {
  it('delivers emitted reason to subscribers', () => {
    const handler = vi.fn();
    const unsubscribe = onRecentFilesChanged(handler);

    emitRecentFilesChanged('watcher');

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('watcher');
    unsubscribe();
  });

  it('defaults to the external reason', () => {
    const handler = vi.fn();
    const unsubscribe = onRecentFilesChanged(handler);

    emitRecentFilesChanged();

    expect(handler).toHaveBeenCalledWith('external');
    unsubscribe();
  });

  it('stops delivering after unsubscribe', () => {
    const handler = vi.fn();
    const unsubscribe = onRecentFilesChanged(handler);

    unsubscribe();
    emitRecentFilesChanged('focus');

    expect(handler).not.toHaveBeenCalled();
  });
});
