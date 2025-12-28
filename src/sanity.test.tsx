/**
 * Sanity test - verifies the test infrastructure works
 *
 * This is Phase 0 verification: if this passes, we have a working
 * SolidJS + Vitest + JSDOM environment.
 */
import { render, screen } from '@solidjs/testing-library';
import { describe, it, expect } from 'vitest';

function HelloWorld() {
  return <div>Hello</div>;
}

describe('Sanity Check', () => {
  it('renders a SolidJS component', () => {
    render(() => <HelloWorld />);
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });
});
