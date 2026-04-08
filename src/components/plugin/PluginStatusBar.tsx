// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import { useMemo } from 'react';
import { usePluginStore } from '@/store/pluginStore';
import { resolvePluginIcon } from '@/lib/plugin/pluginIconResolver';
import { selectVisiblePluginStatusBarItems } from '@/lib/plugin/pluginHostUi';
import { cn } from '@/lib/utils';

export function PluginStatusBar() {
  const statusBarItems = usePluginStore((state) => state.statusBarItems);

  const items = useMemo(() => selectVisiblePluginStatusBarItems(statusBarItems), [statusBarItems]);
  const leftItems = items.filter((item) => (item.alignment ?? 'left') === 'left');
  const rightItems = items.filter((item) => item.alignment === 'right');

  if (items.length === 0) return null;

  return (
    <div className="flex h-7 items-center gap-2 border-t border-theme-border bg-theme-bg-panel/90 px-2 text-xs text-theme-text-muted backdrop-blur-sm">
      <div className="flex min-w-0 items-center gap-1.5">
        {leftItems.map((item) => (
          <StatusBarItem key={item.key} item={item} />
        ))}
      </div>
      <div className="min-w-0 flex-1" />
      <div className="flex min-w-0 items-center gap-1.5">
        {rightItems.map((item) => (
          <StatusBarItem key={item.key} item={item} />
        ))}
      </div>
    </div>
  );
}

function StatusBarItem({
  item,
}: {
  item: ReturnType<typeof selectVisiblePluginStatusBarItems>[number];
}) {
  const Icon = item.icon ? resolvePluginIcon(item.icon) : null;
  const content = (
    <>
      {Icon && <Icon className="h-3.5 w-3.5 shrink-0 opacity-80" />}
      <span className="truncate">{item.text}</span>
    </>
  );

  if (item.onClick) {
    return (
      <button
        type="button"
        onClick={item.onClick}
        className="inline-flex max-w-[240px] items-center gap-1 rounded px-1.5 py-0.5 text-left text-theme-text-muted transition-colors hover:bg-theme-bg-hover hover:text-theme-text"
        title={item.tooltip ?? item.text}
      >
        {content}
      </button>
    );
  }

  return (
    <div
      className={cn('inline-flex max-w-[240px] items-center gap-1 rounded px-1.5 py-0.5 text-theme-text-muted')}
      title={item.tooltip ?? item.text}
    >
      {content}
    </div>
  );
}