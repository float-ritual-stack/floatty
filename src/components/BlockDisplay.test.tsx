import { describe, it, expect } from 'vitest';
import { render } from '@solidjs/testing-library';
import { BlockDisplay } from './BlockDisplay';

describe('BlockDisplay', () => {
  it('falls back to plain text when parse hint is true but parser yields no tokens', () => {
    const content = 'text ## nope';
    const { container } = render(() => <BlockDisplay content={content} />);

    const overlay = container.querySelector('.block-display');
    expect(overlay).toBeInTheDocument();
    expect(overlay?.textContent).toBe(content);
  });

  it('never renders empty overlay text for :: content while typing', () => {
    const content = '[sc::';
    const { container } = render(() => <BlockDisplay content={content} />);

    const overlay = container.querySelector('.block-display');
    expect(overlay).toBeInTheDocument();
    expect(overlay?.textContent).toBe(content);
    expect(overlay?.textContent).not.toBe('');
  });
});
