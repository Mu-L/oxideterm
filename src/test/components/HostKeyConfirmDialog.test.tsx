import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
}));

vi.mock('@/components/ui/input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

vi.mock('@/components/ui/label', () => ({
  Label: ({ children, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) => <label {...props}>{children}</label>,
}));

import { HostKeyConfirmDialog } from '@/components/modals/HostKeyConfirmDialog';

describe('HostKeyConfirmDialog', () => {
  it('allows removing only the saved key for a changed host after hostname confirmation', () => {
    const onRemoveSavedKey = vi.fn();

    render(
      <HostKeyConfirmDialog
        open={true}
        onClose={vi.fn()}
        status={{
          status: 'changed',
          expectedFingerprint: 'SHA256:old',
          actualFingerprint: 'SHA256:new',
          keyType: 'ssh-ed25519',
        }}
        host="example.com"
        port={22}
        onAccept={vi.fn()}
        onRemoveSavedKey={onRemoveSavedKey}
        onCancel={vi.fn()}
      />,
    );

    const removeButton = screen.getByRole('button', { name: 'modals.host_key.actions.remove_saved' });
    expect(removeButton).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'modals.host_key.actions.trust_once' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('example.com'), {
      target: { value: 'example.com' },
    });

    expect(removeButton).not.toBeDisabled();
    fireEvent.click(removeButton);

    expect(onRemoveSavedKey).toHaveBeenCalledTimes(1);
  });
});