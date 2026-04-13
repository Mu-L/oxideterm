// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import type { Terminal } from '@xterm/xterm';

export type LogicalLineCell = {
  row: number;
  colStart: number;
  colEnd: number;
  text: string;
};

export type TextToCellRange = {
  textStart: number;
  textEnd: number;
  row: number;
  colStart: number;
  colEnd: number;
};

export type CachedLogicalLine = {
  id: string;
  startRow: number;
  endRow: number;
  text: string;
  cells: LogicalLineCell[];
  textToCells: TextToCellRange[];
  generation: number;
};

export type LogicalLineSlice = {
  row: number;
  colStart: number;
  colEnd: number;
};

function getLineLength(term: Terminal, row: number): number {
  const line = term.buffer.active.getLine(row);
  if (!line) {
    return 0;
  }
  return Math.min(term.cols, line.length);
}

export function getLogicalLineStart(term: Terminal, row: number): number {
  let start = Math.max(0, row);
  while (start > 0) {
    const current = term.buffer.active.getLine(start);
    if (!current?.isWrapped) {
      break;
    }
    start -= 1;
  }
  return start;
}

export function getLogicalLineEnd(term: Terminal, row: number): number {
  const buffer = term.buffer.active;
  let end = Math.max(0, row);
  while (end + 1 < buffer.length) {
    const next = buffer.getLine(end + 1);
    if (!next?.isWrapped) {
      break;
    }
    end += 1;
  }
  return end;
}

export function buildCachedLogicalLine(
  term: Terminal,
  row: number,
  generation: number,
): CachedLogicalLine | null {
  const buffer = term.buffer.active;
  const startRow = getLogicalLineStart(term, row);
  const endRow = getLogicalLineEnd(term, row);
  const cells: LogicalLineCell[] = [];
  const textToCells: TextToCellRange[] = [];
  let text = '';

  const reusableCell = buffer.getNullCell();

  for (let currentRow = startRow; currentRow <= endRow; currentRow += 1) {
    const line = buffer.getLine(currentRow);
    if (!line) {
      continue;
    }

    const maxColumns = getLineLength(term, currentRow);
    for (let column = 0; column < maxColumns; column += 1) {
      const cell = line.getCell(column, reusableCell);
      if (!cell) {
        continue;
      }

      const width = cell.getWidth();
      if (width === 0) {
        continue;
      }

      const chars = cell.getChars() || ' ';
      const textStart = text.length;
      text += chars;
      const textEnd = text.length;

      cells.push({
        row: currentRow,
        colStart: column,
        colEnd: column + Math.max(width, 1),
        text: chars,
      });

      textToCells.push({
        textStart,
        textEnd,
        row: currentRow,
        colStart: column,
        colEnd: column + Math.max(width, 1),
      });

      if (width > 1) {
        column += width - 1;
      }
    }
  }

  return {
    id: `${generation}:${startRow}:${endRow}`,
    startRow,
    endRow,
    text,
    cells,
    textToCells,
    generation,
  };
}

export function collectViewportLogicalLines(
  term: Terminal,
  generation: number,
  startRow = term.buffer.active.viewportY,
  endRow = Math.min(term.buffer.active.length - 1, term.buffer.active.viewportY + term.rows - 1),
): CachedLogicalLine[] {
  const lines: CachedLogicalLine[] = [];
  const seen = new Set<string>();

  for (let row = startRow; row <= endRow; row += 1) {
    const logicalLine = buildCachedLogicalLine(term, row, generation);
    if (!logicalLine || seen.has(logicalLine.id)) {
      continue;
    }
    seen.add(logicalLine.id);
    lines.push(logicalLine);
  }

  return lines;
}

export function mapMatchToLogicalLineSlices(
  line: CachedLogicalLine,
  matchStart: number,
  matchLength: number,
): LogicalLineSlice[] {
  const matchEnd = matchStart + matchLength;
  if (matchLength <= 0 || matchStart < 0 || matchEnd > line.text.length) {
    return [];
  }

  const rowSlices = new Map<number, LogicalLineSlice>();
  for (const segment of line.textToCells) {
    if (segment.textEnd <= matchStart || segment.textStart >= matchEnd) {
      continue;
    }

    const existing = rowSlices.get(segment.row);
    if (existing) {
      existing.colStart = Math.min(existing.colStart, segment.colStart);
      existing.colEnd = Math.max(existing.colEnd, segment.colEnd);
    } else {
      rowSlices.set(segment.row, {
        row: segment.row,
        colStart: segment.colStart,
        colEnd: segment.colEnd,
      });
    }
  }

  return Array.from(rowSlices.values()).sort((left, right) => left.row - right.row);
}