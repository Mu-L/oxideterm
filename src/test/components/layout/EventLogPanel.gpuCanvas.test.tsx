// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import { fireEvent, render, screen } from '@testing-library/react';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventLogPanel } from '@/components/layout/EventLogPanel';
import { useEventLogStore } from '@/store/eventLogStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const labels: Record<string, string> = {
        'event_log.title': 'Event Log',
        'event_log.timeline': 'Event timeline',
        'event_log.timeline_hint': 'Click to locate event',
        'event_log.dnd.on': 'Do Not Disturb',
        'event_log.dnd.description': 'DND',
        'event_log.dnd.enable': 'Enable DND',
        'event_log.dnd.disable': 'Disable DND',
        'event_log.clear': 'Clear',
        'event_log.filter_severity': 'Filter by Severity',
        'event_log.filter_category': 'Filter by Category',
        'event_log.all': 'All',
        'event_log.category.connection': 'Connection',
        'event_log.category.reconnect': 'Reconnect',
        'event_log.category.node': 'Node',
        'event_log.severity.info': 'Info',
        'event_log.severity.warn': 'Warning',
        'event_log.severity.error': 'Error',
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

vi.mock('@/store/appStore', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector({
    tabs: [{ id: 'activity', type: 'activity' }],
    activeTabId: 'activity',
  }),
}));

vi.mock('@/store/activityStore', () => ({
  useActivityStore: (selector: (state: unknown) => unknown) => selector({
    activeView: 'event_log',
  }),
}));

vi.mock('@/store/sessionTreeStore', () => ({
  useSessionTreeStore: (selector: (state: unknown) => unknown) => selector({
    getNode: () => null,
  }),
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe('EventLogPanel GPU timeline', () => {
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
      width: 120,
      height: 28,
      top: 0,
      right: 120,
      bottom: 28,
      left: 0,
      toJSON: () => ({}),
    });
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    useEventLogStore.setState({
      entries: [
        { id: 1, timestamp: 1000, severity: 'info', category: 'connection', title: 'First', source: 'test' },
        { id: 2, timestamp: 2000, severity: 'error', category: 'node', title: 'Second', source: 'test' },
      ],
      filter: { severity: 'all', category: 'all', search: '' },
      dndEnabled: false,
    });
  });

  it('renders a timeline and scrolls to the nearest event bin', () => {
    const { container } = render(<EventLogPanel />);

    expect(screen.getByText('Event timeline')).toBeInTheDocument();
    const canvas = container.querySelector('canvas');
    expect(canvas).toBeTruthy();
    fireEvent.click(canvas!, { clientX: 119, clientY: 14 });

    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });
});
