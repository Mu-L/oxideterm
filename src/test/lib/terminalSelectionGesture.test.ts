import { describe, expect, it, vi } from 'vitest';

import {
  installShiftSelectionGuard,
  SHIFT_SELECTION_REQUIRED_CLASS,
} from '@/lib/terminalSelectionGesture';

function createTerminalMock() {
  return {
    element: document.createElement('div'),
    clearSelection: vi.fn(),
    focus: vi.fn(),
  };
}

describe('terminalSelectionGesture', () => {
  it('adds the guard class when enabled', () => {
    const terminal = createTerminalMock();
    const controller = installShiftSelectionGuard(terminal, () => true);

    expect(terminal.element.classList.contains(SHIFT_SELECTION_REQUIRED_CLASS)).toBe(true);

    controller.dispose();
  });

  it('temporarily removes the guard class while Shift is held', () => {
    const terminal = createTerminalMock();
    const controller = installShiftSelectionGuard(terminal, () => true);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }));
    expect(terminal.element.classList.contains(SHIFT_SELECTION_REQUIRED_CLASS)).toBe(false);

    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift' }));
    expect(terminal.element.classList.contains(SHIFT_SELECTION_REQUIRED_CLASS)).toBe(true);

    controller.dispose();
  });

  it('clears the current selection and keeps focus on plain left drag', () => {
    const terminal = createTerminalMock();
    const controller = installShiftSelectionGuard(terminal, () => true);

    terminal.element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));

    expect(terminal.clearSelection).toHaveBeenCalledTimes(1);
    expect(terminal.focus).toHaveBeenCalledTimes(1);

    controller.dispose();
  });

  it('does nothing when disabled', () => {
    const terminal = createTerminalMock();
    const controller = installShiftSelectionGuard(terminal, () => false);

    terminal.element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));

    expect(terminal.element.classList.contains(SHIFT_SELECTION_REQUIRED_CLASS)).toBe(false);
    expect(terminal.clearSelection).not.toHaveBeenCalled();
    expect(terminal.focus).not.toHaveBeenCalled();

    controller.dispose();
  });
});