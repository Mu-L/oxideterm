// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

/**
 * NotificationsPanel — Activity subview for actionable notifications
 *
 * Features:
 *  - Inline action buttons per notification
 *  - Group by source (nodeId / global)
 *  - Time segments ("Today" / "Earlier")
 *  - Collapse / expand groups
 */

import { useMemo, useCallback, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Info,
  AlertTriangle,
  XCircle,
  ShieldAlert,
  CheckCheck,
  Trash2,
  X,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { Tooltip, TooltipTrigger, TooltipContent } from '../ui/tooltip';
import {
  useNotificationCenterStore,
  type NotificationItem,
  type NotificationSeverity,
} from '../../store/notificationCenterStore';

// ============================================================================
// Severity icon
// ============================================================================

const SeverityIcon = ({ severity }: { severity: NotificationSeverity }) => {
  switch (severity) {
    case 'info':
      return <Info className="h-3.5 w-3.5 text-blue-400 shrink-0" />;
    case 'warning':
      return <AlertTriangle className="h-3.5 w-3.5 text-yellow-400 shrink-0" />;
    case 'error':
      return <XCircle className="h-3.5 w-3.5 text-red-400 shrink-0" />;
    case 'critical':
      return <ShieldAlert className="h-3.5 w-3.5 text-red-500 shrink-0" />;
  }
};

// ============================================================================
// Kind badge
// ============================================================================

const KindBadge = ({ kind }: { kind: NotificationItem['kind'] }) => {
  const { t } = useTranslation();
  const colorClass =
    kind === 'connection' ? 'bg-emerald-500/15 text-emerald-400'
    : kind === 'security' ? 'bg-red-500/15 text-red-400'
    : kind === 'transfer' ? 'bg-cyan-500/15 text-cyan-400'
    : kind === 'update' ? 'bg-purple-500/15 text-purple-400'
    : kind === 'health' ? 'bg-amber-500/15 text-amber-400'
    : kind === 'plugin' ? 'bg-indigo-500/15 text-indigo-400'
    : 'bg-blue-500/15 text-blue-400'; // agent

  return (
    <span className={cn('text-[10px] font-medium px-1.5 py-0.5 rounded-md shrink-0', colorClass)}>
      {t(`notifications.kind.${kind}`)}
    </span>
  );
};

// ============================================================================
// Relative time
// ============================================================================

function useRelativeTime(ms: number): string {
  const { t } = useTranslation();
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  const now = Date.now();
  const diff = now - ms;
  if (diff < 60_000) return t('notifications.time.just_now');
  if (diff < 3_600_000) return t('notifications.time.minutes_ago', { count: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t('notifications.time.hours_ago', { count: Math.floor(diff / 3_600_000) });
  return t('notifications.time.days_ago', { count: Math.floor(diff / 86_400_000) });
}

// ============================================================================
// Inline action buttons
// ============================================================================

const ActionButtons = ({ item }: { item: NotificationItem }) => {
  const actionable = item.actions?.filter((a) => a.handler) ?? [];
  if (actionable.length === 0) return null;

  return (
    <div className="flex items-center gap-1 mt-1">
      {actionable.map((action) => (
        <button
          key={action.id}
          onClick={(e) => {
            e.stopPropagation();
            action.handler?.();
          }}
          className={cn(
            'text-[10px] font-medium px-2 py-0.5 rounded-md transition-colors',
            action.variant === 'primary'
              ? 'bg-theme-accent/15 text-theme-accent hover:bg-theme-accent/25'
              : action.variant === 'danger'
                ? 'bg-red-500/15 text-red-400 hover:bg-red-500/25'
                : 'bg-theme-bg-hover text-theme-text-muted hover:text-theme-text',
          )}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
};

// ============================================================================
// Notification row
// ============================================================================

const NotificationRow = ({ item }: { item: NotificationItem }) => {
  const { t } = useTranslation();
  const markRead = useNotificationCenterStore((s) => s.markRead);
  const dismiss = useNotificationCenterStore((s) => s.dismiss);
  const relativeTime = useRelativeTime(item.createdAtMs);

  const handleClick = useCallback(() => {
    if (item.status === 'unread') {
      markRead(item.id);
    }
  }, [item.id, item.status, markRead]);

  const handleDismiss = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    dismiss(item.id);
  }, [item.id, dismiss]);

  return (
    <div
      onClick={handleClick}
      className={cn(
        'group flex gap-2 px-2 py-2 rounded-md cursor-pointer transition-colors',
        'hover:bg-theme-bg-hover',
        item.status === 'unread' && 'bg-theme-bg-hover/50',
      )}
    >
      <SeverityIcon severity={item.severity} />
      <div className="flex-1 min-w-0 space-y-0.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={cn(
            'text-xs truncate flex-1',
            item.status === 'unread' ? 'font-semibold text-theme-text' : 'text-theme-text-muted',
          )}>
            {item.title}
          </span>
          {item.status === 'unread' && (
            <span className="w-1.5 h-1.5 rounded-full bg-theme-accent shrink-0" />
          )}
        </div>
        {item.body && (
          <p className="text-[11px] text-theme-text-muted line-clamp-2">{item.body}</p>
        )}
        <div className="flex items-center gap-1.5 flex-wrap">
          <KindBadge kind={item.kind} />
          <span className="text-[10px] text-theme-text-muted">{relativeTime}</span>
        </div>
        <ActionButtons item={item} />
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={handleDismiss}
            className="opacity-0 group-hover:opacity-100 h-5 w-5 flex items-center justify-center rounded-sm text-theme-text-muted hover:text-theme-text transition-opacity shrink-0"
          >
            <X className="h-3 w-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{t('notifications.actions.dismiss')}</TooltipContent>
      </Tooltip>
    </div>
  );
};

// ============================================================================
// Helpers — grouping + time segmentation
// ============================================================================

/** Resolve a display-friendly group key from an item's scope. */
function groupKey(item: NotificationItem): string {
  if (item.scope.type === 'node') return `node:${item.scope.nodeId}`;
  if (item.scope.type === 'connection') return `conn:${item.scope.connectionId}`;
  return `kind:${item.kind}`;
}

/** Human label for a group. */
function groupLabel(key: string, t: (k: string) => string): string {
  if (key.startsWith('node:')) return key.slice(5);
  if (key.startsWith('conn:')) return key.slice(5).slice(0, 8);
  const kind = key.replace('kind:', '');
  return t(`notifications.kind.${kind}`);
}

type NotificationGroup = {
  key: string;
  label: string;
  items: NotificationItem[];
  unreadCount: number;
  latestMs: number;
};

function buildGroups(items: NotificationItem[], t: (k: string) => string): NotificationGroup[] {
  const map = new Map<string, NotificationGroup>();

  for (const item of items) {
    const k = groupKey(item);
    let group = map.get(k);
    if (!group) {
      group = { key: k, label: groupLabel(k, t), items: [], unreadCount: 0, latestMs: 0 };
      map.set(k, group);
    }
    group.items.push(item);
    if (item.status === 'unread') group.unreadCount++;
    if (item.createdAtMs > group.latestMs) group.latestMs = item.createdAtMs;
  }

  // Sort groups: most recent first
  return Array.from(map.values()).sort((a, b) => b.latestMs - a.latestMs);
}

/** Is a timestamp from today? */
function isToday(ms: number): boolean {
  const now = new Date();
  const date = new Date(ms);
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

// ============================================================================
// Collapsible group component
// ============================================================================

const NotificationGroupRow = ({ group }: { group: NotificationGroup }) => {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);
  const dismissByIds = useNotificationCenterStore((s) => s.dismissByIds);

  const dismissGroup = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    dismissByIds(group.items.map((item) => item.id));
  }, [group.items, dismissByIds]);

  // Single item group — render inline without header
  if (group.items.length === 1) {
    return <NotificationRow item={group.items[0]} />;
  }

  return (
    <div className="space-y-0.5">
      <div
        onClick={() => setCollapsed((prev) => !prev)}
        className="group flex items-center gap-1.5 px-2 py-1 rounded-md cursor-pointer hover:bg-theme-bg-hover transition-colors"
      >
        {collapsed
          ? <ChevronRight className="h-3 w-3 text-theme-text-muted shrink-0" />
          : <ChevronDown className="h-3 w-3 text-theme-text-muted shrink-0" />
        }
        <span className="text-[11px] font-semibold text-theme-text truncate flex-1">
          {group.label}
        </span>
        <span className="text-[10px] text-theme-text-muted">
          {group.items.length}
        </span>
        {group.unreadCount > 0 && (
          <span className="w-1.5 h-1.5 rounded-full bg-theme-accent shrink-0" />
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={dismissGroup}
              className="opacity-0 group-hover:opacity-100 h-4 w-4 flex items-center justify-center rounded-sm text-theme-text-muted hover:text-theme-text transition-opacity shrink-0"
            >
              <X className="h-3 w-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{t('notifications.actions.dismiss_all')}</TooltipContent>
        </Tooltip>
      </div>
      {!collapsed && (
        <div className="pl-3 space-y-0.5">
          {group.items.map((item) => (
            <NotificationRow key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Panel
// ============================================================================

export const NotificationsPanel = () => {
  const { t } = useTranslation();
  const items = useNotificationCenterStore((s) => s.items);
  const filter = useNotificationCenterStore((s) => s.filter);
  const unreadCount = useNotificationCenterStore((s) => s.unreadCount);
  const setFilter = useNotificationCenterStore((s) => s.setFilter);
  const markAllRead = useNotificationCenterStore((s) => s.markAllRead);
  const dismissAll = useNotificationCenterStore((s) => s.dismissAll);

  const filteredItems = useMemo(() => {
    let result = [...items];

    if (filter.status === 'unread') {
      result = result.filter((n) => n.status === 'unread');
    }
    if (filter.severity !== 'all') {
      result = result.filter((n) => n.severity === filter.severity);
    }
    if (filter.kind !== 'all') {
      result = result.filter((n) => n.kind === filter.kind);
    }

    // Newest first
    result.sort((a, b) => b.createdAtMs - a.createdAtMs);
    return result;
  }, [items, filter]);

  // Split into time segments + build groups
  const { todayGroups, earlierGroups } = useMemo(() => {
    const todayItems: NotificationItem[] = [];
    const earlierItems: NotificationItem[] = [];

    for (const item of filteredItems) {
      if (isToday(item.createdAtMs)) {
        todayItems.push(item);
      } else {
        earlierItems.push(item);
      }
    }

    return {
      todayGroups: buildGroups(todayItems, t),
      earlierGroups: buildGroups(earlierItems, t),
    };
  }, [filteredItems, t]);

  const hasToday = todayGroups.length > 0;
  const hasEarlier = earlierGroups.length > 0;

  return (
    <div className="h-full flex flex-col bg-theme-bg select-none">
      <div className="flex items-center gap-1.5 px-3 py-1 bg-theme-bg-panel border-b border-theme-border shrink-0">
        <span className="text-xs font-semibold text-theme-text mr-1">
          {t('notifications.title')}
        </span>
        {unreadCount > 0 && (
          <span className="text-[10px] text-theme-accent">
            {unreadCount}
          </span>
        )}

        <div className="flex items-center gap-1">
          {(['all', 'unread'] as const).map((status) => (
            <button
              key={status}
              onClick={() => setFilter({ status })}
              className={cn(
                'rounded-md px-2 py-0.5 text-[10px] transition-colors',
                filter.status === status
                  ? 'bg-theme-bg text-theme-text font-medium'
                  : 'text-theme-text-muted hover:text-theme-text',
              )}
            >
              {t(`notifications.filter.${status}`)}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        <div className="flex items-center gap-1">
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-2 text-[10px]"
              onClick={markAllRead}
            >
              <CheckCheck className="h-3 w-3" />
              {t('notifications.actions.mark_all_read')}
            </Button>
          )}
          {items.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={dismissAll}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('notifications.actions.dismiss_all')}</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto overflow-x-hidden px-1 py-1">
        {filteredItems.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-theme-text-muted">
            {filter.status === 'unread' ? t('notifications.empty.no_unread') : t('notifications.empty.no_notifications')}
          </div>
        ) : (
          <>
            {hasToday && (
              <div className="space-y-0.5">
                {hasEarlier && (
                  <div className="px-2 pt-1 pb-0.5">
                    <span className="text-[10px] font-semibold text-theme-text-muted uppercase tracking-wider">
                      {t('notifications.time_section.today')}
                    </span>
                  </div>
                )}
                {todayGroups.map((group) => (
                  <NotificationGroupRow key={group.key} group={group} />
                ))}
              </div>
            )}
            {hasEarlier && (
              <div className="space-y-0.5">
                <div className="px-2 pt-2 pb-0.5">
                  <span className="text-[10px] font-semibold text-theme-text-muted uppercase tracking-wider">
                    {t('notifications.time_section.earlier')}
                  </span>
                </div>
                {earlierGroups.map((group) => (
                  <NotificationGroupRow key={group.key} group={group} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};
