// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

/**
 * Breadcrumb Component
 * 
 * 面包屑导航组件 - 显示从根节点到当前聚焦节点的路径
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Home, ChevronRight } from 'lucide-react';
import type { UnifiedFlatNode } from '@/types';

export interface BreadcrumbProps {
  /** 面包屑路径（从根到当前聚焦节点） */
  path: UnifiedFlatNode[];
  /** 点击导航到某层 */
  onNavigate: (nodeId: string | null) => void;
  /** 自定义类名 */
  className?: string;
}

export const Breadcrumb: React.FC<BreadcrumbProps> = ({ 
  path, 
  onNavigate,
  className,
}) => {
  const { t } = useTranslation();
  
  return (
    <div 
      className={cn(
        "flex items-center gap-1 px-3 py-2 text-sm border-b border-theme-border bg-theme-bg-card",
        "overflow-x-auto scrollbar-thin scrollbar-thumb-theme-border scrollbar-track-transparent",
        className
      )}
    >
      {/* 根节点按钮 */}
      <button
        onClick={() => onNavigate(null)}
        className={cn(
          "flex items-center gap-1 px-1.5 py-0.5 rounded-md transition-colors flex-shrink-0",
          "hover:bg-theme-bg-hover hover:text-oxide-accent",
          path.length === 0 
            ? "text-oxide-accent" 
            : "text-theme-text-muted"
        )}
        title={t('sessions.breadcrumb.back_to_root')}
      >
        <Home className="w-3.5 h-3.5" />
        {path.length === 0 && (
          <span className="text-xs font-medium">{t('sessions.breadcrumb.all_servers')}</span>
        )}
      </button>
      
      {/* 路径各层 */}
      {path.map((node, idx) => {
        const isLast = idx === path.length - 1;
        const displayName = node.displayName || `${node.username}@${node.host}`;
        
        return (
          <React.Fragment key={node.id}>
            {/* 分隔符 */}
            <ChevronRight className="w-3 h-3 text-theme-text-muted flex-shrink-0" />
            
            {/* 节点按钮 */}
            <button
              onClick={() => onNavigate(node.id)}
              className={cn(
                "px-1.5 py-0.5 rounded-md transition-colors truncate max-w-[120px]",
                "hover:bg-theme-bg-hover",
                isLast 
                  ? "text-oxide-accent font-medium" 
                  : "text-theme-text-muted hover:text-theme-text"
              )}
              title={displayName}
            >
              {displayName}
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );
};

export default Breadcrumb;
