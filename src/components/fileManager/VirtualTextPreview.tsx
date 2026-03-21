/**
 * VirtualTextPreview
 * Streaming + virtualized preview for large text/code files
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import Prism from 'prismjs';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../../store/settingsStore';
import { getFontFamilyCSS } from './fontUtils';
import './prismLanguages';

interface FileChunk {
  data: number[];
  eof: boolean;
}

export interface VirtualTextPreviewProps {
  path: string;
  size: number;
  language?: string;
  showLineNumbers?: boolean;
  highlight?: boolean;
  className?: string;
}

const CHUNK_SIZE = 128 * 1024; // 128KB
const OVERSCAN_LINES = 20;
const PREFETCH_LINES = 60;

export const VirtualTextPreview: React.FC<VirtualTextPreviewProps> = ({
  path,
  size,
  language,
  showLineNumbers = true,
  highlight = false,
  className,
}) => {
  const { t } = useTranslation();
  const fontFamily = useSettingsStore(s => s.settings.terminal.fontFamily);
  const fontSize = useSettingsStore(s => s.settings.terminal.fontSize);
  const lineHeight = useSettingsStore(s => s.settings.terminal.lineHeight) || 1.5;

  const containerRef = useRef<HTMLDivElement>(null);
  const decoderRef = useRef<TextDecoder>(new TextDecoder());
  const carryRef = useRef<string>('');
  // Chunk-based line storage — O(1) append, no flat copy
  const chunksRef = useRef<string[][]>([]);
  // Cumulative line count at the end of each chunk for O(log n) indexed access
  const chunkOffsetsRef = useRef<number[]>([]);
  const [lineCount, setLineCount] = useState<number>(0);
  // Use refs for mutable load state so loadMore has a stable identity
  const offsetRef = useRef<number>(0);
  const eofRef = useRef<boolean>(false);
  const loadingRef = useRef<boolean>(false);
  // Generation token: incremented on reset, used to discard stale async responses
  const generationRef = useRef<number>(0);
  const [eof, setEof] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  // Quantized line index — only updates on line boundary crossings, not sub-line pixel scrolls
  const firstLineRef = useRef<number>(0);
  const [firstLine, setFirstLine] = useState<number>(0);
  const [viewportHeight, setViewportHeight] = useState<number>(0);

  // Slice a range from chunked storage without flattening everything
  // Uses contiguous chunk iteration instead of per-index binary search
  const sliceLines = useCallback((start: number, end: number): string[] => {
    if (start >= end) return [];
    const offsets = chunkOffsetsRef.current;
    const chunks = chunksRef.current;
    if (offsets.length === 0) return [];

    // Find starting chunk via binary search
    let lo = 0, hi = offsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (offsets[mid] <= start) lo = mid + 1;
      else hi = mid;
    }

    const result: string[] = [];
    let chunkIdx = lo;
    let chunkStart = chunkIdx > 0 ? offsets[chunkIdx - 1] : 0;
    let posInChunk = start - chunkStart;

    while (result.length < end - start && chunkIdx < chunks.length) {
      const chunk = chunks[chunkIdx];
      const remaining = end - start - result.length;
      const available = chunk.length - posInChunk;
      const take = Math.min(remaining, available);

      for (let i = 0; i < take; i++) {
        result.push(chunk[posInChunk + i]);
      }

      chunkIdx++;
      posInChunk = 0;
    }
    return result;
  }, []);

  const linePx = useMemo(() => Math.max(14, Math.round(fontSize * lineHeight)), [fontSize, lineHeight]);

  const reset = useCallback(() => {
    generationRef.current += 1;
    chunksRef.current = [];
    chunkOffsetsRef.current = [];
    offsetRef.current = 0;
    eofRef.current = false;
    loadingRef.current = false;
    highlightCacheRef.current = new Map();
    setLineCount(0);
    setEof(false);
    setLoading(false);
    firstLineRef.current = 0;
    setFirstLine(0);
    carryRef.current = '';
    decoderRef.current = new TextDecoder();
  }, []);

  const appendChunk = useCallback((text: string, isEof: boolean) => {
    const combined = carryRef.current + text;
    const parts = combined.split('\n');

    if (!isEof) {
      carryRef.current = parts.pop() ?? '';
      if (parts.length > 0) {
        chunksRef.current.push(parts);
        const prevTotal = chunkOffsetsRef.current.length > 0
          ? chunkOffsetsRef.current[chunkOffsetsRef.current.length - 1]
          : 0;
        chunkOffsetsRef.current.push(prevTotal + parts.length);
        setLineCount(prev => prev + parts.length);
      }
    } else {
      carryRef.current = '';
      if (parts.length > 0) {
        chunksRef.current.push(parts);
        const prevTotal = chunkOffsetsRef.current.length > 0
          ? chunkOffsetsRef.current[chunkOffsetsRef.current.length - 1]
          : 0;
        chunkOffsetsRef.current.push(prevTotal + parts.length);
        setLineCount(prev => prev + parts.length);
      }
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (loadingRef.current || eofRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    const gen = generationRef.current;

    try {
      const currentOffset = offsetRef.current;
      const length = Math.min(CHUNK_SIZE, Math.max(0, size - currentOffset));
      if (length <= 0) {
        eofRef.current = true;
        setEof(true);
        return;
      }

      const chunk = await invoke<FileChunk>('local_read_file_range', {
        path,
        offset: currentOffset,
        length,
      });

      // Discard stale response if path changed during the await
      if (gen !== generationRef.current) return;

      const bytes = new Uint8Array(chunk.data);
      const decoded = decoderRef.current.decode(bytes, { stream: !chunk.eof });
      appendChunk(decoded, chunk.eof);
      offsetRef.current = currentOffset + bytes.length;
      if (chunk.eof || bytes.length === 0) {
        eofRef.current = true;
        setEof(true);
      }
    } catch (err) {
      if (gen !== generationRef.current) return;
      console.error('Stream preview load error:', err);
      eofRef.current = true;
      setEof(true);
    } finally {
      if (gen === generationRef.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, [appendChunk, path, size]);

  // Initial load on path change — only depends on path (stable loadMore via refs)
  useEffect(() => {
    reset();
    // Use rAF to ensure reset state is flushed before loading
    const id = requestAnimationFrame(() => {
      loadMore();
    });
    return () => cancelAnimationFrame(id);
  }, [path, reset, loadMore]);

  // Resize observer for viewport height
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const ro = new ResizeObserver(entries => {
      const entry = entries[0];
      if (entry) setViewportHeight(entry.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Scroll handler + prefetch (throttled via rAF, quantized to line boundary)
  const scrollRafRef = useRef<number>(0);
  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
    scrollRafRef.current = requestAnimationFrame(() => {
      const nextTop = target.scrollTop;
      // Quantize to line index — skip re-render for sub-line pixel scrolls
      const lineIdx = Math.floor(nextTop / linePx);
      if (lineIdx !== firstLineRef.current) {
        firstLineRef.current = lineIdx;
        setFirstLine(lineIdx);
      }

      const remaining = target.scrollHeight - (nextTop + target.clientHeight);
      if (remaining < linePx * PREFETCH_LINES) {
        loadMore();
      }
    });
  }, [linePx, loadMore]);

  const linesInView = Math.ceil(viewportHeight / linePx);
  const visibleRange = useMemo(() => {
    const start = Math.max(0, firstLine - OVERSCAN_LINES);
    const end = Math.min(lineCount, firstLine + linesInView + OVERSCAN_LINES);
    return { start, end };
  }, [firstLine, linesInView, lineCount]);

  // Only slice the visible window from chunks — no full flatten
  const visibleLines = useMemo(
    () => sliceLines(visibleRange.start, visibleRange.end),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visibleRange.start, visibleRange.end, lineCount, sliceLines],
  );

  // Highlight cache: keyed by line number, stores {source, html}
  // Bounded to a window around the viewport to prevent unbounded growth
  // Cleared on path change via reset
  const highlightCacheRef = useRef<Map<number, { src: string; html: string }>>(new Map());
  const HIGHLIGHT_CACHE_WINDOW = 500; // max lines to keep cached around viewport

  const highlightedLines = useMemo(() => {
    if (!highlight || !language) {
      return visibleLines.map(line => escapeHtml(line || ' '));
    }

    const grammar = Prism.languages[language];
    if (!grammar) {
      return visibleLines.map(line => escapeHtml(line || ' '));
    }

    const cache = highlightCacheRef.current;
    const result = visibleLines.map((line, idx) => {
      const lineNum = visibleRange.start + idx;
      const src = line || ' ';
      const cached = cache.get(lineNum);
      if (cached && cached.src === src) return cached.html;
      try {
        const html = Prism.highlight(src, grammar, language);
        cache.set(lineNum, { src, html });
        return html;
      } catch {
        const html = escapeHtml(src);
        cache.set(lineNum, { src, html });
        return html;
      }
    });

    // Evict entries outside the retention window around the current viewport
    if (cache.size > HIGHLIGHT_CACHE_WINDOW * 2) {
      const retainLo = visibleRange.start - HIGHLIGHT_CACHE_WINDOW;
      const retainHi = visibleRange.end + HIGHLIGHT_CACHE_WINDOW;
      for (const key of cache.keys()) {
        if (key < retainLo || key > retainHi) {
          cache.delete(key);
        }
      }
    }

    return result;
  }, [highlight, language, visibleLines, visibleRange.start, visibleRange.end]);

  // Single HTML blob for code column — 1 DOM mutation replaces N per-line elements
  const codeHtml = useMemo(() => highlightedLines.join('\n'), [highlightedLines]);

  // Line number text for gutter column — single text node
  const gutterText = useMemo(() => {
    if (!showLineNumbers) return '';
    const len = visibleRange.end - visibleRange.start;
    const lines = new Array(len);
    for (let i = 0; i < len; i++) {
      lines[i] = String(visibleRange.start + i + 1);
    }
    return lines.join('\n');
  }, [showLineNumbers, visibleRange.start, visibleRange.end]);

  const paddingTop = visibleRange.start * linePx;
  const paddingBottom = Math.max(0, (lineCount - visibleRange.end) * linePx);
  const gutterWidth = Math.max(lineCount.toString().length, 2);

  // Memoize style objects to avoid per-render allocations
  const gutterStyle = useMemo(() => ({
    width: `${gutterWidth + 1}ch`,
    color: 'rgba(255, 255, 255, 0.3)',
    whiteSpace: 'pre' as const,
    lineHeight: `${linePx}px`,
  }), [gutterWidth, linePx]);

  const codeStyle = useMemo(() => ({
    whiteSpace: 'pre' as const,
    lineHeight: `${linePx}px`,
  }), [linePx]);

  return (
    <div
      ref={containerRef}
      className={`overflow-y-scroll overflow-x-auto bg-zinc-950 min-h-0 scrollbar-visible ${className || ''}`}
      onScroll={onScroll}
      style={{
        fontFamily: getFontFamilyCSS(fontFamily),
        fontSize: `${fontSize}px`,
        lineHeight: lineHeight,
      }}
    >
      <div style={{ paddingTop, paddingBottom }}>
        <div style={{ display: 'flex' }}>
          {showLineNumbers && (
            <div
              className="flex-shrink-0 select-none text-right pr-3"
              style={gutterStyle}
            >
              {gutterText}
            </div>
          )}
          <div
            className="flex-1"
            style={codeStyle}
            dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(codeHtml) }}
          />
        </div>

        {loading && (
          <div className="text-xs text-zinc-500 py-2">{t('fileManager.loadingMore', 'Loading...')}</div>
        )}

        {!loading && eof && lineCount === 0 && (
          <div className="text-xs text-zinc-500 py-2">{t('fileManager.emptyFile', 'Empty file')}</div>
        )}
      </div>
    </div>
  );
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
