// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import { memo, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { AiTurnPart } from '../../lib/ai/turnModel/types';
import { cn } from '../../lib/utils';

interface GuardrailBlockProps {
  part: Extract<AiTurnPart, { type: 'guardrail' }>;
}

function toneForCode(code: GuardrailBlockProps['part']['code']): string {
  if (code === 'tool-disabled-hard-deny' || code === 'pseudo-tool-transcript') {
    return 'border-amber-500/25 bg-amber-500/8 text-amber-100';
  }

  return 'border-theme-border/25 bg-theme-bg/40 text-theme-text-muted';
}

export const GuardrailBlock = memo(function GuardrailBlock({ part }: GuardrailBlockProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={cn('rounded-md border px-3 py-2', toneForCode(part.code))}>
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300/90" />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] leading-relaxed text-theme-text-muted/85">
            {part.message}
          </div>
          {part.rawText && (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setExpanded((value) => !value)}
                className="inline-flex items-center gap-1 text-[11px] text-theme-text-muted/60 hover:text-theme-text-muted transition-colors"
              >
                {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                <span>{t('ai.context.view_original')}</span>
              </button>
              {expanded && (
                <pre className="mt-2 max-h-[220px] overflow-auto whitespace-pre-wrap break-all rounded-md border border-theme-border/15 bg-theme-bg/60 px-2 py-1.5 text-[10px] text-theme-text-muted/65">
                  {part.rawText}
                </pre>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});