/**
 * ConnectionPoolMonitor - Real-time connection pool statistics panel
 * 
 * Displays live metrics for the SSH connection pool:
 * - Active/Idle/Reconnecting connections
 * - Terminal/SFTP/Forward counts
 * - Pool configuration
 */

import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api';
import type { ConnectionPoolStats } from '@/types';
import { 
  Activity, 
  Link2, 
  Terminal, 
  FolderSync, 
  ArrowLeftRight,
  RefreshCw,
  AlertTriangle,
  Clock
} from 'lucide-react';

interface StatCardProps {
  label: string;
  value: number | string;
  icon: React.ReactNode;
  color?: 'green' | 'yellow' | 'red' | 'blue' | 'gray';
  sublabel?: string;
}

const colorClasses = {
  green: 'text-emerald-500',
  yellow: 'text-amber-500',
  red: 'text-red-500',
  blue: 'text-blue-500',
  gray: 'text-gray-400',
};

const bgColorClasses = {
  green: 'bg-emerald-500/10',
  yellow: 'bg-amber-500/10',
  red: 'bg-red-500/10',
  blue: 'bg-blue-500/10',
  gray: 'bg-gray-500/10',
};

function StatCard({ label, value, icon, color = 'gray', sublabel }: StatCardProps) {
  return (
    <div className={`rounded-lg p-3 ${bgColorClasses[color]}`}>
      <div className="flex items-center gap-2">
        <span className={colorClasses[color]}>{icon}</span>
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className={`text-2xl font-bold ${colorClasses[color]}`}>
          {value}
        </span>
        {sublabel && (
          <span className="text-xs text-muted-foreground">{sublabel}</span>
        )}
      </div>
    </div>
  );
}

interface ConnectionPoolMonitorProps {
  /** Refresh interval in ms (default: 2000) */
  refreshInterval?: number;
  /** Compact mode for sidebar embedding */
  compact?: boolean;
  /** Show only when there are connections */
  autoHide?: boolean;
}

export function ConnectionPoolMonitor({ 
  refreshInterval = 2000, 
  compact = false,
  autoHide = false,
}: ConnectionPoolMonitorProps) {
  const { t } = useTranslation();
  const [stats, setStats] = useState<ConnectionPoolStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = useCallback(async () => {
    try {
      const data = await api.sshGetPoolStats();
      setStats(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('connections.failedFetchStats', 'Failed to fetch stats'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Initial fetch
    fetchStats();

    // Set up periodic refresh
    const interval = setInterval(fetchStats, refreshInterval);
    return () => clearInterval(interval);
  }, [fetchStats, refreshInterval]);

  // Auto-hide when no connections
  if (autoHide && stats && stats.totalConnections === 0) {
    return null;
  }

  if (loading && !stats) {
    return (
      <div className="p-4 text-center text-muted-foreground">
        <RefreshCw className="mx-auto h-5 w-5 animate-spin" />
        <span className="mt-2 block text-sm">{t('connections.monitor.loading')}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 text-center text-red-500">
        <AlertTriangle className="mx-auto h-5 w-5" />
        <span className="mt-2 block text-sm">{error}</span>
      </div>
    );
  }

  if (!stats) return null;

  // Compact mode - single row summary
  if (compact) {
    return (
      <div className="flex items-center gap-4 px-3 py-2 text-sm border-t border-border/50">
        <div className="flex items-center gap-1.5">
          <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-medium">{stats.totalConnections}</span>
        </div>
        {stats.activeConnections > 0 && (
          <div className="flex items-center gap-1.5 text-emerald-500">
            <Activity className="h-3.5 w-3.5" />
            <span>{stats.activeConnections}</span>
          </div>
        )}
        {stats.reconnectingConnections > 0 && (
          <div className="flex items-center gap-1.5 text-amber-500">
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            <span>{stats.reconnectingConnections}</span>
          </div>
        )}
        {stats.linkDownConnections > 0 && (
          <div className="flex items-center gap-1.5 text-red-500">
            <AlertTriangle className="h-3.5 w-3.5" />
            <span>{stats.linkDownConnections}</span>
          </div>
        )}
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Terminal className="h-3.5 w-3.5" />
          <span>{stats.totalTerminals}</span>
        </div>
      </div>
    );
  }

  // Full panel mode
  const idleTimeoutMin = Math.round(stats.idleTimeoutSecs / 60);
  const idleTimeoutLabel = stats.idleTimeoutSecs === 0
    ? t('connections.monitor.idle_timeout_never')
    : t('connections.monitor.idle_timeout', { min: idleTimeoutMin });
  const capacityLabel = stats.poolCapacity === 0 ? '∞' : stats.poolCapacity.toString();

  return (
    <div className="space-y-4 p-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{t('connections.monitor.title')}</h3>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Clock className="h-3.5 w-3.5" />
          <span>{idleTimeoutLabel}</span>
          <span>•</span>
          <span>{t('connections.monitor.capacity', { capacity: capacityLabel })}</span>
        </div>
      </div>

      {/* Connection Stats */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatCard
          label={t('connections.monitor.active')}
          value={stats.activeConnections}
          icon={<Activity className="h-4 w-4" />}
          color={stats.activeConnections > 0 ? 'green' : 'gray'}
        />
        <StatCard
          label={t('connections.monitor.idle')}
          value={stats.idleConnections}
          icon={<Link2 className="h-4 w-4" />}
          color={stats.idleConnections > 0 ? 'blue' : 'gray'}
        />
        <StatCard
          label={t('connections.monitor.reconnecting')}
          value={stats.reconnectingConnections}
          icon={<RefreshCw className="h-4 w-4" />}
          color={stats.reconnectingConnections > 0 ? 'yellow' : 'gray'}
        />
        <StatCard
          label={t('connections.monitor.link_down')}
          value={stats.linkDownConnections}
          icon={<AlertTriangle className="h-4 w-4" />}
          color={stats.linkDownConnections > 0 ? 'red' : 'gray'}
        />
      </div>

      {/* Resource Stats */}
      <div className="grid grid-cols-3 gap-2">
        <StatCard
          label={t('connections.monitor.terminals')}
          value={stats.totalTerminals}
          icon={<Terminal className="h-4 w-4" />}
          color={stats.totalTerminals > 0 ? 'green' : 'gray'}
        />
        <StatCard
          label={t('connections.monitor.sftp')}
          value={stats.totalSftpSessions}
          icon={<FolderSync className="h-4 w-4" />}
          color={stats.totalSftpSessions > 0 ? 'blue' : 'gray'}
        />
        <StatCard
          label={t('connections.monitor.forwards')}
          value={stats.totalForwards}
          icon={<ArrowLeftRight className="h-4 w-4" />}
          color={stats.totalForwards > 0 ? 'blue' : 'gray'}
        />
      </div>

      {/* Summary */}
      <div className="flex items-center justify-between text-xs text-muted-foreground border-t border-border/50 pt-3">
        <span>
          {t('connections.monitor.summary', { total: stats.totalConnections, refs: stats.totalRefCount })}
        </span>
        <span className="flex items-center gap-1">
          <RefreshCw className="h-3 w-3" />
          {t('connections.monitor.live')}
        </span>
      </div>
    </div>
  );
}

export default ConnectionPoolMonitor;
