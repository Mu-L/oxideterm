// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import { useMemo, type ReactNode } from 'react';
import { usePluginStore } from '@/store/pluginStore';
import type { ContextMenuTarget } from '@/types/plugin';
import { selectVisiblePluginContextMenuItems } from '@/lib/plugin/pluginHostUi';
import { resolvePluginIcon } from '@/lib/plugin/pluginIconResolver';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '../ui/context-menu';

type PluginTargetContextMenuProps = {
  target: ContextMenuTarget;
  children: ReactNode;
};

export function PluginTargetContextMenu({ target, children }: PluginTargetContextMenuProps) {
  const contextMenuItems = usePluginStore((state) => state.contextMenuItems);
  const items = useMemo(
    () => selectVisiblePluginContextMenuItems(contextMenuItems, target),
    [contextMenuItems, target],
  );

  if (items.length === 0) return <>{children}</>;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="h-full w-full">{children}</div>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-[180px]">
        {items.map((item) => {
          const Icon = item.icon ? resolvePluginIcon(item.icon) : null;
          return (
            <ContextMenuItem key={item.key} onSelect={item.handler}>
              {Icon && <Icon className="mr-2 h-3.5 w-3.5" />}
              {item.label}
            </ContextMenuItem>
          );
        })}
      </ContextMenuContent>
    </ContextMenu>
  );
}