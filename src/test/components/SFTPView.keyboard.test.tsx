import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FileList } from '@/components/sftp/SFTPView';
import type { FileInfo } from '@/types';

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(() => ({ listen: vi.fn() })),
}));

vi.mock('@tauri-apps/api/path', () => ({
  homeDir: vi.fn(),
}));

const files: FileInfo[] = [
  {
    name: 'logs',
    path: '/home/logs',
    file_type: 'Directory',
    size: 0,
    modified: 0,
    permissions: '',
  },
];

function renderFileList(overrides: Partial<React.ComponentProps<typeof FileList>> = {}) {
  const selected = new Set<string>();
  const setSelected = vi.fn();
  const setLastSelected = vi.fn();

  const props: React.ComponentProps<typeof FileList> = {
    title: 'Remote',
    path: '/home',
    files,
    onNavigate: vi.fn(),
    onRefresh: vi.fn(),
    active: true,
    onActivate: vi.fn(),
    selected,
    setSelected,
    lastSelected: null,
    setLastSelected,
    isRemote: true,
    t: (key: string) => key,
    ...overrides,
  };

  render(<FileList {...props} />);
  return props;
}

describe('SFTP FileList keyboard shortcuts', () => {
  it('refreshes the active pane on F5 and prevents WebView page reload', () => {
    const props = renderFileList();
    const list = screen.getByRole('listbox');
    const event = createEvent.keyDown(list, { key: 'F5' });
    const preventDefault = vi.spyOn(event, 'preventDefault');

    fireEvent(list, event);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(props.onRefresh).toHaveBeenCalledTimes(1);
  });

  it('ignores F5 when the pane is inactive', () => {
    const props = renderFileList({ active: false });
    const list = screen.getByRole('listbox');
    const event = createEvent.keyDown(list, { key: 'F5' });
    const preventDefault = vi.spyOn(event, 'preventDefault');

    fireEvent(list, event);

    expect(preventDefault).not.toHaveBeenCalled();
    expect(props.onRefresh).not.toHaveBeenCalled();
  });
});
