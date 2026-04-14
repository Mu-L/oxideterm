import { describe, expect, it } from 'vitest';
import {
  getBackgroundFitStyles,
  hexToRgba,
  isTerminalContainerRenderable,
  resolveTerminalDimensions,
} from '@/lib/terminalHelpers';

describe('hexToRgba', () => {
  it('converts black', () => {
    expect(hexToRgba('#000000', 1)).toBe('rgba(0, 0, 0, 1)');
  });

  it('converts white', () => {
    expect(hexToRgba('#FFFFFF', 1)).toBe('rgba(255, 255, 255, 1)');
  });

  it('converts with alpha', () => {
    expect(hexToRgba('#FF0000', 0.5)).toBe('rgba(255, 0, 0, 0.5)');
  });

  it('handles zero alpha', () => {
    expect(hexToRgba('#123456', 0)).toBe('rgba(18, 52, 86, 0)');
  });

  it('handles lowercase hex', () => {
    expect(hexToRgba('#ff8800', 1)).toBe('rgba(255, 136, 0, 1)');
  });

  it('handles mixed case', () => {
    expect(hexToRgba('#aAbBcC', 0.8)).toBe('rgba(170, 187, 204, 0.8)');
  });
});

describe('getBackgroundFitStyles', () => {
  it('returns cover styles', () => {
    const styles = getBackgroundFitStyles('cover');
    expect(styles).toEqual({ objectFit: 'cover', width: '100%', height: '100%' });
  });

  it('returns contain styles', () => {
    const styles = getBackgroundFitStyles('contain');
    expect(styles).toEqual({ objectFit: 'contain', width: '100%', height: '100%' });
  });

  it('returns fill styles', () => {
    const styles = getBackgroundFitStyles('fill');
    expect(styles).toEqual({ objectFit: 'fill', width: '100%', height: '100%' });
  });

  it('returns empty for tile', () => {
    const styles = getBackgroundFitStyles('tile');
    expect(styles).toEqual({});
  });
});

describe('isTerminalContainerRenderable', () => {
  it('returns false for disconnected elements', () => {
    const container = document.createElement('div');
    expect(isTerminalContainerRenderable(container)).toBe(false);
  });

  it('returns false for zero-sized containers', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    Object.defineProperty(container, 'getBoundingClientRect', {
      value: () => ({ width: 0, height: 0 }),
    });

    expect(isTerminalContainerRenderable(container)).toBe(false);
    container.remove();
  });

  it('returns true for visible containers', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    Object.defineProperty(container, 'getBoundingClientRect', {
      value: () => ({ width: 800, height: 600 }),
    });

    expect(isTerminalContainerRenderable(container)).toBe(true);
    container.remove();
  });
});

describe('resolveTerminalDimensions', () => {
  it('prefers fit dimensions for visible containers', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    Object.defineProperty(container, 'getBoundingClientRect', {
      value: () => ({ width: 800, height: 600 }),
    });

    expect(
      resolveTerminalDimensions(
        container,
        { cols: 80, rows: 24 },
        { proposeDimensions: () => ({ cols: 120, rows: 40 }) },
      ),
    ).toEqual({ cols: 120, rows: 40 });

    container.remove();
  });

  it('falls back to the last stable xterm size for hidden containers', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    Object.defineProperty(container, 'getBoundingClientRect', {
      value: () => ({ width: 0, height: 0 }),
    });

    expect(
      resolveTerminalDimensions(
        container,
        { cols: 132, rows: 36 },
        { proposeDimensions: () => ({ cols: 1, rows: 1 }) },
      ),
    ).toEqual({ cols: 132, rows: 36 });

    container.remove();
  });

  it('returns null for invalid dimensions', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    Object.defineProperty(container, 'getBoundingClientRect', {
      value: () => ({ width: 800, height: 600 }),
    });

    expect(
      resolveTerminalDimensions(
        container,
        { cols: 0, rows: 0 },
        { proposeDimensions: () => ({ cols: 0, rows: 0 }) },
      ),
    ).toBeNull();

    container.remove();
  });
});
