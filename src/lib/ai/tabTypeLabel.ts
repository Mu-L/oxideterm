import type { TabType } from '../../types';

/** Human-readable label for each tab type (used in AI prompts) */
export function tabTypeLabel(t: TabType): string {
  switch (t) {
    case 'terminal': return 'SSH Remote Terminal';
    case 'local_terminal': return 'Local Terminal';
    case 'sftp': return 'SFTP File Browser';
    case 'forwards': return 'Port Forwarding';
    case 'settings': return 'Settings';
    case 'connection_monitor': return 'Connection Monitor';
    case 'connection_pool': return 'Connection Pool';
    case 'topology': return 'Network Topology';
    case 'ide': return 'Remote IDE';
    case 'file_manager': return 'File Manager';
    case 'session_manager': return 'Session Manager';
    case 'plugin': return 'Plugin View';
    case 'plugin_manager': return 'Plugin Manager';
    case 'graphics': return 'Graphics Forwarding';
    case 'launcher': return 'Application Launcher';
    case 'ai_agent': return 'AI Agent';
    default: return String(t);
  }
}
