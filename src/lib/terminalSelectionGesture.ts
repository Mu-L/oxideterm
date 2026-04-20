import type { Terminal } from '@xterm/xterm';

export const SHIFT_SELECTION_REQUIRED_CLASS = 'oxide-selection-requires-shift';

type SelectionGestureTerminal = Pick<Terminal, 'element' | 'clearSelection' | 'focus'>;

export interface SelectionGestureController {
  refresh: () => void;
  dispose: () => void;
}

export function installShiftSelectionGuard(
  terminal: SelectionGestureTerminal,
  isEnabled: () => boolean,
): SelectionGestureController {
  const root = terminal.element;
  if (!root) {
    return {
      refresh: () => {},
      dispose: () => {},
    };
  }

  let shiftPressed = false;

  const refresh = () => {
    root.classList.toggle(
      SHIFT_SELECTION_REQUIRED_CLASS,
      isEnabled() && !shiftPressed,
    );
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Shift' || shiftPressed) return;
    shiftPressed = true;
    refresh();
  };

  const handleKeyUp = (event: KeyboardEvent) => {
    if (event.key !== 'Shift') return;
    shiftPressed = false;
    refresh();
  };

  const handleWindowBlur = () => {
    shiftPressed = false;
    refresh();
  };

  const handleMouseDown = (event: MouseEvent) => {
    if (!isEnabled() || event.button !== 0 || event.shiftKey) return;
    terminal.clearSelection();
    terminal.focus();
  };

  window.addEventListener('keydown', handleKeyDown, true);
  window.addEventListener('keyup', handleKeyUp, true);
  window.addEventListener('blur', handleWindowBlur);
  root.addEventListener('mousedown', handleMouseDown, true);
  refresh();

  return {
    refresh,
    dispose: () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp, true);
      window.removeEventListener('blur', handleWindowBlur);
      root.removeEventListener('mousedown', handleMouseDown, true);
      root.classList.remove(SHIFT_SELECTION_REQUIRED_CLASS);
    },
  };
}