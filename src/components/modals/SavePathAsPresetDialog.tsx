// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

/**
 * Save Path As Preset Dialog
 * 
 * Save dynamic drill-down path (Mode 3) as preset connection (Mode 1)
 * Iterate through the full path from root to target to build proxy_chain
 */

import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Save, Server, ArrowRight, Loader2, AlertCircle } from 'lucide-react';
import { api } from '../../lib/api';
import type { FlatNode, SaveConnectionRequest, ProxyHopInfo } from '@/types';

interface SavePathAsPresetDialogProps {
  isOpen: boolean;
  onClose: () => void;
  targetNodeId: string;
  nodes: FlatNode[];
  onSaved?: () => void;
}

export const SavePathAsPresetDialog: React.FC<SavePathAsPresetDialogProps> = ({
  isOpen,
  onClose,
  targetNodeId,
  nodes,
  onSaved,
}) => {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Build path from root to target node
  const pathNodes = useMemo(() => {
    const path: FlatNode[] = [];
    const nodeMap = new Map(nodes.map(n => [n.id, n]));
    
    let current = nodeMap.get(targetNodeId);
    while (current) {
      path.unshift(current);
      current = current.parentId ? nodeMap.get(current.parentId) : undefined;
    }
    
    return path;
  }, [targetNodeId, nodes]);

  // Target Node
  const targetNode = pathNodes[pathNodes.length - 1];

  // Default Name
  const defaultName = useMemo(() => {
    if (!targetNode) return '';
    return targetNode.displayName || `${targetNode.username}@${targetNode.host}`;
  }, [targetNode]);

  // 当对话框打开时重置状态
  React.useEffect(() => {
    if (isOpen) {
      setName(defaultName);
      setError(null);
      setSaving(false);
    }
  }, [isOpen, defaultName]);

  if (!isOpen || !targetNode) return null;

  const handleSave = async () => {
    if (!name.trim()) {
      setError(t('modals.save_preset.error_name_required'));
      return;
    }

    setSaving(true);
    setError(null);

    try {
      // 构建 proxy_chain（暂存，等后端支持后使用）
      // 跳过最后一个节点（目标节点），前面的节点作为 proxy_chain
      const proxyChain: ProxyHopInfo[] = pathNodes.slice(0, -1).map(node => ({
        host: node.host,
        port: node.port,
        username: node.username,
        // 注意：这里我们无法获取原始认证信息，使用 agent 作为默认
        auth_type: 'agent' as const,
      }));

      // 构建连接配置（含跳板机链路）
      const request: SaveConnectionRequest = {
        name: name.trim(),
        group: null,
        host: targetNode.host,
        port: targetNode.port,
        username: targetNode.username,
        auth_type: 'agent', // 默认使用 agent
        tags: ['从钻入路径保存'],
        proxy_chain: proxyChain.length > 0 ? proxyChain : undefined,
      };

      // 保存连接
      await api.saveConnection(request);

      onSaved?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-theme-bg-elevated border border-theme-border rounded-lg shadow-xl w-[480px] max-h-[80vh] overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-theme-border">
          <div className="flex items-center gap-2">
            <Save className="w-5 h-5 text-blue-400" />
            <span className="font-medium">{t('modals.save_preset.title')}</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-theme-bg-hover rounded transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
          {/* Path preview */}
          <div className="bg-theme-bg-sunken rounded-lg p-3">
            <div className="text-xs text-theme-text-muted mb-2">{t('modals.save_preset.connection_path')}</div>
            <div className="flex flex-wrap items-center gap-1">
              {pathNodes.map((node, index) => (
                <React.Fragment key={node.id}>
                  <div 
                    className={`flex items-center gap-1 px-2 py-1 rounded text-xs ${
                      index === pathNodes.length - 1 
                        ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30' 
                        : 'bg-theme-bg-card text-theme-text'
                    }`}
                  >
                    <Server className="w-3 h-3" />
                    <span>{node.displayName || `${node.username}@${node.host}`}</span>
                  </div>
                  {index < pathNodes.length - 1 && (
                    <ArrowRight className="w-3 h-3 text-theme-text-muted" />
                  )}
                </React.Fragment>
              ))}
            </div>
          </div>

          {/* Name input */}
          <div>
            <label className="block text-sm text-theme-text-muted mb-1">{t('modals.save_preset.connection_name')}</label>
            <input
              autoCapitalize="off"
              autoCorrect="off"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('modals.save_preset.name_placeholder')}
              className="w-full px-3 py-2 bg-theme-bg-sunken border border-theme-border rounded-md text-sm focus:outline-none focus:border-theme-accent"
              autoFocus
            />
          </div>

          {/* Notes */}
          <div className="text-xs text-theme-text-muted bg-yellow-500/10 border border-yellow-500/20 rounded-md p-3">
            <p className="mb-1">{t('modals.save_preset.notes_title')}</p>
            <ul className="list-disc list-inside space-y-0.5">
              <li>{t('modals.save_preset.notes_1')}</li>
              <li>{t('modals.save_preset.notes_2')}</li>
              <li>{t('modals.save_preset.notes_3')}</li>
            </ul>
          </div>

          {/* Error message */}
          {error && (
            <div className="flex items-center gap-2 text-sm text-red-400 bg-red-500/10 border border-red-500/20 rounded-md p-3">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Footer buttons */}
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-theme-border bg-theme-bg-sunken">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-theme-text-muted hover:text-theme-text hover:bg-theme-bg-hover rounded transition-colors"
          >
            {t('modals.save_preset.cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !name.trim()}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded transition-colors flex items-center gap-2"
          >
            {saving ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('modals.save_preset.saving')}
              </>
            ) : (
              <>
                <Save className="w-4 h-4" />
                {t('modals.save_preset.save')}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
};

export default SavePathAsPresetDialog;
