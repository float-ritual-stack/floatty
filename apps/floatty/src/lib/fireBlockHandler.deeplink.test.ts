import { beforeAll, describe, expect, it } from 'vitest';

import { registerHandlers } from './handlers';
import { isExternalDeepLinkSafe } from './fireBlockHandler';

/**
 * FLO-919 — the deep-link execution boundary is default-deny. These assert the
 * allowlist decision (`isExternalDeepLinkSafe`), the exact predicate the
 * `floatty://execute` / `upsert&execute` gate in App.tsx calls before firing.
 */
describe('isExternalDeepLinkSafe (deep-link default-deny gate)', () => {
  beforeAll(() => {
    registerHandlers();
  });

  it('REJECTS the RCE-class handlers', () => {
    // shell
    expect(isExternalDeepLinkSafe('sh:: touch /tmp/floatty-deeplink-test')).toBe(false);
    expect(isExternalDeepLinkSafe('term:: rm -rf ~')).toBe(false);
    // arbitrary JS + outline mutation
    expect(isExternalDeepLinkSafe('eval:: $delete("abc")')).toBe(false);
    // disk read + code exec
    expect(isExternalDeepLinkSafe('artifact:: ~/x.jsx')).toBe(false);
  });

  it('ALLOWS the pure/read-only built-ins', () => {
    expect(isExternalDeepLinkSafe('search:: foo')).toBe(true);
    expect(isExternalDeepLinkSafe('pick:: $tv(x)')).toBe(true);
    expect(isExternalDeepLinkSafe('info::')).toBe(true);
    expect(isExternalDeepLinkSafe('echoCopy:: [[abc]]')).toBe(true);
  });

  it('REJECTS plain text and unknown prefixes (no handler = not safe)', () => {
    expect(isExternalDeepLinkSafe('just a note')).toBe(false);
    expect(isExternalDeepLinkSafe('unknownprefix:: x')).toBe(false);
    expect(isExternalDeepLinkSafe('')).toBe(false);
  });

  it('is case-insensitive on the prefix (matches registry.findHandler)', () => {
    expect(isExternalDeepLinkSafe('SH:: whoami')).toBe(false);
    expect(isExternalDeepLinkSafe('SEARCH:: foo')).toBe(true);
  });
});
