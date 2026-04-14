import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import { GuardrailBlock } from '@/components/ai/GuardrailBlock';

describe('GuardrailBlock', () => {
  it('hides raw text by default and reveals it on demand', () => {
    render(
      <GuardrailBlock
        part={{
          type: 'guardrail',
          code: 'tool-disabled-hard-deny',
          message: 'blocked tool transcript',
          rawText: '{"name":"terminal_exec"}',
        }}
      />,
    );

    expect(screen.getByText('blocked tool transcript')).toBeInTheDocument();
    expect(screen.queryByText('{"name":"terminal_exec"}')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'ai.context.view_original' }));

    expect(screen.getByText('{"name":"terminal_exec"}')).toBeInTheDocument();
  });
});