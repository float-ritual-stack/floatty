import { describe, it, expect } from 'vitest';
import { transformJsx, buildImportMap, buildArtifactHtml } from './artifactTransform';

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

  it('extracts d3 with default version', () => {
    const source = `import * as d3 from 'd3';`;
    const map = buildImportMap(source);
    expect(map['d3']).toContain('esm.sh/d3@7');
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

  it('uses latest for unknown packages', () => {
    const source = `import confetti from 'canvas-confetti';`;
    const map = buildImportMap(source);
    expect(map['canvas-confetti']).toContain('esm.sh/canvas-confetti@latest');
  });

  it('always includes react and react-dom', () => {
    const source = `const x = 1;`;
    const map = buildImportMap(source);
    expect(map['react']).toBeDefined();
    expect(map['react-dom']).toBeDefined();
  });

  it('handles subpath imports like react-dom/client', () => {
    const source = `import { createRoot } from 'react-dom/client';`;
    const map = buildImportMap(source);
    expect(map['react-dom/client']).toContain('esm.sh/react-dom');
  });

  it('skips relative imports', () => {
    const source = `import foo from './foo';`;
    const map = buildImportMap(source);
    expect(map['./foo']).toBeUndefined();
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

  it('includes chirp bridge', () => {
    const html = buildArtifactHtml('function App() {}', {});
    expect(html).toContain('window.chirp');
    expect(html).toContain("postMessage");
    expect(html).toContain("'chirp'");
  });
});
