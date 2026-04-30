// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import { fireEvent, render, screen } from '@testing-library/react';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchBar } from '@/components/terminal/SearchBar';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const labels: Record<string, string> = {
        'terminal.search.full_history': 'Full history',
        'terminal.search.visible_terminal': 'Visible terminal',
        'terminal.search.results_map': 'Results map',
        'terminal.search.results_map_hint': 'Click to jump',
        'terminal.search.click_to_jump': 'Click to jump to match location',
        'terminal.search.searching': 'Searching...',
        'terminal.search.line_number': 'Line',
        'terminal.search.recent_match': 'Recent',
        'terminal.search.archived_match': 'Archived',
      };
      return labels[key] ?? key;
    },
  }),
}));

vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) => selector({
    settings: {
      experimental: { gpuCanvas: false },
    },
  }),
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe('SearchBar GPU search map', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((contextId: string) => {
      if (contextId !== '2d') return null;
      return {
        clearRect: vi.fn(),
        fillRect: vi.fn(),
        fillStyle: '',
      } as unknown as RenderingContext;
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 96,
      height: 16,
      top: 0,
      right: 96,
      bottom: 16,
      left: 0,
      toJSON: () => ({}),
    });
  });

  it('jumps to the nearest full-history match from the search results map', () => {
    const onJumpToMatch = vi.fn();
    const { container } = render(
      <SearchBar
        isOpen
        onClose={vi.fn()}
        onSearch={vi.fn()}
        onFindNext={vi.fn()}
        onFindPrevious={vi.fn()}
        resultIndex={-1}
        resultCount={0}
        onDeepSearch={vi.fn()}
        onJumpToMatch={onJumpToMatch}
        deepSearchState={{
          loading: false,
          matches: [
            {
              source: 'hot',
              line_number: 10,
              column_start: 0,
              column_end: 2,
              matched_text: 'ls',
              line_content: 'ls',
            },
            {
              source: 'cold',
              line_number: 90,
              column_start: 0,
              column_end: 2,
              matched_text: 'ls',
              line_content: 'archived ls',
              chunk_id: 'chunk-1',
            },
          ],
          totalMatches: 2,
          durationMs: 1,
        }}
      />,
    );

    fireEvent.click(screen.getByText('Full history'));
    expect(screen.getByText('Results map')).toBeInTheDocument();

    const canvas = container.querySelector('canvas');
    expect(canvas).toBeTruthy();
    fireEvent.click(canvas!, { clientX: 95, clientY: 8 });

    expect(onJumpToMatch).toHaveBeenCalledWith(expect.objectContaining({
      source: 'cold',
      chunk_id: 'chunk-1',
    }));
  });
});
