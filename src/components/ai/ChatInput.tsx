// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { StopCircle, Terminal, Layers, Sparkles, Code2, FolderOpen } from 'lucide-react';
import { useAppStore } from '../../store/appStore';
import { api } from '../../lib/api';
import { useSettingsStore } from '../../store/settingsStore';
import { useIdeStore } from '../../store/ideStore';
import { ContextIndicator } from './ContextIndicator';
import {
  getActiveTerminalBuffer,
  getActivePaneId,
  getActivePaneMetadata,
  getCombinedPaneContext
} from '../../lib/terminalRegistry';
import { getSftpContext } from '../../lib/sftpContextRegistry';
import { getTokenAtCursor } from '../../lib/ai/inputParser';
import { filterSlashCommands, type SlashCommandDef } from '../../lib/ai/slashCommands';
import { filterParticipants, type ParticipantDef } from '../../lib/ai/participants';
import { filterReferences, type ReferenceDef } from '../../lib/ai/references';

interface ChatInputProps {
  onSend: (content: string, context?: string) => void;
  onStop: () => void;
  isLoading: boolean;
  disabled?: boolean;
  externalValue?: string;
  onExternalValueChange?: (value: string) => void;
}

export function ChatInput({ onSend, onStop, isLoading, disabled, externalValue, onExternalValueChange }: ChatInputProps) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [includeContext, setIncludeContext] = useState(false);
  const [includeAllPanes, setIncludeAllPanes] = useState(false);
  const [fetchingContext, setFetchingContext] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // ── Autocomplete state ──
  type AutocompleteItem = 
    | { kind: 'slash'; def: SlashCommandDef }
    | { kind: 'participant'; def: ParticipantDef }
    | { kind: 'reference'; def: ReferenceDef };
  const [acItems, setAcItems] = useState<AutocompleteItem[]>([]);
  const [acIndex, setAcIndex] = useState(0);
  const [acVisible, setAcVisible] = useState(false);
  const acRef = useRef<HTMLDivElement>(null);

  // Auto-focus textarea when sidebar opens (component mounts only when sidebar is visible)
  useEffect(() => {
    const raf = requestAnimationFrame(() => textareaRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, []);

  // Sync with external value (from quick prompts)
  useEffect(() => {
    if (externalValue !== undefined && externalValue !== input) {
      setInput(externalValue);
      // Focus the textarea when value is set externally
      textareaRef.current?.focus();
    }
  }, [externalValue]);

  // Notify parent of changes and update autocomplete
  const handleInputChange = (value: string) => {
    setInput(value);
    onExternalValueChange?.(value);
    updateAutocomplete(value);
  };

  // ── Autocomplete logic ──
  const updateAutocomplete = useCallback((text: string) => {
    const textarea = textareaRef.current;
    if (!textarea) { setAcVisible(false); return; }
    const cursor = textarea.selectionStart;
    const token = getTokenAtCursor(text, cursor);
    if (!token.type) { setAcVisible(false); return; }

    let items: AutocompleteItem[] = [];
    if (token.type === 'slash') {
      items = filterSlashCommands(token.partial).map(def => ({ kind: 'slash' as const, def }));
    } else if (token.type === 'participant') {
      items = filterParticipants(token.partial).map(def => ({ kind: 'participant' as const, def }));
    } else if (token.type === 'reference') {
      items = filterReferences(token.partial).map(def => ({ kind: 'reference' as const, def }));
    }

    if (items.length > 0) {
      setAcItems(items);
      setAcIndex(0);
      setAcVisible(true);
    } else {
      setAcVisible(false);
    }
  }, []);

  const applyAutocomplete = useCallback((item: AutocompleteItem) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const cursor = textarea.selectionStart;
    const token = getTokenAtCursor(input, cursor);
    if (!token.type) return;

    let replacement = '';
    if (item.kind === 'slash') {
      replacement = `/${item.def.name} `;
    } else if (item.kind === 'participant') {
      replacement = `@${item.def.name} `;
    } else {
      replacement = item.def.acceptsValue ? `#${item.def.type}:` : `#${item.def.type} `;
    }

    const before = input.slice(0, token.start);
    const after = input.slice(cursor);
    const newValue = before + replacement + after;
    setInput(newValue);
    onExternalValueChange?.(newValue);
    setAcVisible(false);

    // Move cursor after replacement
    setTimeout(() => {
      textarea.selectionStart = textarea.selectionEnd = before.length + replacement.length;
      textarea.focus();
    }, 0);
  }, [input, onExternalValueChange]);

  // Get active terminal session
  const tabs = useAppStore((state) => state.tabs);
  const activeTabId = useAppStore((state) => state.activeTabId);
  const contextMaxChars = useSettingsStore((state) => state.settings.ai.contextMaxChars);

  // Find active terminal tab
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const hasActiveTerminal = activeTab?.type === 'terminal' || activeTab?.type === 'local_terminal';

  // Check if tab has multiple panes (split panes)
  const hasSplitPanes = hasActiveTerminal && activeTab?.rootPane?.type === 'group';

  // Context source awareness
  const contextSources = useSettingsStore((s) => s.settings.ai.contextSources);
  const ideProject = useIdeStore((s) => s.project);
  const ideActiveTabPath = useIdeStore((s) => {
    const tab = s.activeTabId ? s.tabs.find(t => t.id === s.activeTabId) : undefined;
    return tab?.path ?? null;
  });
  const hasIdeContext = contextSources?.ide !== false && !!ideProject;
  const hasSftpContext = contextSources?.sftp !== false && !!activeTab?.nodeId && !!getSftpContext(activeTab.nodeId);
  const showContextChips = hasActiveTerminal || hasSplitPanes || hasIdeContext || hasSftpContext;

  // Auto-resize textarea
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 150) + 'px';
    }
  }, [input]);

  const handleSubmit = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || isLoading || disabled) return;

    // Get terminal context if requested
    // Now uses unified Registry for both SSH and Local terminals
    let context: string | undefined;
    if (includeContext && hasActiveTerminal && activeTab) {
      setFetchingContext(true);
      try {
        // Cross-Pane Vision: Gather context from ALL panes if enabled
        if (includeAllPanes && hasSplitPanes) {
          const maxCharsPerPane = contextMaxChars ? Math.floor(contextMaxChars / 4) : 2000;
          context = getCombinedPaneContext(activeTab.id, maxCharsPerPane);
          if (!context) {
            console.warn('[AI] getCombinedPaneContext returned empty, falling back to active pane');
          }
        }

        // Fallback to active pane only
        if (!context) {
          const activePaneId = getActivePaneId();
          if (activePaneId) {
            // Get buffer from registry (validates tab ID for security)
            const buffer = getActiveTerminalBuffer(activeTab.id);
            if (buffer) {
              // Trim to contextMaxChars if needed
              context = contextMaxChars && buffer.length > contextMaxChars
                ? buffer.slice(-contextMaxChars)
                : buffer;
            } else {
              // Fallback: For SSH terminals, try backend API if Registry returns null
              const metadata = getActivePaneMetadata();
              if (metadata?.terminalType === 'terminal' && metadata.sessionId) {
                const lines = await api.getScrollBuffer(metadata.sessionId, 0, contextMaxChars || 50);
                if (lines.length > 0) {
                  context = lines.map((l) => l.text).join('\n');
                }
              }
            }
          }
        }
      } catch (e) {
        console.error('[AI] Failed to get terminal context:', e);
      } finally {
        setFetchingContext(false);
      }
    }

    onSend(trimmed, context);
    setInput('');
    onExternalValueChange?.('');
    setIncludeContext(false);
    setIncludeAllPanes(false);
  }, [input, isLoading, disabled, includeContext, includeAllPanes, hasSplitPanes, hasActiveTerminal, activeTab, contextMaxChars, onSend, onExternalValueChange]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Ignore Enter during IME composition (e.g., Chinese input)
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;

      // ── Autocomplete keyboard navigation ──
      if (acVisible && acItems.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setAcIndex(i => (i + 1) % acItems.length);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setAcIndex(i => (i - 1 + acItems.length) % acItems.length);
          return;
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
          e.preventDefault();
          applyAutocomplete(acItems[acIndex]);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setAcVisible(false);
          return;
        }
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit, acVisible, acItems, acIndex, applyAutocomplete]
  );

  return (
    <div className="bg-theme-bg border-t border-theme-border/40 px-3 py-2.5">
      {/* Context Toggles — Flat Rectangular Chips */}
      {showContextChips && (
        <div className="flex flex-wrap items-center gap-1.5 mb-2">
          {hasActiveTerminal && (
            <button
              type="button"
              onClick={() => setIncludeContext(!includeContext)}
              disabled={fetchingContext}
              className={`flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold tracking-tight uppercase border rounded-md shrink-0 ${includeContext
                ? 'bg-theme-accent/10 border-theme-accent/30 text-theme-accent'
                : 'bg-transparent text-theme-text-muted border-theme-border/30 hover:border-theme-border/50'
                } ${fetchingContext ? 'opacity-50 cursor-wait' : ''}`}
            >
              <Terminal className="w-3 h-3" />
              <span>{fetchingContext ? t('ai.input.context_loading') : t('ai.input.context')}</span>
            </button>
          )}

          {hasSplitPanes && includeContext && (
            <button
              type="button"
              onClick={() => setIncludeAllPanes(!includeAllPanes)}
              disabled={fetchingContext}
              className={`flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold tracking-tight uppercase border rounded-md shrink-0 ${includeAllPanes
                ? 'bg-blue-500/10 border-blue-500/30 text-blue-500'
                : 'bg-transparent text-theme-text-muted border-theme-border/30 hover:border-theme-border/50'
                } ${fetchingContext ? 'opacity-50 cursor-wait' : ''}`}
            >
              <Layers className="w-3 h-3" />
              <span>{t('ai.input.panes')}</span>
            </button>
          )}

          {/* IDE context indicator — auto-injected when IDE mode is active */}
          {hasIdeContext && (
            <span
              className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold tracking-tight uppercase border rounded-md shrink-0 bg-emerald-500/10 border-emerald-500/30 text-emerald-500"
              title={ideActiveTabPath ?? ideProject?.name ?? t('ai.input.ide_context')}
            >
              <Code2 className="w-3 h-3" />
              <span>{t('ai.input.ide_context')}</span>
            </span>
          )}

          {/* SFTP context indicator — auto-injected when browsing files */}
          {hasSftpContext && (
            <span
              className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold tracking-tight uppercase border rounded-md shrink-0 bg-orange-500/10 border-orange-500/30 text-orange-500"
              title={getSftpContext(activeTab?.nodeId ?? '')?.remotePath ?? t('ai.input.sftp_context')}
            >
              <FolderOpen className="w-3 h-3" />
              <span>{t('ai.input.sftp_context')}</span>
            </span>
          )}
        </div>
      )}

      {/* Input area — Flat, no rounded corners, integrated */}
      <div className="relative flex flex-col bg-theme-bg-panel/15 border border-theme-border/40 rounded-md focus-within:border-theme-accent/40 shadow-sm focus-within:shadow-md transition-shadow">
        {/* Autocomplete Popup */}
        {acVisible && acItems.length > 0 && (
          <div
            ref={acRef}
            className="absolute bottom-full left-0 right-0 mb-1 max-h-[200px] overflow-y-auto bg-theme-bg border border-theme-border/60 rounded-md shadow-lg z-50"
          >
            {acItems.map((item, i) => {
              const isActive = i === acIndex;
              let label = '';
              let desc = '';
              let prefix = '';
              if (item.kind === 'slash') {
                prefix = '/';
                label = item.def.name;
                desc = t(item.def.descriptionKey, item.def.name);
              } else if (item.kind === 'participant') {
                prefix = '@';
                label = item.def.name;
                desc = t(item.def.descriptionKey, item.def.name);
              } else {
                prefix = '#';
                label = item.def.type;
                desc = t(item.def.descriptionKey, item.def.type);
              }
              return (
                <button
                  key={`${item.kind}-${label}`}
                  type="button"
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12px] ${
                    isActive
                      ? 'bg-theme-accent/15 text-theme-accent'
                      : 'text-theme-text hover:bg-theme-bg-hover/30'
                  }`}
                  onMouseDown={(e) => {
                    e.preventDefault(); // Prevent blur
                    applyAutocomplete(item);
                  }}
                  onMouseEnter={() => setAcIndex(i)}
                >
                  <span className="font-mono text-theme-accent/60 shrink-0">{prefix}{label}</span>
                  <span className="text-theme-text-muted/50 truncate text-[11px]">{desc}</span>
                </button>
              );
            })}
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => handleInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={disabled ? t('ai.input.placeholder_disabled') : t('ai.input.placeholder')}
          disabled={disabled || isLoading}
          rows={1}
          className="w-full resize-none bg-transparent border-none px-3 py-2 text-[13px] text-theme-text placeholder-theme-text-muted/30 focus-visible:outline-none focus-visible:ring-0 disabled:opacity-50 leading-relaxed min-h-[36px]"
        />

        <div className="flex items-center justify-between px-2 py-1 border-t border-theme-border/10">
          <div className="flex items-center gap-2 text-[9px] font-bold tracking-tight text-theme-text-muted/30 uppercase min-w-0 overflow-hidden">
            {isLoading ? (
              <div className="flex items-center gap-1 text-theme-accent">
                <Sparkles className="w-3 h-3 shrink-0" />
                <span className="truncate">{t('ai.input.thinking')}</span>
              </div>
            ) : (
              <ContextIndicator pendingInput={input} />
            )}
          </div>

          <div className="flex items-center gap-1.5">
            {!isLoading && (
              <span className="text-[9px] text-theme-text-muted/20 font-mono hidden sm:inline">
                SHIFT+ENTER
              </span>
            )}
            {isLoading ? (
              <button
                type="button"
                onClick={onStop}
                className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-red-500/10 hover:bg-red-500/15 text-red-500 text-[10px] font-bold"
                title={t('ai.input.stop_generation')}
              >
                <StopCircle className="w-3 h-3" />
                {t('ai.input.stop')}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!input.trim() || disabled}
                className="px-2.5 py-0.5 rounded-md bg-theme-accent text-theme-bg hover:opacity-90 disabled:opacity-20 disabled:grayscale font-bold text-[10px]"
                title={t('ai.input.send')}
              >
                {t('ai.input.send_btn')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
