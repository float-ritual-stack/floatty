import { describe, it, expect } from 'vitest';
import { transformJsx, buildImportMap, buildArtifactHtml, detectCssFrameworks, detectContentType, buildRawHtmlDocument, buildJsonViewerHtml, buildTextViewerHtml } from './artifactTransform';

describe('transformJsx', () => {
  it('transforms JSX to createElement calls', () => {
    const source = `
      import React from 'react';
      export default function App() {
        return <div>Hello</div>;
      }
    `;
    const result = transformJsx(source);
    expect(result).toContain('React.createElement');
    expect(result).not.toContain('export default');
    // ESM import kept intact (JSX-only transform)
    expect(result).toContain("import React from 'react'");
  });

  it('strips export default function and assigns __ArtifactDefault__', () => {
    const source = `export default function MyComponent() { return <p>hi</p>; }`;
    const result = transformJsx(source);
    expect(result).toContain('function MyComponent');
    expect(result).toContain('__ArtifactDefault__');
    expect(result).not.toContain('export default');
  });

  it('handles export default expression', () => {
    const source = `
      const Foo = () => <div>bar</div>;
      export default Foo;
    `;
    const result = transformJsx(source);
    expect(result).toContain('__ArtifactDefault__');
    expect(result).not.toContain('export default');
  });

  it('transforms nested JSX', () => {
    const source = `
      import React from 'react';
      function App() {
        return (
          <div className="app">
            <h1>Title</h1>
            <p>Content</p>
          </div>
        );
      }
    `;
    const result = transformJsx(source);
    expect(result).toContain('React.createElement');
    expect(result).toContain('"app"');
  });

  it('handles fragments', () => {
    const source = `
      import React from 'react';
      function App() { return <><p>a</p><p>b</p></>; }
    `;
    const result = transformJsx(source);
    expect(result).toContain('React.Fragment');
  });

  it('handles anonymous export default function', () => {
    const source = `export default function() { return <p>anon</p>; }`;
    const result = transformJsx(source);
    expect(result).toContain('__ArtifactDefault__');
    expect(result).not.toContain('export default');
  });

  it('handles TypeScript syntax (TSX support)', () => {
    const source = `
      import React from 'react';
      interface Props { name: string; }
      export default function App(props: Props) {
        return <div>{props.name}</div>;
      }
    `;
    const result = transformJsx(source);
    expect(result).toContain('React.createElement');
    expect(result).not.toContain('interface');
    expect(result).not.toContain(': Props');
  });

  it('preserves non-JSX code', () => {
    const source = `
      import React, { useState } from 'react';
      function App() {
        const [count, setCount] = useState(0);
        return <button onClick={() => setCount(c => c + 1)}>{count}</button>;
      }
    `;
    const result = transformJsx(source);
    expect(result).toContain('useState');
    expect(result).toContain('setCount');
    expect(result).toContain('React.createElement');
  });
});

describe('buildImportMap', () => {
  it('extracts react imports with default versions', () => {
    const source = `import React from 'react';`;
    const map = buildImportMap(source);
    expect(map['react']).toContain('esm.sh/react@18');
  });

  it('extracts d3 with default version and external react', () => {
    const source = `import * as d3 from 'd3';`;
    const map = buildImportMap(source);
    expect(map['d3']).toContain('esm.sh/d3@7');
    expect(map['d3']).toContain('?external=react,react-dom');
  });

  it('extracts three.js', () => {
    const source = `import * as THREE from 'three';`;
    const map = buildImportMap(source);
    expect(map['three']).toContain('esm.sh/three@0.170');
  });

  it('extracts tone', () => {
    const source = `import * as Tone from 'tone';`;
    const map = buildImportMap(source);
    expect(map['tone']).toContain('esm.sh/tone@15');
  });

  it('uses latest for unknown packages with external react', () => {
    const source = `import confetti from 'canvas-confetti';`;
    const map = buildImportMap(source);
    expect(map['canvas-confetti']).toContain('esm.sh/canvas-confetti@latest');
    expect(map['canvas-confetti']).toContain('?external=react,react-dom');
  });

  it('does not add external param to react packages', () => {
    const source = `import React from 'react';`;
    const map = buildImportMap(source);
    expect(map['react']).not.toContain('?external');
  });

  it('always includes react and react-dom', () => {
    const source = `const x = 1;`;
    const map = buildImportMap(source);
    expect(map['react']).toBeDefined();
    expect(map['react-dom']).toBeDefined();
  });

  it('handles subpath imports like react-dom/client with correct URL format', () => {
    const source = `import { createRoot } from 'react-dom/client';`;
    const map = buildImportMap(source);
    // Must be pkg@ver/sub, NOT pkg/sub@ver
    expect(map['react-dom/client']).toBe('https://esm.sh/react-dom@18/client');
  });

  it('skips relative imports', () => {
    const source = `import foo from './foo';`;
    const map = buildImportMap(source);
    expect(map['./foo']).toBeUndefined();
  });
});

describe('detectCssFrameworks', () => {
  it('detects Tailwind from color + spacing utilities', () => {
    const source = `
      export default function App() {
        return <div className="bg-zinc-950 text-zinc-100 p-4">Hello</div>;
      }
    `;
    expect(detectCssFrameworks(source)).toContain('tailwind');
  });

  it('detects Tailwind from rounded + font utilities', () => {
    const source = `
      export default function App() {
        return <div className="rounded-xl font-mono max-w-3xl">Hello</div>;
      }
    `;
    expect(detectCssFrameworks(source)).toContain('tailwind');
  });

  it('does not detect Tailwind from plain CSS classes', () => {
    const source = `
      export default function App() {
        return <div className="container header main-content">Hello</div>;
      }
    `;
    expect(detectCssFrameworks(source)).not.toContain('tailwind');
  });

  it('does not detect Tailwind from single utility match', () => {
    const source = `
      export default function App() {
        return <div className="p-4">Hello</div>;
      }
    `;
    // Only 1 pattern matches — threshold is 2
    expect(detectCssFrameworks(source)).not.toContain('tailwind');
  });

  it('returns empty array for no-class source', () => {
    const source = `export default function App() { return <p>hi</p>; }`;
    expect(detectCssFrameworks(source)).toEqual([]);
  });
});

describe('buildArtifactHtml', () => {
  it('produces valid HTML with import map', () => {
    const importMap = { 'react': 'https://esm.sh/react@18' };
    const html = buildArtifactHtml('console.log("hi")', importMap);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('importmap');
    expect(html).toContain('esm.sh/react@18');
    expect(html).toContain('console.log("hi")');
    expect(html).toContain('<div id="root">');
  });

  it('includes mount script', () => {
    const html = buildArtifactHtml('function App() {}', {});
    expect(html).toContain('createRoot');
    expect(html).toContain('__ArtifactDefault__');
  });

  it('includes error display class', () => {
    const html = buildArtifactHtml('', {});
    expect(html).toContain('artifact-error');
  });

  it('ensures React import is present', () => {
    const html = buildArtifactHtml('function App() { return null; }', {});
    expect(html).toContain("import React from 'react'");
    expect(html).toContain("import ReactDOM from 'react-dom/client'");
  });

  it('does not duplicate existing React import', () => {
    const code = "import React from 'react';\nfunction App() {}";
    const html = buildArtifactHtml(code, {});
    const matches = html.match(/import React from 'react'/g);
    expect(matches).toHaveLength(1);
  });

  it('escapes </script> in JSX source to prevent HTML breakage', () => {
    const code = 'const x = "</script><script>alert(1)</script>";';
    const html = buildArtifactHtml(code, {});
    // Raw </script> should not appear inside <script type="module">
    expect(html).not.toMatch(/<\/script><script>/);
    expect(html).toContain('<\\/script>');
  });

  it('adds ReactDOM import even when named react-dom imports exist', () => {
    const code = "import { createRoot } from 'react-dom/client';\nfunction App() {}";
    const html = buildArtifactHtml(code, {});
    // Mount script needs ReactDOM.createRoot, so default import must be added
    expect(html).toContain("import ReactDOM from 'react-dom/client'");
  });

  it('injects Tailwind CDN when cssFrameworks includes tailwind', () => {
    const html = buildArtifactHtml('function App() {}', {}, { cssFrameworks: ['tailwind'] });
    expect(html).toContain('cdn.tailwindcss.com');
  });

  it('does not inject Tailwind CDN when no frameworks specified', () => {
    const html = buildArtifactHtml('function App() {}', {});
    expect(html).not.toContain('cdn.tailwindcss.com');
  });

  it('includes chirp bridge (outbound)', () => {
    const html = buildArtifactHtml('function App() {}', {});
    expect(html).toContain('window.chirp');
    expect(html).toContain("postMessage");
    expect(html).toContain("'chirp'");
  });

  it('includes poke listener (inbound)', () => {
    const html = buildArtifactHtml('function App() {}', {});
    expect(html).toContain("'poke'");
    expect(html).toContain('window.onPoke');
  });
});

describe('detectContentType', () => {
  it('detects HTML by doctype', () => {
    expect(detectContentType('<!DOCTYPE html><html><body>hi</body></html>')).toBe('html');
  });

  it('detects HTML by html tag', () => {
    expect(detectContentType('<html>\n<head></head></html>')).toBe('html');
  });

  it('detects HTML by file extension', () => {
    expect(detectContentType('some random content', 'foo.html')).toBe('html');
    expect(detectContentType('some random content', '/path/to/bar.htm')).toBe('html');
  });

  it('detects JSON objects', () => {
    expect(detectContentType('{"key": "value"}')).toBe('json');
  });

  it('detects JSON arrays', () => {
    expect(detectContentType('[1, 2, 3]')).toBe('json');
  });

  it('detects JSX with import', () => {
    expect(detectContentType('import React from "react";\nexport default function App() {}')).toBe('jsx');
  });

  it('detects JSX with export', () => {
    expect(detectContentType('export default function App() { return <div/>; }')).toBe('jsx');
  });

  it('detects JSX with const/function', () => {
    expect(detectContentType('const App = () => <div/>;')).toBe('jsx');
  });

  it('treats curly brace that is not valid JSON as JSX', () => {
    // Object destructuring in JSX, not JSON
    expect(detectContentType('const { useState } = React;\nexport default () => <div/>;')).toBe('jsx');
  });

  it('detects markdown/text as text', () => {
    expect(detectContentType('# Hello World\n\nSome paragraph text.')).toBe('text');
  });

  it('detects Go source as text', () => {
    expect(detectContentType('package main\n\nfunc main() {}')).toBe('text');
  });

  it('detects IIFE browser scripts as text (no React patterns)', () => {
    expect(detectContentType('// harvester script\n(() => { try { console.log("hi"); } catch(e) {} })();')).toBe('text');
  });

  it('detects comment-only JS without React as text', () => {
    expect(detectContentType('// AST parser\ninterface ConversationAST {\n  nodes: string[];\n}')).toBe('text');
  });

  it('detects Python with shebang as text', () => {
    expect(detectContentType('#!/usr/bin/env python3\n"""docstring"""\ndef main():')).toBe('text');
  });

  it('detects Python without shebang as text', () => {
    expect(detectContentType('def extract_topics(text):\n    pass')).toBe('text');
    expect(detectContentType('from collections import defaultdict\nclass Foo:')).toBe('text');
  });

  it('detects Go source as text (import block)', () => {
    expect(detectContentType('package notes\n\nimport (\n\t"bufio"\n)')).toBe('text');
  });

  it('detects Rust source as text', () => {
    expect(detectContentType('use std::collections::HashMap;\nfn main() {}')).toBe('text');
    expect(detectContentType('pub fn process(input: &str) -> String {')).toBe('text');
    expect(detectContentType('pub struct Config {\n  name: String,\n}')).toBe('text');
  });

  it('detects bash scripts as text', () => {
    expect(detectContentType('#!/bin/bash\nset -e\necho "hello"')).toBe('text');
  });

  it('detects Python as text', () => {
    expect(detectContentType('def extract_topics(text):\n    pass')).toBe('text');
  });

  it('handles leading whitespace', () => {
    expect(detectContentType('  \n  <!DOCTYPE html><html></html>')).toBe('html');
    expect(detectContentType('  \n  {"key": 1}')).toBe('json');
  });
});

describe('buildRawHtmlDocument', () => {
  it('passes through complete HTML documents', () => {
    const html = '<!DOCTYPE html><html><body>content</body></html>';
    expect(buildRawHtmlDocument(html)).toBe(html);
  });

  it('wraps HTML fragments in a document', () => {
    const result = buildRawHtmlDocument('<h1>Hello</h1>');
    expect(result).toContain('<!DOCTYPE html>');
    expect(result).toContain('<h1>Hello</h1>');
  });
});

describe('buildJsonViewerHtml', () => {
  it('produces HTML with JSON viewer', () => {
    const result = buildJsonViewerHtml('{"name": "test"}');
    expect(result).toContain('<!DOCTYPE html>');
    expect(result).toContain('id="json"');
    // JSON is embedded via JSON.stringify in a script, so check the raw source is referenced
    expect(result).toContain('JSON.parse');
  });

  it('includes syntax highlighting classes', () => {
    const result = buildJsonViewerHtml('{"key": 1}');
    expect(result).toContain('.string');
    expect(result).toContain('.number');
    expect(result).toContain('.key');
  });
});

describe('buildTextViewerHtml', () => {
  it('produces HTML with text content', () => {
    const result = buildTextViewerHtml('Hello world');
    expect(result).toContain('<!DOCTYPE html>');
    expect(result).toContain('Hello world');
  });

  it('shows filename when provided', () => {
    const result = buildTextViewerHtml('content', '/path/to/file.md');
    expect(result).toContain('file.md');
  });

  it('escapes HTML in text content', () => {
    const result = buildTextViewerHtml('<script>alert(1)</script>');
    expect(result).toContain('&lt;script&gt;');
  });
});
