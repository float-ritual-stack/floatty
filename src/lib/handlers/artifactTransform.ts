/**
 * Artifact Transform — Pure functions for JSX → iframe HTML pipeline
 *
 * Flow: source JSX → Sucrase transform → import map → HTML document → blob URL
 *
 * The transformed code keeps its ESM imports (resolved by the import map).
 * Sucrase only transforms JSX → React.createElement. The code becomes the
 * entire <script type="module"> content, with mount logic appended.
 */

import { transform } from 'sucrase';

// Default versions for common Claude.ai artifact dependencies
const DEFAULT_VERSIONS: Record<string, string> = {
  'react': '18',
  'react-dom': '18',
  'react-dom/client': '18',
  'd3': '7',
  'tone': '15',
  'three': '0.170',
};

/**
 * Transform JSX source to plain JS using Sucrase.
 * Strips `export default` — we mount the component ourselves.
 * Keeps ESM imports intact for the browser import map.
 */
export function transformJsx(source: string): string {
  // Capture the default export name so we can assign __ArtifactDefault__ after transform.
  // In ES modules, top-level declarations are module-scoped (NOT on globalThis),
  // so we must explicitly assign the component to a known variable.
  let defaultExportName: string | null = null;

  let cleaned = source
    // Named: export default function Foo() { ... }
    .replace(/export\s+default\s+function\s+(\w+)/g, (_match, name) => {
      defaultExportName = name;
      return `function ${name}`;
    })
    // Anonymous: export default function() { ... } → const __ArtifactDefault__ = function() { ... }
    .replace(/export\s+default\s+function\s*\(/g, 'const __ArtifactDefault__ = function(')
    // Expression: export default Foo / export default () => ...
    .replace(/export\s+default\s+(?!function)/g, 'const __ArtifactDefault__ = ');

  // If we found `export default function Foo`, append the assignment
  if (defaultExportName) {
    cleaned += `\nconst __ArtifactDefault__ = ${defaultExportName};\n`;
  }

  const result = transform(cleaned, {
    transforms: ['jsx', 'typescript'],
    jsxRuntime: 'classic',
    jsxPragma: 'React.createElement',
    jsxFragmentPragma: 'React.Fragment',
    filePath: 'artifact.tsx',
  });

  return result.code;
}

/**
 * Scan source for bare import specifiers and build an import map.
 * Maps each package to its esm.sh CDN URL.
 */
export function buildImportMap(source: string): Record<string, string> {
  const importMap: Record<string, string> = {};

  // Match: import ... from 'package' or import 'package'
  const importRegex = /(?:import\s+(?:[\s\S]*?\s+from\s+)?['"])([^./][^'"]*)['"]/g;
  let match;

  while ((match = importRegex.exec(source)) !== null) {
    const specifier = match[1];
    // Get the base package name (handle scoped packages and subpaths)
    const basePkg = specifier.startsWith('@')
      ? specifier.split('/').slice(0, 2).join('/')
      : specifier.split('/')[0];

    const version = DEFAULT_VERSIONS[specifier] ?? DEFAULT_VERSIONS[basePkg] ?? 'latest';
    // For subpath imports (e.g. react-dom/client), esm.sh wants pkg@ver/sub not pkg/sub@ver
    const subpath = specifier.startsWith('@')
      ? specifier.slice(basePkg.length)  // e.g. @scope/pkg/sub → /sub
      : specifier.slice(basePkg.length); // e.g. react-dom/client → /client
    importMap[specifier] = subpath
      ? `https://esm.sh/${basePkg}@${version}${subpath}`
      : `https://esm.sh/${specifier}@${version}`;
  }

  // Always include react + react-dom (JSX output needs React.createElement)
  if (!importMap['react']) {
    importMap['react'] = `https://esm.sh/react@${DEFAULT_VERSIONS['react']}`;
  }
  if (!importMap['react-dom']) {
    importMap['react-dom'] = `https://esm.sh/react-dom@${DEFAULT_VERSIONS['react-dom']}`;
  }
  // react-dom/client for createRoot
  if (!importMap['react-dom/client']) {
    importMap['react-dom/client'] = `https://esm.sh/react-dom@${DEFAULT_VERSIONS['react-dom']}/client`;
  }

  return importMap;
}

/**
 * Ensure React and ReactDOM imports exist in the transformed code.
 * If the artifact doesn't import them, prepend the imports.
 */
function ensureReactImports(jsCode: string): string {
  const lines: string[] = [];

  if (!/import\s+.*\bReact\b.*from\s+['"]react['"]/.test(jsCode)) {
    lines.push("import React from 'react';");
  }
  // Always ensure ReactDOM default import exists for mount script.
  // Named imports like `import { createRoot } from 'react-dom/client'` don't provide
  // the `ReactDOM` binding that the mount script needs.
  if (!/import\s+ReactDOM\s+from\s+['"]react-dom/.test(jsCode)) {
    lines.push("import ReactDOM from 'react-dom/client';");
  }

  return lines.length > 0 ? lines.join('\n') + '\n' + jsCode : jsCode;
}

/**
 * Detect CSS frameworks used in the source based on class name patterns.
 * Returns an array of framework identifiers to inject into the HTML.
 */
export function detectCssFrameworks(source: string): string[] {
  const frameworks: string[] = [];

  // Tailwind CSS: detect by presence of utility class patterns
  const tailwindIndicators = [
    // Layout/display utilities (flex, grid, hidden, container)
    /\b(?:flex|inline-flex|grid|inline-grid|block|inline-block|hidden|container)\b/,
    // Alignment utilities (items-center, justify-between, etc.)
    /\b(?:items|justify|content|place-items|place-content)-(?:start|end|center|between|around|evenly|stretch)\b/,
    // Sizing utilities (w-full, h-screen, min-h-screen)
    /\b(?:w|h|min-w|min-h|max-h)-(?:full|screen|\d+)\b/,
    // Color utilities with Tailwind palette names (bg-zinc-950, text-slate-100)
    /(?:bg|text|border|ring|shadow)-(?:zinc|slate|gray|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}/,
    // Spacing utilities (p-4, mx-auto, gap-2)
    /\b(?:p|m|px|py|mx|my|pt|pb|pl|pr|mt|mb|ml|mr|gap)-(?:\d+|auto)\b/,
    // Rounded variants (rounded-xl, rounded-full)
    /\brounded-(?:sm|md|lg|xl|2xl|3xl|full|none)\b/,
    // Max-width with Tailwind names (max-w-3xl)
    /\bmax-w-(?:sm|md|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|screen|prose|none|xs)\b/,
    // Font utilities (font-mono, font-bold)
    /\bfont-(?:mono|sans|serif|bold|semibold|medium|light|thin|extrabold|black)\b/,
    // Responsive prefixes in class strings (sm:, md:, lg:)
    /\b(?:sm|md|lg|xl|2xl):/,
  ];

  let hits = 0;
  for (const pattern of tailwindIndicators) {
    if (pattern.test(source)) hits++;
  }

  // 2+ distinct pattern categories = almost certainly Tailwind
  if (hits >= 2) {
    frameworks.push('tailwind');
  }

  return frameworks;
}

/**
 * Build CSS framework injection tags for the HTML head.
 */
function buildCssHeadTags(frameworks: string[]): string {
  const tags: string[] = [];
  if (frameworks.includes('tailwind')) {
    tags.push('<script src="https://cdn.tailwindcss.com"></script>');
  }
  return tags.join('\n  ');
}

/**
 * Build the chirp bridge — lets artifacts write blocks to the parent outline.
 *
 * Usage inside artifact: `window.chirp('hello from iframe')`
 * or: `window.chirp('data point', { x: 42, y: 99 })`
 */
function buildChirpBridge(): string {
  return `
// === Chirp bridge ===
// Outbound: artifact → outline (creates child blocks)
window.chirp = function(message, data) {
  window.parent.postMessage({ type: 'chirp', message: String(message), data: data }, '*');
};
// Inbound: outline → artifact (parent pokes iframe)
window.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'poke' && typeof window.onPoke === 'function') {
    window.onPoke(e.data.message, e.data.data);
  }
});`;
}

/**
 * Build the mount script that finds and renders the component.
 * Includes global error handler so import/runtime failures show in the iframe.
 */
function buildMountScript(): string {
  return `
// === Global error handler — catches import failures (e.g. CDN 404) ===
window.onerror = function(msg, src, line, col, err) {
  const el = document.getElementById('root');
  if (el) el.innerHTML = '<div class="artifact-error">Runtime error: ' + msg + (src ? '\\n' + src + ':' + line : '') + '</div>';
};
window.addEventListener('unhandledrejection', function(e) {
  const el = document.getElementById('root');
  if (el) el.innerHTML = '<div class="artifact-error">Import failed: ' + (e.reason?.message || e.reason || 'unknown') + '</div>';
});

// === Artifact mount ===
{
  const _findComponent = () => {
    if (typeof __ArtifactDefault__ !== 'undefined') return __ArtifactDefault__;
    return null;
  };
  const _Component = _findComponent();
  if (_Component) {
    const _root = (typeof ReactDOM !== 'undefined' && ReactDOM.createRoot)
      ? ReactDOM.createRoot(document.getElementById('root'))
      : null;
    if (_root) {
      try { _root.render(React.createElement(_Component)); }
      catch (e) { document.getElementById('root').innerHTML = '<div class="artifact-error">Render error: ' + e.message + '</div>'; }
    }
    else document.getElementById('root').innerHTML = '<div class="artifact-error">ReactDOM.createRoot not available</div>';
  } else {
    document.getElementById('root').innerHTML = '<div class="artifact-error">No component found to render</div>';
  }
}`;
}

/**
 * Build a complete HTML document that renders the artifact component.
 */
export function buildArtifactHtml(jsCode: string, importMap: Record<string, string>, options?: { cssFrameworks?: string[] }): string {
  const importMapJson = JSON.stringify({ imports: importMap }, null, 2);
  // Escape </script> in code to prevent premature tag close in the HTML document
  const safeCode = ensureReactImports(jsCode).replace(/<\/script>/gi, '<\\/script>');
  const moduleCode = safeCode + '\n' + buildChirpBridge() + '\n' + buildMountScript();
  const cssHeadTags = buildCssHeadTags(options?.cssFrameworks ?? []);

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${cssHeadTags ? cssHeadTags + '\n  ' : ''}<style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #1a1a2e; color: #e0e0e0; }
    #root { width: 100vw; min-height: 100vh; }
    .artifact-error { color: #ff6b6b; padding: 1rem; font-family: monospace; white-space: pre-wrap; }
  </style>
  <script type="importmap">${importMapJson}</script>
</head>
<body>
  <div id="root"></div>
  <script type="module">
${moduleCode}
  </script>
</body>
</html>`;
}

/**
 * Create a blob URL from HTML content. Caller is responsible for revoking.
 */
export function createArtifactBlobUrl(html: string): string {
  const blob = new Blob([html], { type: 'text/html' });
  return URL.createObjectURL(blob);
}

/**
 * Detect content type from source content for routing to appropriate renderer.
 * Returns 'jsx' for valid JavaScript/JSX, or the detected non-JSX type.
 */
export type ContentType = 'jsx' | 'html' | 'json' | 'text';

export function detectContentType(source: string, filePath?: string): ContentType {
  // File extension takes priority for HTML
  if (filePath && /\.html?$/i.test(filePath)) return 'html';

  const trimmed = source.trimStart();

  // HTML documents
  if (/^<!doctype\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed)) return 'html';

  // JSON (starts with { or [, validate with parse)
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { JSON.parse(trimmed); return 'json'; } catch { /* not valid JSON, might be JSX */ }
  }

  // JSX indicators: import/export at top level (strong signal)
  if (/^(?:import\s|export\s)/m.test(trimmed)) return 'jsx';

  // Weaker signals: const/function/class — only JSX if file also has React-like patterns
  if (/^(?:const\s|let\s|var\s|function\s|class\s)/m.test(trimmed)) {
    if (/(?:React|jsx|createElement|useState|useEffect|onClick|className|<\w+[\s/>])/.test(trimmed)) return 'jsx';
  }

  // JSX-like tags with React patterns anywhere in file
  if (/<\w+[\s>]/.test(trimmed) && /(?:onClick|className|useState|useEffect|React)/.test(trimmed)) return 'jsx';

  // Everything else is text/markdown
  return 'text';
}

/**
 * Build an HTML document that renders raw HTML content directly (no React).
 */
export function buildRawHtmlDocument(source: string): string {
  // If it's already a complete HTML document, use as-is
  if (/^<!doctype\s+html/i.test(source.trimStart()) || /^<html[\s>]/i.test(source.trimStart())) {
    return source;
  }
  // Fragment — wrap in minimal document
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  body { font-family: system-ui, sans-serif; background: #1a1a2e; color: #e0e0e0; margin: 1rem; }
</style></head><body>${source}</body></html>`;
}

/**
 * Build an HTML document that renders JSON with syntax highlighting.
 */
export function buildJsonViewerHtml(source: string): string {
  // Escape for embedding in HTML
  const escaped = source.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'JetBrains Mono', 'SF Mono', monospace; background: #1a1a2e; color: #e0e0e0; padding: 1rem; }
  pre { white-space: pre-wrap; word-wrap: break-word; line-height: 1.5; font-size: 13px; }
  .string { color: #a8db8f; } .number { color: #e0a0ff; } .boolean { color: #ff9e64; }
  .null { color: #737aa2; } .key { color: #7dcfff; }
</style></head><body><pre id="json"></pre>
<script>
  const raw = ${JSON.stringify(source)};
  try {
    const obj = JSON.parse(raw);
    const formatted = JSON.stringify(obj, null, 2);
    document.getElementById('json').innerHTML = formatted
      .replace(/"([^"]+)"\\s*:/g, '"<span class="key">$1</span>":')
      .replace(/: "([^"]*)"/g, ': "<span class="string">$1</span>"')
      .replace(/: (\\d+\\.?\\d*)/g, ': <span class="number">$1</span>')
      .replace(/: (true|false)/g, ': <span class="boolean">$1</span>')
      .replace(/: (null)/g, ': <span class="null">$1</span>');
  } catch { document.getElementById('json').textContent = raw; }
</script></body></html>`;
}

/**
 * Build an HTML document that renders text/markdown content.
 */
export function buildTextViewerHtml(source: string, filePath?: string): string {
  const escaped = source.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const fileName = filePath ? filePath.split('/').pop() ?? '' : '';
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'JetBrains Mono', 'SF Mono', monospace; background: #1a1a2e; color: #e0e0e0; padding: 1rem; }
  .filename { color: #737aa2; font-size: 11px; margin-bottom: 0.5rem; }
  pre { white-space: pre-wrap; word-wrap: break-word; line-height: 1.5; font-size: 13px; }
</style></head><body>
${fileName ? `<div class="filename">${fileName}</div>` : ''}
<pre>${escaped}</pre>
</body></html>`;
}

/**
 * Full pipeline: source → blob URL ready for iframe src.
 * Routes based on content type: JSX goes through Sucrase, everything else gets a viewer.
 */
export function transformArtifact(source: string, filePath?: string): { blobUrl: string; error?: undefined } | { blobUrl?: undefined; error: string } {
  try {
    const contentType = detectContentType(source, filePath);

    let html: string;
    switch (contentType) {
      case 'html':
        html = buildRawHtmlDocument(source);
        break;
      case 'json':
        html = buildJsonViewerHtml(source);
        break;
      case 'text':
        html = buildTextViewerHtml(source, filePath);
        break;
      case 'jsx':
      default: {
        const importMap = buildImportMap(source);
        const cssFrameworks = detectCssFrameworks(source);
        const jsCode = transformJsx(source);
        html = buildArtifactHtml(jsCode, importMap, { cssFrameworks });
        break;
      }
    }

    const blobUrl = createArtifactBlobUrl(html);
    return { blobUrl };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
