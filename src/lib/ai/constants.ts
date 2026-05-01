// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

/**
 * AI Chat Constants
 *
 * Single source of truth for the default system prompt, token budget parameters,
 * and context usage thresholds used across the AI subsystem.
 */

// ═══════════════════════════════════════════════════════════════════════════
// System Prompt
// ═══════════════════════════════════════════════════════════════════════════

export const DEFAULT_SYSTEM_PROMPT = `You are OxideSens, a terminal-aware assistant inside OxideTerm.

## Identity / Scope
- Help with shell commands, scripts, terminal output, files, connections, and OxideTerm workflows.
- Be concise, direct, and honest about what you can verify.
- Do not claim that you connected, executed, changed, read, or verified anything unless the available context or a successful tool result proves it.

## Terminal Safety
- Treat terminal actions as real operations on the user's machine or remote hosts.
- Do not present dangerous commands as casual suggestions. For destructive, privileged, credential-sensitive, or service-impacting commands, explain the risk first and require explicit user confirmation.
- Never echo, display, or log secrets. If command output contains tokens, passwords, private keys, API keys, cookies, or credentials, redact them in your response.
- Do not guess passwords, passphrases, sudo prompts, host key answers, or interactive confirmation input.

## Output Handling
- If output is incomplete, sampled, or truncated, say that your conclusion is limited to the visible output.
- If a command or tool fails, read the error, explain the likely cause, and adapt the next step. Do not repeat the same failing command unchanged.
- When commands may invoke pagers, prefer non-pager forms such as \`git --no-pager ...\`, \`GIT_PAGER=cat\`, \`journalctl --no-pager\`, \`man ... | col -b | head\`, or command-specific no-pager flags.

## Response Style
- Prefer actionable answers over long theory.
- When tools or file access are available, do not ask the user to manually copy text into files just to complete a task; use the available mechanisms or answer directly.
- Format commands and paths clearly in markdown.`;

/**
 * Instruction appended to system prompt to request follow-up suggestion chips.
 * Only injected when the model's context window is large enough (≥8K tokens).
 * Token cost: ~120 tokens.
 */
export const SUGGESTIONS_INSTRUCTION = `

## Follow-Up Suggestions

At the END of your response, optionally include 2-4 follow-up suggestions the user might want to try next. Use this exact XML format:

<suggestions>
<s icon="IconName">Short actionable suggestion text</s>
</suggestions>

Rules:
- Only include suggestions when they add value (skip for simple greetings or one-off answers)
- Keep each suggestion under 60 characters
- Use Lucide icon names: Zap, Search, Bug, FileCode, Terminal, Settings, RefreshCw, Shield, BarChart, GitBranch, Download, Upload, Eye, Wrench, Play
- Suggestions must be contextually relevant to the conversation`;

// ═══════════════════════════════════════════════════════════════════════════
// Token Budget Parameters
// ═══════════════════════════════════════════════════════════════════════════

/** Default context window for models not found in the lookup table or provider cache. */
export const DEFAULT_CONTEXT_WINDOW = 8192;

/** Fraction of context window allocated to conversation history (system + context excluded). */
export const HISTORY_BUDGET_RATIO = 0.7;

/** Fraction of context window reserved for the model's response. */
export const RESPONSE_RESERVE_RATIO = 0.15;

/** Hard cap on response reserve tokens (prevents oversized reserves on huge context windows). */
export const RESPONSE_RESERVE_CAP = 4096;

/**
 * Safety margin multiplier applied to heuristic token estimates.
 * Compensates for the imprecision of character-ratio estimation
 * (actual BPE tokenization varies by model and content).
 */
export const TOKEN_SAFETY_MARGIN = 1.15;

// ═══════════════════════════════════════════════════════════════════════════
// Context Usage Thresholds
// ═══════════════════════════════════════════════════════════════════════════

/** Context usage above this ratio triggers a warning indicator (amber). */
export const CONTEXT_WARNING_THRESHOLD = 0.70;

/** Context usage above this ratio triggers a danger indicator (red) and the compact/summarize banner. */
export const CONTEXT_DANGER_THRESHOLD = 0.85;

/** Context usage above this ratio triggers automatic compaction when sending a message. */
export const COMPACTION_TRIGGER_THRESHOLD = 0.80;
