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
    .replace(/export\s+default\s+function\s+(\w+)/g, (_match, name) => {
      defaultExportName = name;
      return `function ${name}`;
    })
    .replace(/export\s+default\s+(?!function)/g, 'const __ArtifactDefault__ = ');

  // If we found `export default function Foo`, append the assignment
  if (defaultExportName) {
    cleaned += `\nconst __ArtifactDefault__ = ${defaultExportName};\n`;
  }

  const result = transform(cleaned, {
    transforms: ['jsx'],
    jsxRuntime: 'classic',
    jsxPragma: 'React.createElement',
    jsxFragmentPragma: 'React.Fragment',
    filePath: 'artifact.jsx',
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
    importMap[specifier] = `https://esm.sh/${specifier}@${version}`;
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
  if (!/import\s+.*from\s+['"]react-dom\/client['"]/.test(jsCode)
    && !/import\s+.*from\s+['"]react-dom['"]/.test(jsCode)) {
    lines.push("import ReactDOM from 'react-dom/client';");
  }

  return lines.length > 0 ? lines.join('\n') + '\n' + jsCode : jsCode;
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
  window.parent.postMessage({ type: 'chirp', message: String(message), data: data }, 'tauri://localhost');
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
 */
function buildMountScript(): string {
  return `
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
    if (_root) _root.render(React.createElement(_Component));
    else document.getElementById('root').innerHTML = '<div class="artifact-error">ReactDOM.createRoot not available</div>';
  } else {
    document.getElementById('root').innerHTML = '<div class="artifact-error">No component found to render</div>';
  }
}`;
}

/**
 * Build a complete HTML document that renders the artifact component.
 */
export function buildArtifactHtml(jsCode: string, importMap: Record<string, string>): string {
  const importMapJson = JSON.stringify({ imports: importMap }, null, 2);
  const moduleCode = ensureReactImports(jsCode) + '\n' + buildChirpBridge() + '\n' + buildMountScript();

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
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
 * Full pipeline: JSX source → blob URL ready for iframe src.
 */
export function transformArtifact(source: string): { blobUrl: string; error?: undefined } | { blobUrl?: undefined; error: string } {
  try {
    const importMap = buildImportMap(source);
    const jsCode = transformJsx(source);
    const html = buildArtifactHtml(jsCode, importMap);
    const blobUrl = createArtifactBlobUrl(html);
    return { blobUrl };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
