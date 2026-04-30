import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTerminalResizeScheduler } from '@/lib/terminal/resizeScheduler';

describe('createTerminalResizeScheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('batches fit into animation frame and debounces duplicate resize notifications', () => {
    vi.useFakeTimers();
    const fit = vi.fn();
    const onResize = vi.fn();
    let dimensions = { cols: 80, rows: 24 };
    const scheduler = createTerminalResizeScheduler({
      fitAddonRef: { current: { fit } } as never,
      terminalRef: { current: {} } as never,
      isRenderable: () => true,
      getDimensions: () => dimensions,
      onResize,
      resizeDebounceMs: 100,
    });

    scheduler.scheduleFit();
    scheduler.scheduleFit();

    expect(fit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(16);
    expect(fit).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(100);
    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenLastCalledWith({ cols: 80, rows: 24 });

    scheduler.scheduleFit();
    vi.advanceTimersByTime(116);
    expect(onResize).toHaveBeenCalledTimes(1);

    dimensions = { cols: 80, rows: 23 };
    scheduler.scheduleFit();
    vi.advanceTimersByTime(116);
    expect(onResize).toHaveBeenCalledTimes(2);
    expect(onResize).toHaveBeenLastCalledWith({ cols: 80, rows: 23 });

    scheduler.dispose();
  });
});
