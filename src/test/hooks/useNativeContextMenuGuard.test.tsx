import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  preventNativeContextMenu,
  useNativeContextMenuGuard,
} from '@/hooks/useNativeContextMenuGuard';

describe('useNativeContextMenuGuard', () => {
  it('prevents the WebView native context menu on unhandled right-clicks', () => {
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    });

    preventNativeContextMenu(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it('does not change events already handled by app context menus', () => {
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    });
    event.preventDefault();

    preventNativeContextMenu(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it('registers and removes the document-level guard', () => {
    const { unmount } = renderHook(() => useNativeContextMenuGuard());
    const eventWhileMounted = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    });

    document.dispatchEvent(eventWhileMounted);

    expect(eventWhileMounted.defaultPrevented).toBe(true);

    unmount();

    const eventAfterUnmount = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(eventAfterUnmount);

    expect(eventAfterUnmount.defaultPrevented).toBe(false);
  });
});
