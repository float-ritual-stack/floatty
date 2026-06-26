import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getAttachment,
  clearAttachmentCache,
  MAX_ENTRIES,
} from './attachmentCache';

// ── URL.createObjectURL / revokeObjectURL: not in jsdom, stub them ──
let urlCounter = 0;
const revoked: string[] = [];
const createdBlobs: Blob[] = [];

function makeBlob(bytes: number): Blob {
  // jsdom Blob reports .size from byte length of parts.
  return new Blob([new Uint8Array(bytes)]);
}

function mockFetchOnce(blob: Blob, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    blob: () => Promise.resolve(blob),
  });
}

beforeEach(() => {
  urlCounter = 0;
  revoked.length = 0;
  createdBlobs.length = 0;
  vi.stubGlobal('URL', {
    createObjectURL: (b: Blob) => {
      createdBlobs.push(b);
      return `blob:mock/${urlCounter++}`;
    },
    revokeObjectURL: (u: string) => {
      revoked.push(u);
    },
  });
});

afterEach(() => {
  clearAttachmentCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('attachmentCache', () => {
  it('fetches once on miss and serves cache on second call (no second fetch)', async () => {
    const fetchMock = mockFetchOnce(makeBlob(10));
    vi.stubGlobal('fetch', fetchMock);

    const url1 = await getAttachment('http://srv', 'a.png', 'key');
    const url2 = await getAttachment('http://srv', 'a.png', 'key');

    expect(url1).toBe(url2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends the Authorization header when an apiKey is given', async () => {
    const fetchMock = mockFetchOnce(makeBlob(10));
    vi.stubGlobal('fetch', fetchMock);

    await getAttachment('http://srv', 'a.png', 'secret');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://srv/api/v1/attachments/a.png',
      { headers: { Authorization: 'Bearer secret' } },
    );
  });

  it('dedups concurrent calls for the same key into one fetch', async () => {
    let resolveBlob: (b: Blob) => void = () => {};
    const blobPromise = new Promise<Blob>((r) => {
      resolveBlob = r;
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      blob: () => blobPromise,
    });
    vi.stubGlobal('fetch', fetchMock);

    const p1 = getAttachment('http://srv', 'a.png', '');
    const p2 = getAttachment('http://srv', 'a.png', '');
    resolveBlob(makeBlob(10));

    const [url1, url2] = await Promise.all([p1, p2]);
    expect(url1).toBe(url2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects on non-ok responses without caching', async () => {
    vi.stubGlobal('fetch', mockFetchOnce(makeBlob(10), false, 404));

    await expect(getAttachment('http://srv', 'missing.png', '')).rejects.toThrow('404');

    // A later successful fetch for the same name should still go to network.
    const okFetch = mockFetchOnce(makeBlob(10));
    vi.stubGlobal('fetch', okFetch);
    await getAttachment('http://srv', 'missing.png', '');
    expect(okFetch).toHaveBeenCalledTimes(1);
  });

  it('treats same filename on different servers as distinct keys', async () => {
    const fetchMock = mockFetchOnce(makeBlob(10));
    vi.stubGlobal('fetch', fetchMock);

    const u1 = await getAttachment('http://srv-a', 'a.png', '');
    const u2 = await getAttachment('http://srv-b', 'a.png', '');

    expect(u1).not.toBe(u2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('evicts the least-recently-used entry past MAX_ENTRIES and revokes its URL', async () => {
    const fetchMock = vi.fn((url: string) => {
      void url;
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        blob: () => Promise.resolve(makeBlob(10)),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    // Fill to capacity.
    const firstUrl = await getAttachment('http://srv', 'f0.png', '');
    for (let i = 1; i < MAX_ENTRIES; i++) {
      await getAttachment('http://srv', `f${i}.png`, '');
    }
    expect(revoked).toHaveLength(0);

    // One more → LRU (f0) evicted, its URL revoked.
    await getAttachment('http://srv', 'overflow.png', '');
    expect(revoked).toContain(firstUrl);

    // f0 is gone → re-fetch hits network again.
    const callsBefore = fetchMock.mock.calls.length;
    await getAttachment('http://srv', 'f0.png', '');
    expect(fetchMock.mock.calls.length).toBe(callsBefore + 1);
  });

  it('a cache hit bumps recency so the bumped entry survives eviction', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        blob: () => Promise.resolve(makeBlob(10)),
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const f0 = await getAttachment('http://srv', 'f0.png', ''); // blob:mock/0
    const f1 = await getAttachment('http://srv', 'f1.png', ''); // blob:mock/1
    for (let i = 2; i < MAX_ENTRIES; i++) {
      await getAttachment('http://srv', `f${i}.png`, '');
    }
    // Touch f0 so it becomes MRU; f1 is now the LRU.
    await getAttachment('http://srv', 'f0.png', '');

    await getAttachment('http://srv', 'overflow.png', '');

    // f0 survived (still cached → no extra fetch); f1 was evicted (URL revoked).
    expect(revoked).toContain(f1);
    expect(revoked).not.toContain(f0);
    const callsBefore = fetchMock.mock.calls.length;
    await getAttachment('http://srv', 'f0.png', '');
    expect(fetchMock.mock.calls.length).toBe(callsBefore); // served from cache
  });

  it('evicts by byte-budget when total bytes exceed MAX_BYTES', async () => {
    // 80 MB fake blobs (only `.size` is read; URL.createObjectURL is stubbed so
    // the blob is never inspected) → two fit, the third forces eviction of #1.
    const big = 80 * 1024 * 1024;
    const fakeBlob = { size: big } as Blob;
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        blob: () => Promise.resolve(fakeBlob),
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const u0 = await getAttachment('http://srv', 'big0.bin', ''); // 80 MB
    await getAttachment('http://srv', 'big1.bin', ''); // 160 MB > 150 → evict u0
    expect(revoked).toContain(u0);

    // big0 evicted → re-fetch hits network.
    const callsBefore = fetchMock.mock.calls.length;
    await getAttachment('http://srv', 'big0.bin', '');
    expect(fetchMock.mock.calls.length).toBe(callsBefore + 1);
  });
});
