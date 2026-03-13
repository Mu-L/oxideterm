/**
 * AgentPanel — Independent tab for autonomous AI Agent
 *
 * Provides: task input, plan view, step log, approval bar, control bar.
 * Uses agentStore for state, agentOrchestrator for execution.
 */

import { useState, useRef, useEffect, useMemo, useCallback, memo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bot,
  Play,
  Pause,
  Square,
  Check,
  X,
  ChevronDown,
  ChevronRight,
  Loader2,
  CheckCircle2,
  XCircle,
  Terminal,
  FileText,
  Clock,
  Zap,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ListChecks,
  History,
  RotateCcw,
  Trash2,
  Eye,
  ArrowLeft,
} from 'lucide-react';
import { useAgentStore } from '../../store/agentStore';
import { useAppStore } from '../../store/appStore';
import { useSettingsStore } from '../../store/settingsStore';
import { runAgent } from '../../lib/ai/agentOrchestrator';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import type { AgentTask, AgentStep, AutonomyLevel } from '../../types';

// ═══════════════════════════════════════════════════════════════════════════
// Autonomy Level Selector
// ═══════════════════════════════════════════════════════════════════════════

const AUTONOMY_CONFIG: Record<
  AutonomyLevel,
  { icon: React.ElementType; colorClass: string }
> = {
  supervised: { icon: Shield, colorClass: 'text-blue-400' },
  balanced: { icon: ShieldAlert, colorClass: 'text-amber-400' },
  autonomous: { icon: ShieldCheck, colorClass: 'text-green-400' },
};

const AutonomySelector = memo(() => {
  const { t } = useTranslation();
  const autonomyLevel = useAgentStore((s) => s.autonomyLevel);
  const setAutonomyLevel = useAgentStore((s) => s.setAutonomyLevel);
  const isRunning = useAgentStore((s) => s.isRunning);

  const levels: AutonomyLevel[] = ['supervised', 'balanced', 'autonomous'];

  return (
    <div className="flex items-center gap-1 rounded-lg bg-theme-bg-hover p-0.5">
      {levels.map((level) => {
        const { icon: Icon, colorClass } = AUTONOMY_CONFIG[level];
        const active = autonomyLevel === level;
        return (
          <button
            key={level}
            disabled={isRunning}
            onClick={() => setAutonomyLevel(level)}
            className={cn(
              'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all',
              active
                ? 'bg-theme-bg-active shadow-sm text-theme-text'
                : 'text-theme-text-muted hover:text-theme-text',
              isRunning && 'opacity-50 cursor-not-allowed',
            )}
            title={t(`agent.autonomy.${level}_desc`)}
          >
            <Icon className={cn('w-3.5 h-3.5', active && colorClass)} />
            <span>{t(`agent.autonomy.${level}`)}</span>
          </button>
        );
      })}
    </div>
  );
});
AutonomySelector.displayName = 'AutonomySelector';

// ═══════════════════════════════════════════════════════════════════════════
// Task Input
// ═══════════════════════════════════════════════════════════════════════════

const TaskInput = memo(({ onStart }: { onStart: (goal: string) => void }) => {
  const { t } = useTranslation();
  const [goal, setGoal] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isRunning = useAgentStore((s) => s.isRunning);

  const handleSubmit = useCallback(() => {
    const trimmed = goal.trim();
    if (!trimmed || isRunning) return;
    onStart(trimmed);
    setGoal('');
  }, [goal, isRunning, onStart]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [goal]);

  return (
    <div className="flex flex-col gap-2">
      <textarea
        ref={textareaRef}
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t('agent.input.placeholder')}
        disabled={isRunning}
        rows={3}
        className={cn(
          'w-full resize-none rounded-lg border border-theme-border bg-theme-bg-hover px-3 py-2',
          'text-sm text-theme-text placeholder:text-theme-text-muted',
          'focus:outline-none focus:ring-1 focus:ring-theme-accent',
          'disabled:opacity-50 disabled:cursor-not-allowed',
        )}
      />
      <div className="flex items-center justify-between">
        <span className="text-xs text-theme-text-muted">
          {t('agent.input.shortcut')}
        </span>
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={!goal.trim() || isRunning}
          className="gap-1.5"
        >
          <Play className="w-3.5 h-3.5" />
          {t('agent.input.start')}
        </Button>
      </div>
    </div>
  );
});
TaskInput.displayName = 'TaskInput';

// ═══════════════════════════════════════════════════════════════════════════
// Plan View
// ═══════════════════════════════════════════════════════════════════════════

const PlanView = memo(({ task }: { task: AgentTask }) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);

  if (!task.plan) return null;

  const { steps, currentStepIndex } = task.plan;

  return (
    <div className="border border-theme-border rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-2 text-sm font-medium text-theme-text bg-theme-bg-hover hover:bg-theme-bg-active transition-colors"
      >
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5" />
        )}
        <ListChecks className="w-3.5 h-3.5 text-theme-accent" />
        {t('agent.plan.title')}
        <span className="ml-auto text-xs text-theme-text-muted">
          {currentStepIndex}/{steps.length}
        </span>
      </button>
      {expanded && (
        <div className="px-3 py-2 space-y-1">
          {steps.map((step, i) => {
            const done = i < currentStepIndex;
            const active = i === currentStepIndex;
            return (
              <div
                key={i}
                className={cn(
                  'flex items-start gap-2 text-xs py-1',
                  done && 'text-theme-text-muted line-through',
                  active && 'text-theme-text font-medium',
                  !done && !active && 'text-theme-text-muted',
                )}
              >
                <span className="mt-0.5">
                  {done ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />
                  ) : active ? (
                    <Loader2 className="w-3.5 h-3.5 text-theme-accent animate-spin" />
                  ) : (
                    <span className="inline-block w-3.5 h-3.5 rounded-full border border-current" />
                  )}
                </span>
                <span>{step}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});
PlanView.displayName = 'PlanView';

// ═══════════════════════════════════════════════════════════════════════════
// Step Log
// ═══════════════════════════════════════════════════════════════════════════

const STEP_ICONS: Record<AgentStep['type'], React.ElementType> = {
  plan: ListChecks,
  tool_call: Terminal,
  observation: FileText,
  decision: Zap,
  error: XCircle,
  user_input: Shield,
  verify: CheckCircle2,
};

const StepEntry = memo(({ step }: { step: AgentStep }) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const Icon = STEP_ICONS[step.type] ?? FileText;
  const isLong = step.content.length > 200;

  return (
    <div
      className={cn(
        'border-l-2 pl-3 py-1.5',
        step.status === 'completed' && 'border-green-500/40',
        step.status === 'running' && 'border-theme-accent',
        step.status === 'error' && 'border-red-500/40',
        step.status === 'skipped' && 'border-zinc-500/40',
        step.status === 'pending' && 'border-zinc-700/40',
      )}
    >
      <div className="flex items-center gap-2">
        {step.status === 'running' ? (
          <Loader2 className="w-3.5 h-3.5 text-theme-accent animate-spin flex-shrink-0" />
        ) : (
          <Icon className={cn('w-3.5 h-3.5 flex-shrink-0', step.status === 'error' ? 'text-red-400' : 'text-theme-text-muted')} />
        )}
        <span className="text-xs font-medium text-theme-text-muted">
          {t(`agent.step.${step.type}`)}
        </span>
        {step.toolCall && (
          <code className="text-xs px-1.5 py-0.5 rounded bg-theme-bg-hover text-theme-accent font-mono">
            {step.toolCall.name}
          </code>
        )}
        {step.durationMs != null && (
          <span className="text-[10px] text-theme-text-muted flex items-center gap-0.5 ml-auto">
            <Clock className="w-3 h-3" />
            {step.durationMs < 1000
              ? `${step.durationMs}ms`
              : `${(step.durationMs / 1000).toFixed(1)}s`}
          </span>
        )}
      </div>
      {step.content && (
        <div className="mt-1">
          <pre
            className={cn(
              'text-xs whitespace-pre-wrap break-words text-theme-text-muted font-mono',
              !expanded && isLong && 'line-clamp-4',
            )}
          >
            {step.content}
          </pre>
          {isLong && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-[10px] text-theme-accent hover:underline mt-0.5"
            >
              {expanded ? t('agent.step.collapse') : t('agent.step.expand')}
            </button>
          )}
        </div>
      )}
    </div>
  );
});
StepEntry.displayName = 'StepEntry';

const StepLog = memo(({ steps }: { steps: AgentStep[] }) => {
  const { t } = useTranslation();
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new steps
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [steps.length]);

  if (steps.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-theme-text-muted">
        <Bot className="w-10 h-10 opacity-20 mb-3" />
        <p className="text-sm">{t('agent.log.empty')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {steps.map((step) => (
        <StepEntry key={step.id} step={step} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
});
StepLog.displayName = 'StepLog';

// ═══════════════════════════════════════════════════════════════════════════
// Approval Bar
// ═══════════════════════════════════════════════════════════════════════════

const ApprovalBar = memo(() => {
  const { t } = useTranslation();
  const pendingApprovals = useAgentStore((s) => s.pendingApprovals);
  const resolveApproval = useAgentStore((s) => s.resolveApproval);
  const resolveAllApprovals = useAgentStore((s) => s.resolveAllApprovals);

  if (pendingApprovals.length === 0) return null;

  return (
    <div className="border border-amber-500/30 rounded-lg bg-amber-500/5 p-3 space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium text-amber-400">
        <ShieldAlert className="w-4 h-4" />
        {t('agent.approval.title', { count: pendingApprovals.length })}
      </div>
      {pendingApprovals.map((approval) => (
        <div
          key={approval.id}
          className="flex items-center gap-2 rounded-md bg-theme-bg-hover px-3 py-2"
        >
          <Terminal className="w-3.5 h-3.5 text-theme-text-muted flex-shrink-0" />
          <code className="text-xs font-mono text-theme-text flex-1 truncate">
            {approval.toolName}({approval.arguments.length > 80
              ? approval.arguments.slice(0, 80) + '...'
              : approval.arguments})
          </code>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => resolveApproval(approval.id, false)}
            className="h-6 w-6 p-0 text-red-400 hover:text-red-300"
          >
            <X className="w-3.5 h-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => resolveApproval(approval.id, true)}
            className="h-6 w-6 p-0 text-green-400 hover:text-green-300"
          >
            <Check className="w-3.5 h-3.5" />
          </Button>
        </div>
      ))}
      {pendingApprovals.length > 1 && (
        <div className="flex gap-2 justify-end">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => resolveAllApprovals(false)}
            className="text-xs text-red-400"
          >
            {t('agent.approval.reject_all')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => resolveAllApprovals(true)}
            className="text-xs text-green-400"
          >
            {t('agent.approval.approve_all')}
          </Button>
        </div>
      )}
    </div>
  );
});
ApprovalBar.displayName = 'ApprovalBar';

// ═══════════════════════════════════════════════════════════════════════════
// Control Bar
// ═══════════════════════════════════════════════════════════════════════════

const ControlBar = memo(() => {
  const { t } = useTranslation();
  const activeTask = useAgentStore((s) => s.activeTask);
  const pauseTask = useAgentStore((s) => s.pauseTask);
  const resumeTask = useAgentStore((s) => s.resumeTask);
  const cancelTask = useAgentStore((s) => s.cancelTask);

  if (!activeTask) return null;

  const isPaused = activeTask.status === 'paused';
  const isActive = activeTask.status === 'executing' || activeTask.status === 'planning' || activeTask.status === 'awaiting_approval';

  return (
    <div className="flex items-center gap-3 pt-2 border-t border-theme-border">
      {/* Progress */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between text-xs text-theme-text-muted mb-1">
          <span>{t(`agent.status.${activeTask.status}`)}</span>
          <span>
            {t('agent.control.round', {
              current: activeTask.currentRound,
              max: activeTask.maxRounds,
            })}
          </span>
        </div>
        <div className="h-1 rounded-full bg-theme-bg-hover overflow-hidden">
          <div
            className={cn(
              'h-full rounded-full transition-all',
              activeTask.status === 'failed' ? 'bg-red-500' : 'bg-theme-accent',
            )}
            style={{
              width: `${Math.min(100, (activeTask.currentRound / activeTask.maxRounds) * 100)}%`,
            }}
          />
        </div>
      </div>

      {/* Actions */}
      {isActive && (
        <>
          <Button
            size="sm"
            variant="ghost"
            onClick={pauseTask}
            className="h-7 w-7 p-0"
            title={t('agent.control.pause')}
          >
            <Pause className="w-4 h-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={cancelTask}
            className="h-7 w-7 p-0 text-red-400"
            title={t('agent.control.cancel')}
          >
            <Square className="w-4 h-4" />
          </Button>
        </>
      )}
      {isPaused && (
        <>
          <Button
            size="sm"
            variant="ghost"
            onClick={resumeTask}
            className="h-7 w-7 p-0 text-green-400"
            title={t('agent.control.resume')}
          >
            <Play className="w-4 h-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={cancelTask}
            className="h-7 w-7 p-0 text-red-400"
            title={t('agent.control.cancel')}
          >
            <Square className="w-4 h-4" />
          </Button>
        </>
      )}
    </div>
  );
});
ControlBar.displayName = 'ControlBar';

// ═══════════════════════════════════════════════════════════════════════════
// Task Summary (shown when completed/failed)
// ═══════════════════════════════════════════════════════════════════════════

const TaskSummary = memo(({ task }: { task: AgentTask }) => {
  const { t } = useTranslation();

  if (task.status !== 'completed' && task.status !== 'failed') return null;

  return (
    <div
      className={cn(
        'rounded-lg border p-3',
        task.status === 'completed'
          ? 'border-green-500/30 bg-green-500/5'
          : 'border-red-500/30 bg-red-500/5',
      )}
    >
      <div className="flex items-center gap-2 mb-1">
        {task.status === 'completed' ? (
          <CheckCircle2 className="w-4 h-4 text-green-400" />
        ) : (
          <XCircle className="w-4 h-4 text-red-400" />
        )}
        <span className="text-sm font-medium text-theme-text">
          {task.status === 'completed' ? t('agent.summary.completed') : t('agent.summary.failed')}
        </span>
      </div>
      {task.summary && (
        <p className="text-xs text-theme-text-muted whitespace-pre-wrap">{task.summary}</p>
      )}
      {task.error && (
        <p className="text-xs text-red-400 mt-1">{task.error}</p>
      )}
    </div>
  );
});
TaskSummary.displayName = 'TaskSummary';

// ═══════════════════════════════════════════════════════════════════════════
// Task History
// ═══════════════════════════════════════════════════════════════════════════

const TaskHistory = memo(({ onRerun }: { onRerun: (goal: string) => void }) => {
  const { t } = useTranslation();
  const taskHistory = useAgentStore((s) => s.taskHistory);
  const viewingTask = useAgentStore((s) => s.viewingTask);
  const isRunning = useAgentStore((s) => s.isRunning);
  const setViewingTask = useAgentStore((s) => s.setViewingTask);
  const removeFromHistory = useAgentStore((s) => s.removeFromHistory);
  const clearHistory = useAgentStore((s) => s.clearHistory);
  const [expanded, setExpanded] = useState(false);

  if (taskHistory.length === 0 && !viewingTask) return null;

  // Replay view — show the selected historical task's steps
  if (viewingTask) {
    return (
      <div className="border-t border-theme-border pt-3">
        <div className="flex items-center gap-2 mb-2">
          <button
            onClick={() => setViewingTask(null)}
            className="flex items-center gap-1 text-xs text-theme-accent hover:text-theme-accent-hover transition-colors"
          >
            <ArrowLeft className="w-3 h-3" />
            {t('agent.history.back')}
          </button>
          <span className="text-xs text-theme-text-muted flex-1 truncate">{viewingTask.goal}</span>
        </div>
        <div className="mb-2 flex items-center gap-2 text-xs text-theme-text-muted">
          {viewingTask.status === 'completed' ? (
            <CheckCircle2 className="w-3 h-3 text-green-400" />
          ) : (
            <XCircle className="w-3 h-3 text-red-400" />
          )}
          <span>{t(`agent.status.${viewingTask.status}`)}</span>
          <span className="text-[10px]">{t('agent.history.rounds', { count: viewingTask.currentRound })}</span>
          {viewingTask.completedAt && (
            <span className="text-[10px]">{new Date(viewingTask.completedAt).toLocaleString()}</span>
          )}
        </div>
        {viewingTask.summary && (
          <div className="text-xs text-theme-text bg-theme-bg-hover rounded-md px-2.5 py-2 mb-2 whitespace-pre-wrap">
            {viewingTask.summary}
          </div>
        )}
        {viewingTask.plan && <PlanView task={viewingTask} />}
        <StepLog steps={viewingTask.steps} />
        {!isRunning && (
          <button
            onClick={() => {
              if (useAgentStore.getState().isRunning) return;
              setViewingTask(null);
              onRerun(viewingTask.goal);
            }}
            className="mt-2 flex items-center gap-1.5 text-xs text-theme-accent hover:text-theme-accent-hover transition-colors"
          >
            <RotateCcw className="w-3 h-3" />
            {t('agent.history.rerun')}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="border-t border-theme-border pt-3">
      <div className="flex items-center w-full">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 text-xs font-medium text-theme-text-muted hover:text-theme-text transition-colors flex-1"
        >
          <History className="w-3.5 h-3.5" />
          {t('agent.history.title', { count: taskHistory.length })}
          {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        </button>
        {expanded && taskHistory.length > 0 && !isRunning && (
          <button
            onClick={clearHistory}
            className="text-[10px] text-theme-text-muted hover:text-red-400 transition-colors ml-2"
            title={t('agent.history.clear')}
          >
            <Trash2 className="w-3 h-3" />
          </button>
        )}
      </div>
      {expanded && (
        <div className="mt-2 space-y-1">
          {taskHistory.map((task) => (
            <div
              key={task.id}
              className="group flex items-center gap-2 text-xs text-theme-text-muted bg-theme-bg-hover rounded-md px-2.5 py-1.5 hover:bg-theme-bg-active transition-colors"
            >
              {task.status === 'completed' ? (
                <CheckCircle2 className="w-3 h-3 text-green-400 flex-shrink-0" />
              ) : (
                <XCircle className="w-3 h-3 text-red-400 flex-shrink-0" />
              )}
              <span className="flex-1 truncate">{task.goal}</span>
              <span className="text-[10px] flex-shrink-0 group-hover:hidden">
                {task.completedAt ? new Date(task.completedAt).toLocaleTimeString() : ''}
              </span>
              <div className="hidden group-hover:flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={() => setViewingTask(task)}
                  className="p-0.5 hover:text-theme-accent transition-colors"
                  title={t('agent.history.view')}
                >
                  <Eye className="w-3 h-3" />
                </button>
                {!isRunning && (
                  <button
                    onClick={() => onRerun(task.goal)}
                    className="p-0.5 hover:text-theme-accent transition-colors"
                    title={t('agent.history.rerun')}
                  >
                    <RotateCcw className="w-3 h-3" />
                  </button>
                )}
                <button
                  onClick={() => removeFromHistory(task.id)}
                  className={cn(
                    'p-0.5 transition-colors',
                    isRunning ? 'opacity-50 cursor-not-allowed' : 'hover:text-red-400',
                  )}
                  disabled={isRunning}
                  title={t('agent.history.delete')}
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
TaskHistory.displayName = 'TaskHistory';

// ═══════════════════════════════════════════════════════════════════════════
// Provider/Model Selector (simplified for agent use)
// ═══════════════════════════════════════════════════════════════════════════

const ProviderModelSelect = memo(({
  providerId,
  model,
  onChange,
  disabled,
}: {
  providerId: string;
  model: string;
  onChange: (providerId: string, model: string) => void;
  disabled?: boolean;
}) => {
  const providers = useSettingsStore((s) => s.settings.ai.providers);
  const enabledProviders = useMemo(
    () => providers.filter((p) => p.enabled),
    [providers],
  );

  const activeProvider = useMemo(
    () => enabledProviders.find((p) => p.id === providerId) || enabledProviders[0],
    [enabledProviders, providerId],
  );

  const models = useMemo(
    () => activeProvider?.models ?? [],
    [activeProvider],
  );

  // Auto-select first provider/model if not set
  useEffect(() => {
    if (!activeProvider) return;
    if (providerId !== activeProvider.id || (!model && models.length > 0)) {
      onChange(activeProvider.id, model || activeProvider.defaultModel || models[0] || '');
    }
  }, [activeProvider, providerId, model, models, onChange]);

  return (
    <div className="flex items-center gap-2 text-xs">
      <select
        value={providerId}
        onChange={(e) => {
          const p = enabledProviders.find((p) => p.id === e.target.value);
          onChange(
            e.target.value,
            p?.defaultModel || p?.models?.[0] || '',
          );
        }}
        disabled={disabled}
        className="bg-theme-bg-hover border border-theme-border rounded-md px-2 py-1 text-theme-text text-xs focus:outline-none focus:ring-1 focus:ring-theme-accent disabled:opacity-50"
      >
        {enabledProviders.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name || p.type}
          </option>
        ))}
      </select>
      <select
        value={model}
        onChange={(e) => onChange(providerId, e.target.value)}
        disabled={disabled || models.length === 0}
        className="bg-theme-bg-hover border border-theme-border rounded-md px-2 py-1 text-theme-text text-xs focus:outline-none focus:ring-1 focus:ring-theme-accent disabled:opacity-50 max-w-[200px]"
      >
        {models.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
    </div>
  );
});
ProviderModelSelect.displayName = 'ProviderModelSelect';

// ═══════════════════════════════════════════════════════════════════════════
// Main AgentPanel
// ═══════════════════════════════════════════════════════════════════════════

export const AgentPanel = () => {
  const { t } = useTranslation();
  const activeTask = useAgentStore((s) => s.activeTask);
  const startTask = useAgentStore((s) => s.startTask);
  const isRunning = useAgentStore((s) => s.isRunning);

  // Local provider / model selection
  const aiSettings = useSettingsStore((s) => s.settings.ai);
  const [providerId, setProviderId] = useState(aiSettings.activeProviderId || '');
  const [model, setModel] = useState(aiSettings.activeModel || '');

  const handleProviderModelChange = useCallback(
    (pid: string, m: string) => {
      setProviderId(pid);
      setModel(m);
    },
    [],
  );

  const handleStart = useCallback(
    (goal: string) => {
      if (!providerId || !model) return;
      const contextTabType = useAppStore.getState().lastNonAgentTabType;
      const task = startTask(goal, providerId, model, contextTabType);
      // Get the abort controller from the store
      const controller = useAgentStore.getState().abortController;
      if (controller) {
        runAgent(task, controller.signal).catch((err) => {
          if (err instanceof DOMException && err.name === 'AbortError') return;
          useAgentStore.getState().setTaskError(
            err instanceof Error ? err.message : String(err),
          );
        });
      }
    },
    [providerId, model, startTask],
  );

  return (
    <div className="flex flex-col h-full bg-theme-bg">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-theme-border">
        <div className="flex items-center gap-2">
          <Bot className="w-5 h-5 text-theme-accent" />
          <h2 className="text-sm font-semibold text-theme-text">
            {t('agent.title')}
          </h2>
        </div>
        <ProviderModelSelect
          providerId={providerId}
          model={model}
          onChange={handleProviderModelChange}
          disabled={isRunning}
        />
      </div>

      {/* Autonomy Selector */}
      <div className="px-4 py-2 border-b border-theme-border">
        <AutonomySelector />
      </div>

      {/* Scrollable Content */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {activeTask && <PlanView task={activeTask} />}
        <StepLog steps={activeTask?.steps ?? []} />
        {activeTask && <TaskSummary task={activeTask} />}
        <TaskHistory onRerun={handleStart} />
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-theme-border space-y-3">
        <ApprovalBar />
        {activeTask && (activeTask.status === 'executing' || activeTask.status === 'planning' || activeTask.status === 'paused' || activeTask.status === 'awaiting_approval') && (
          <ControlBar />
        )}
        {!isRunning && <TaskInput onStart={handleStart} />}
      </div>
    </div>
  );
};
