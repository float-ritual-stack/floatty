import { describe, it, expect } from 'vitest';
import { transformJsx } from './src/lib/handlers/artifactTransform';

describe('artifact failing patterns', () => {
  it('transforms lucide-react imports', () => {
    const source = `
      import React from 'react';
      import { ChevronDown } from 'lucide-react';
      export default function App() {
        return <div><ChevronDown /></div>;
      }
    `;
    const result = transformJsx(source);
    expect(result).toContain('React.createElement');
  });

  it('handles long JSX with lots of JSX elements', () => {
    const source = `
      import React, { useState } from 'react';
      export default function App() {
        return (
          <div>
            <h1>Title</h1>
            <p>Line 1</p>
            <p>Line 2</p>
            <p>Line 3</p>
            <p>Line 4</p>
            <p>Line 5</p>
          </div>
        );
      }
    `;
    const result = transformJsx(source);
    expect(result).toContain('React.createElement');
  });

  it('handles component with multi-line JSX attributes', () => {
    const source = `
      import React from 'react';
      export default function App() {
        return (
          <div
            className="flex items-center"
            style={{ color: 'red' }}
            data-testid="main"
          >
            Content
          </div>
        );
      }
    `;
    const result = transformJsx(source);
    expect(result).toContain('React.createElement');
  });

  it('handles unicode characters', () => {
    const source = `
      import React from 'react';
      export default function App() {
        return <div>Hello 🌍 World → ™</div>;
      }
    `;
    const result = transformJsx(source);
    expect(result).toContain('React.createElement');
  });

  it('handles very large objects in JSX', () => {
    const source = `
      import React from 'react';
      const data = {
        sections: [
          { id: 1, title: 'A' },
          { id: 2, title: 'B' },
          { id: 3, title: 'C' },
          { id: 4, title: 'D' },
        ]
      };
      export default function App() {
        return <div>{data.sections.map(s => <span key={s.id}>{s.title}</span>)}</div>;
      }
    `;
    const result = transformJsx(source);
    expect(result).toContain('React.createElement');
  });
});
