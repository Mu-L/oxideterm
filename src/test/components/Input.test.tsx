import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Input } from '@/components/ui/input';

describe('Input', () => {
  it('disables browser text transformations by default', () => {
    render(<Input aria-label="ssh username" />);

    const input = screen.getByLabelText('ssh username');

    expect(input).toHaveAttribute('autocapitalize', 'off');
    expect(input).toHaveAttribute('autocorrect', 'off');
    expect(input).toHaveAttribute('spellcheck', 'false');
  });

  it('allows callers to override text transformation attributes', () => {
    render(
      <Input
        aria-label="display name"
        autoCapitalize="sentences"
        autoCorrect="on"
        spellCheck
      />,
    );

    const input = screen.getByLabelText('display name');

    expect(input).toHaveAttribute('autocapitalize', 'sentences');
    expect(input).toHaveAttribute('autocorrect', 'on');
    expect(input).toHaveAttribute('spellcheck', 'true');
  });
});
