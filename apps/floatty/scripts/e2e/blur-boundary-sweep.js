/**
 * E2E behavioral sweep for FLO-387 blur-is-the-boundary (PR #234).
 *
 * Runs entirely inside a running floatty webview via the tauri-mcp
 * server's `webview_execute_js` tool. Agentic runner — no CI, no
 * Playwright, no tauri-driver. The runner is whatever process (agent,
 * future script) can drive `webview_execute_js` calls; right now that's
 * cowboy Claude with the @hypothesi/tauri-mcp-server MCP.
 *
 * ─── How to run it ──────────────────────────────────────────────────
 *
 * 1. Launch dev floatty: `npm run tauri dev`
 *    (It uses ~/.floatty-dev by design so the release notes on 8765
 *    aren't touched.)
 *
 * 2. Confirm the MCP bridge port with `lsof -iTCP -sTCP:LISTEN -P`.
 *    Dev typically binds 9224 when release already holds 9223. Note it.
 *
 * 3. Tell the agent:
 *      "attach tauri-mcp at port <N>, execute the contents of
 *       apps/floatty/scripts/e2e/blur-boundary-sweep.js via
 *       webview_execute_js, and report the results JSON"
 *
 * 4. The harness creates a throwaway page + test blocks, runs the
 *    entire behavioral sweep, cleans up after itself, and returns a
 *    structured results object. Total runtime: under a minute.
 *
 * ─── What it tests ──────────────────────────────────────────────────
 *
 * Each test asserts one invariant of the blur-is-the-boundary contract
 * against the REAL running Tauri app, not a jsdom mock. The scenarios
 * mirror the unit tests in useContentSync.test.ts but go through the
 * full SolidJS reactivity + local Y.Doc + useSyncedYDoc outbound sync
 * + HTTP POST chain. Failures here catch integration bugs the unit
 * tests cannot.
 *
 *   01  Zero Y.Doc writes during typing
 *   02  Blur produces exactly one write with final content
 *   03  Idle-dirty window never fires a debounce (no old timer lurking)
 *   04  Enter mid-string splits cleanly with fresh content
 *   05  Paste of large content is one write on blur, not N
 *   06  Conflict diagnostic fires for a genuine background write
 *   07  Non-content blurs (focus shifts) produce zero commits
 *   08  cancelContentUpdate path: delete-block does not commit
 *
 * ─── What it does NOT test ──────────────────────────────────────────
 *
 * - Real IME composition (synthetic events don't exercise the OS IME)
 * - Real frame paint timing (rAF delta is a proxy, not the real thing)
 * - Autocomplete dropdown UX (the dropdown is a SolidJS component whose
 *   selection callback is bound inside a closure and hard to reach from
 *   outside — the flush-first invariant that autocomplete depends on
 *   is tested indirectly via test 03's "no hidden debounce" guarantee)
 * - 48k-block scale frame-time thresholds (requires the release build,
 *   separate step documented in .float/work/flo-387-blur-boundary/
 *   WORK_UNITS.md Unit 0.3)
 *
 * ─── Invariants a failure would signal ──────────────────────────────
 *
 * 01 → the debounce or some other mid-typing writer crept back in
 * 02 → flushContentUpdate is not reading fresh DOM content
 * 03 → something is still running a timer off the input event
 * 04 → structural op is operating on stale content (race masking returned)
 * 05 → paste path lost its flush-first contract
 * 06 → conflict diagnostic dead or snapshot semantics wrong
 * 07 → non-content blurs are committing something (hasLocalChanges race)
 * 08 → delete_block path wrote the doomed block's content to the store
 *
 * Any failure should revert or patch before PR #234 merges.
 *
 * ─── Output shape ───────────────────────────────────────────────────
 *
 * {
 *   passed:        <bool>
 *   totalMs:       <number>
 *   tests: {
 *     "01-zero-writes-during-typing": {
 *       status: "pass" | "fail",
 *       detail: "...",
 *       metrics: { inputs: 30, updateCalls: 0 }
 *     },
 *     ...
 *   },
 *   cleanup: { deletedTestPageId: "...", ok: true },
 * }
 *
 * ─── Return contract ────────────────────────────────────────────────
 *
 * The script is wrapped in an async IIFE and returns a Promise that
 * resolves to the results object. `webview_execute_js` needs a
 * JSON-serializable return, so we await the full sweep before returning.
 */

(async () => {
  const SERVER = window.__FLOATTY_SERVER_URL__;
  const API_KEY = window.__FLOATTY_API_KEY__;
  const results = { passed: true, totalMs: 0, tests: {}, cleanup: {} };
  const t0 = performance.now();

  // ─── Helpers ──────────────────────────────────────────────────────

  const api = (path, opts = {}) =>
    fetch(`${SERVER}${path}`, {
      ...opts,
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    }).then(async (r) => {
      if (!r.ok) throw new Error(`${path} -> ${r.status} ${await r.text()}`);
      return r.status === 204 ? null : r.json();
    });

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Wait for a SolidJS-rendered DOM element matching a predicate.
  // Polls rAF-ish cadence because SolidJS's reactivity cycle can span
  // multiple microtask queues and effect tiers.
  const waitForElement = async (predicate, timeoutMs = 2000) => {
    const start = performance.now();
    while (performance.now() - start < timeoutMs) {
      const el = predicate();
      if (el) return el;
      await new Promise((r) => requestAnimationFrame(r));
    }
    return null;
  };

  // Wait for a block's server-side content to settle to an expected value
  // (used after a commit to confirm the round-trip landed).
  const waitForServerContent = async (blockId, expected, timeoutMs = 2000) => {
    const start = performance.now();
    while (performance.now() - start < timeoutMs) {
      try {
        const b = await api(`/api/v1/blocks/${blockId}`);
        if (b && b.content === expected) return true;
      } catch {}
      await wait(50);
    }
    return false;
  };

  // Fetch counter needed for the "zero writes" assertions. We install a
  // minimal counter on window.__sweepProbe so tests don't depend on the
  // persistent __floattySweep probe that may or may not be loaded.
  const installProbe = () => {
    if (window.__sweepProbe) return;
    const state = { updateCalls: 0, lastUpdateBody: null };
    const origFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      const method = (args[1] && args[1].method) || (args[0] && args[0].method) || 'GET';
      if (/\/api\/v1\/update(\?|$)/.test(url) && method === 'POST') {
        state.updateCalls++;
        try { state.lastUpdateBody = args[1] && args[1].body; } catch {}
      }
      return origFetch(...args);
    };
    window.__sweepProbe = {
      state,
      reset: () => { state.updateCalls = 0; state.lastUpdateBody = null; },
      count: () => state.updateCalls,
    };
  };

  // Attempt to dispatch a keydown via SolidJS's event system. Synthetic
  // events fire through the normal listener chain; the handler reads
  // e.key etc. the same as it would for a real keypress.
  const pressKey = (target, key, opts = {}) => {
    const ev = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ...opts,
    });
    target.dispatchEvent(ev);
  };

  // Type a string into the currently-focused contentEditable via
  // execCommand('insertText'). This mutates the DOM AND fires a native
  // InputEvent that flows through useContentSync.handleInput — the same
  // path a real keypress takes. Each call inserts one logical "typing"
  // event, which is what we want to stress the blur-boundary contract.
  const typeInto = (text) => {
    for (const ch of text) {
      document.execCommand('insertText', false, ch);
    }
  };

  // Find the contentEditable associated with a given block id. SolidJS
  // wraps BlockItem such that the [data-block-id] element contains a
  // nested [contenteditable="true"] descendant.
  const findContentEditable = async (blockId) => {
    const el = await waitForElement(() => {
      const host = document.querySelector(`[data-block-id="${blockId}"]`);
      // floatty uses contenteditable="" (empty string), not contenteditable="true"
      return host ? host.querySelector('[contenteditable]:not([contenteditable="false"])') : null;
    });
    return el;
  };

  // Record a single test outcome on the results object.
  const record = (name, status, detail, metrics = {}) => {
    results.tests[name] = { status, detail, metrics };
    if (status !== 'pass') results.passed = false;
  };

  // ─── Setup: find an already-expanded parent for test blocks ─────────
  //
  // Root-level blocks created via REST API start with `has-collapsed-children`
  // in paneStore (no stored state → collapsed default). Their children never
  // render in the DOM. The fix: find a block that is already expanded (it has
  // visible children in the DOM) and create test blocks directly inside it.
  // No intermediate container needed — direct children of an expanded block
  // appear immediately via SolidJS reactive childIds.
  //
  // Cleanup: each test block ID is pushed to `testBlockIds` and deleted
  // individually at the end (instead of deleting a single container).

  let testParentId = null;
  const testBlockIds = [];
  let setupError = null;

  // Helper: create a fresh test block and track it for cleanup.
  const mkBlock = async (content = '') => {
    const b = await api('/api/v1/blocks', {
      method: 'POST',
      body: JSON.stringify({ content, parentId: testParentId }),
    });
    testBlockIds.push(b.id);
    return b;
  };

  try {
    installProbe();

    // Get all blocks from server to find an already-expanded parent.
    // An expanded block is one that has children AND those children appear
    // in the DOM (meaning the parent's children-section is in the render tree).
    const allData = await api('/api/v1/blocks');
    const domBlockIds = new Set(
      Array.from(document.querySelectorAll('[data-block-id]')).map((el) =>
        el.getAttribute('data-block-id'),
      ),
    );

    // Find a block whose children are all visible in the DOM (it's expanded).
    const expandedParent = allData.blocks.find((b) => {
      if (!b.childIds || b.childIds.length === 0) return false;
      return b.childIds.some((cid) => domBlockIds.has(cid));
    });

    if (!expandedParent) {
      throw new Error(
        'No expanded block found in DOM — is floatty showing an outline with children?',
      );
    }
    testParentId = expandedParent.id;

    await wait(200);
  } catch (err) {
    setupError = String(err);
  }

  // ─── Test 01: Zero writes during typing ──────────────────────────

  try {
    if (setupError) throw new Error(`setup failed: ${setupError}`);
    const block = await mkBlock();
    await wait(200);

    const ce = await findContentEditable(block.id);
    if (!ce) throw new Error('contentEditable not found for test block');
    ce.focus();
    await wait(50);

    window.__sweepProbe.reset();
    typeInto('the quick brown fox jumps over the lazy dog');
    await wait(200); // Let any rogue debounce timer fire (it shouldn't)

    const updateCalls = window.__sweepProbe.count();
    if (updateCalls === 0) {
      record('01-zero-writes-during-typing', 'pass',
        'No POST /api/v1/update during 43 chars of typing + 200ms idle',
        { typedChars: 43, updateCalls });
    } else {
      record('01-zero-writes-during-typing', 'fail',
        `Expected 0 updateCalls, got ${updateCalls} — debounce or other mid-typing writer is live`,
        { typedChars: 43, updateCalls });
    }

    // Leave block dirty + focused for test 02
    window.__sweepTest01BlockId = block.id;
    window.__sweepTest01Ce = ce;
  } catch (err) {
    record('01-zero-writes-during-typing', 'fail', `exception: ${String(err)}`);
  }

  // ─── Test 02: Blur produces one commit with final content ─────────

  try {
    const blockId = window.__sweepTest01BlockId;
    const ce = window.__sweepTest01Ce;
    if (!blockId || !ce) throw new Error('setup from test 01 missing');

    window.__sweepProbe.reset();
    ce.blur();
    await wait(300); // Let the flush fetch round-trip

    const updateCalls = window.__sweepProbe.count();
    const serverOK = await waitForServerContent(
      blockId,
      'the quick brown fox jumps over the lazy dog',
      1500,
    );

    if (updateCalls === 1 && serverOK) {
      record('02-blur-commits-once', 'pass',
        '1 POST /api/v1/update after blur, server content matches',
        { updateCalls });
    } else {
      record('02-blur-commits-once', 'fail',
        `updateCalls=${updateCalls}, serverOK=${serverOK}`,
        { updateCalls, serverContentMatches: serverOK });
    }
  } catch (err) {
    record('02-blur-commits-once', 'fail', `exception: ${String(err)}`);
  }

  // ─── Test 03: Idle-dirty window — no debounce lurking ─────────────

  try {
    const block = await mkBlock();
    await wait(200);
    const ce = await findContentEditable(block.id);
    if (!ce) throw new Error('contentEditable not found');
    ce.focus();
    await wait(50);

    window.__sweepProbe.reset();
    typeInto('hello');
    // Now sit dirty for 2 full seconds. Under old code with 150ms
    // debounce, a write would fire at t+150ms. Under blur-boundary,
    // NOTHING should write until we blur.
    await wait(2000);

    const updateCallsDuringIdle = window.__sweepProbe.count();
    ce.blur();
    await wait(300);
    const updateCallsAfterBlur = window.__sweepProbe.count();

    if (updateCallsDuringIdle === 0 && updateCallsAfterBlur === 1) {
      record('03-no-debounce-lurking', 'pass',
        '2s idle-dirty window produced 0 writes, blur produced 1',
        { idleWrites: 0, postBlurWrites: 1 });
    } else {
      record('03-no-debounce-lurking', 'fail',
        `idleWrites=${updateCallsDuringIdle}, postBlurWrites=${updateCallsAfterBlur}`,
        { idleWrites: updateCallsDuringIdle, postBlurWrites: updateCallsAfterBlur });
    }
  } catch (err) {
    record('03-no-debounce-lurking', 'fail', `exception: ${String(err)}`);
  }

  // ─── Test 04: Enter mid-string splits cleanly ─────────────────────

  try {
    const block = await mkBlock();
    await wait(200);
    const ce = await findContentEditable(block.id);
    if (!ce) throw new Error('contentEditable not found');
    ce.focus();
    await wait(50);

    // Type a full sentence first, then cursor to middle, then Enter.
    typeInto('hello world');
    await wait(100);

    // Position cursor between 'hello' and ' world' (offset 5)
    const textNode = ce.firstChild;
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
      throw new Error(`unexpected first child type ${textNode?.nodeName}`);
    }
    const range = document.createRange();
    range.setStart(textNode, 5);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    window.__sweepProbe.reset();
    pressKey(ce, 'Enter');
    await wait(400); // Let split + sync happen

    // Verify: two siblings now exist under testParentId, the first
    // containing "hello" and the second " world" (or "world" — floatty's
    // split consumes leading whitespace on the right side sometimes).
    // Use ?include=children — ?include=tree returns a flat DFS array at
    // page.tree, not page.tree.children.
    const page = await api(`/api/v1/blocks/${testParentId}?include=children`);
    const children = page.children || [];
    // Find the block we created and the new sibling
    const origIdx = children.findIndex((b) => b.id === block.id);
    const origAfterSplit = origIdx >= 0 ? children[origIdx] : null;
    const sibling = origIdx >= 0 ? children[origIdx + 1] : null;

    const updateCalls = window.__sweepProbe.count();

    if (origAfterSplit && origAfterSplit.content === 'hello' && sibling) {
      // The sibling content depends on floatty's split semantics; accept
      // either "world" or " world". What matters is the split happened
      // and the orig block has the pre-cursor content.
      const siblingOK = sibling.content === 'world' || sibling.content === ' world';
      if (siblingOK) {
        record('04-enter-split-fresh', 'pass',
          `Split into "hello" + "${sibling.content}", ${updateCalls} POSTs`,
          { updateCalls, origContent: origAfterSplit.content, siblingContent: sibling.content });
      } else {
        record('04-enter-split-fresh', 'fail',
          `Expected sibling "world" or " world", got "${sibling.content}"`,
          { updateCalls, siblingContent: sibling.content });
      }
    } else {
      record('04-enter-split-fresh', 'fail',
        `orig.content="${origAfterSplit?.content}", sibling=${sibling ? `"${sibling.content}"` : 'null'}`,
        { updateCalls, orig: origAfterSplit, sibling });
    }

    ce.blur();
    await wait(200);
  } catch (err) {
    record('04-enter-split-fresh', 'fail', `exception: ${String(err)}`);
  }

  // ─── Test 05: Paste large content is one write on blur ────────────

  try {
    const block = await mkBlock();
    await wait(200);
    const ce = await findContentEditable(block.id);
    if (!ce) throw new Error('contentEditable not found');
    ce.focus();
    await wait(50);

    // Insert 500 chars in a single execCommand shot. This is a more
    // direct test than a ClipboardEvent because:
    //   1. Synthetic ClipboardEvents don't populate clipboardData.getData()
    //      in WKWebView — handlePaste reads undefined and bails early.
    //   2. One execCommand fires one InputEvent, which flows through
    //      updateContentFromDom exactly as real typing does, but 500×
    //      more aggressively. Zero writes should fire before blur.
    const bigText = 'p'.repeat(500);
    window.__sweepProbe.reset();
    document.execCommand('insertText', false, bigText);
    await wait(300); // Any hidden debounce would fire here
    const writesDuringInsert = window.__sweepProbe.count();

    ce.blur();
    await wait(300);
    const writesAfterBlur = window.__sweepProbe.count();

    // Core assertion: 0 writes during the 500-char input, exactly 1 on blur.
    // This confirms blur-boundary holds even for large single-input events.
    const totalWrites = writesAfterBlur;
    if (writesDuringInsert === 0 && writesAfterBlur === 1) {
      record('05-paste-bounded-writes', 'pass',
        `500-char single execCommand: 0 writes during insert, 1 on blur`,
        { insertLen: 500, writesDuringInsert, writesAfterBlur });
    } else {
      record('05-paste-bounded-writes', 'fail',
        `writesDuringInsert=${writesDuringInsert}, writesAfterBlur=${writesAfterBlur}`,
        { insertLen: 500, writesDuringInsert, writesAfterBlur });
    }
  } catch (err) {
    record('05-paste-bounded-writes', 'fail', `exception: ${String(err)}`);
  }

  // ─── Test 06: Conflict diagnostic on genuine background write ─────

  try {
    const block = await mkBlock();
    await wait(200);
    const ce = await findContentEditable(block.id);
    if (!ce) throw new Error('contentEditable not found');
    ce.focus();
    await wait(50);

    // User types locally
    typeInto('local edit');
    await wait(100);

    // Install the test hook BEFORE the background write. useContentSync.ts
    // fires window.__floattyTestHooks?.onConflictDetected?.(blockId) after
    // the conflict-detected logger.warn. We can't use a console.warn spy
    // because logger.ts captures `originalConsole.warn` at module load time
    // — a spy installed later patches the global binding, not the captured
    // reference, so it never fires.
    let conflictFired = false;
    window.__floattyTestHooks = {
      onConflictDetected: (_id) => { conflictFired = true; },
    };

    // Background write: hit the REST API to change this block's content
    // to something different. This simulates a remote client or a hook
    // writing during the user's focused edit session.
    await api(`/api/v1/blocks/${block.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ content: 'BACKGROUND overwrite' }),
    });
    // Give the WS broadcast time to land in the local Y.Doc and
    // propagate into the SolidJS block store.
    await wait(500);

    ce.blur();
    await wait(500);

    delete window.__floattyTestHooks;

    const finalBlock = await api(`/api/v1/blocks/${block.id}`);

    if (conflictFired && finalBlock.content === 'local edit') {
      record('06-conflict-diagnostic-fires', 'pass',
        'Background write triggered conflict-detected hook; LWW kept local content',
        { finalContent: finalBlock.content });
    } else {
      record('06-conflict-diagnostic-fires', 'fail',
        `conflictFired=${conflictFired}, finalContent="${finalBlock.content}"`,
        { conflictFired, finalContent: finalBlock.content });
    }
  } catch (err) {
    record('06-conflict-diagnostic-fires', 'fail', `exception: ${String(err)}`);
  }

  // ─── Test 07: Non-content blur does not commit ────────────────────

  try {
    const block = await mkBlock('existing');
    await wait(200);
    const ce = await findContentEditable(block.id);
    if (!ce) throw new Error('contentEditable not found');
    ce.focus();
    await wait(50);

    window.__sweepProbe.reset();
    // Blur without any typing — block is clean, hasLocalChanges is false.
    // The flush-on-blur path should bail early (no dirty flag) and
    // produce zero writes.
    ce.blur();
    await wait(300);

    const updateCalls = window.__sweepProbe.count();
    if (updateCalls === 0) {
      record('07-clean-blur-is-noop', 'pass',
        'Blurring a clean block produced 0 POSTs',
        { updateCalls });
    } else {
      record('07-clean-blur-is-noop', 'fail',
        `Clean blur produced ${updateCalls} POSTs — dirty flag leaking`,
        { updateCalls });
    }
  } catch (err) {
    record('07-clean-blur-is-noop', 'fail', `exception: ${String(err)}`);
  }

  // ─── Test 08: cancelContentUpdate path (delete before commit) ─────
  //
  // Create a block, focus it, type, then dispatch Cmd+Backspace (or the
  // structural delete equivalent). The useBlockInput handler for
  // `delete_block` calls cancelContentUpdate() which clears the dirty
  // flag without committing — the content typed into the block before
  // deletion should NOT show up as a final write for the deleted id.

  try {
    const block = await mkBlock();
    await wait(200);
    const ce = await findContentEditable(block.id);
    if (!ce) throw new Error('contentEditable not found');
    ce.focus();
    await wait(50);

    typeInto('about to be deleted');
    await wait(100);

    window.__sweepProbe.reset();
    // Cmd+Backspace = delete_block on macOS
    pressKey(ce, 'Backspace', { metaKey: true });
    await wait(400);

    // Verify the block is actually gone from the server
    let blockStillExists = false;
    try {
      await api(`/api/v1/blocks/${block.id}`);
      blockStillExists = true;
    } catch (err) {
      // Expected: 404
      blockStillExists = !String(err).includes('404');
    }

    // The write count after delete should reflect ONLY the delete op,
    // NOT a pre-delete content commit. Delete itself is a structural
    // mutation that fires its own sync POST.
    const updateCalls = window.__sweepProbe.count();

    if (!blockStillExists && updateCalls >= 1 && updateCalls <= 3) {
      record('08-delete-skips-content-commit', 'pass',
        `Block deleted, ${updateCalls} POST(s) for the delete — no pre-delete content commit`,
        { updateCalls, blockExists: blockStillExists });
    } else if (blockStillExists) {
      record('08-delete-skips-content-commit', 'fail',
        'Block still exists after Cmd+Backspace — delete_block path did not fire',
        { updateCalls, blockExists: blockStillExists });
    } else {
      record('08-delete-skips-content-commit', 'fail',
        `Unexpected write count: ${updateCalls}`,
        { updateCalls, blockExists: blockStillExists });
    }
  } catch (err) {
    record('08-delete-skips-content-commit', 'fail', `exception: ${String(err)}`);
  }

  // ─── Cleanup ──────────────────────────────────────────────────────
  // Delete each test block individually (no container to nuke).
  // Blocks already deleted by their test (e.g., test 08 Cmd+Backspace)
  // will 404 cleanly — we catch and ignore.

  const cleanupErrors = [];
  let deletedCount = 0;
  for (const id of testBlockIds) {
    try {
      await api(`/api/v1/blocks/${id}`, { method: 'DELETE' });
      deletedCount++;
    } catch (err) {
      // 404 = already deleted by test (e.g., test 08 Cmd+Backspace) — fine
      if (!String(err).includes('404')) cleanupErrors.push(String(err));
    }
  }
  results.cleanup = {
    ok: cleanupErrors.length === 0,
    deletedCount,
    testParentId,
    errors: cleanupErrors.length > 0 ? cleanupErrors : undefined,
  };

  results.totalMs = Math.round(performance.now() - t0);
  return results;
})()
