// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

/**
 * ToolIndicator — lightweight tool-use status entry.
 *
 * Target-first tool planning means the chat UI should not imply that a fixed
 * global tool list is currently exposed to the model. Detailed tool controls
 * live in Settings; this badge only reports the global/session state and opens
 * the relevant settings section.
 */

import { useTranslation } from 'react-i18next';
import { Settings, Wrench } from 'lucide-react';
import { useSettingsStore } from '../../store/settingsStore';
import { cn } from '../../lib/utils';

type ToolIndicatorProps = {
  onOpenSettings: () => void;
};

export const ToolIndicator = ({ onOpenSettings }: ToolIndicatorProps) => {
  const { t } = useTranslation();
  const toolUse = useSettingsStore((s) => s.settings.ai.toolUse);

  const toolUseEnabled = toolUse?.enabled === true;
  const statusLabel = toolUseEnabled
    ? t('ai.tool_status.enabled')
    : t('ai.tool_status.disabled');

  return (
    <button
      type="button"
      onClick={onOpenSettings}
      className={cn(
        'flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[10px] font-medium transition-colors',
        'text-theme-text-muted hover:bg-theme-accent/10 hover:text-theme-text',
        !toolUseEnabled && 'opacity-70',
      )}
      title={t('ai.tool_status.open_settings')}
      aria-label={t('ai.tool_status.open_settings')}
    >
      <Wrench className={cn('h-2.5 w-2.5 shrink-0', toolUseEnabled ? 'text-theme-accent' : 'text-theme-text-muted')} />
      <span>{statusLabel}</span>
      <Settings className="h-2.5 w-2.5 shrink-0 opacity-70" />
    </button>
  );
};
