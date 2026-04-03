// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

/**
 * RecordingControls — floating recording indicator & controls
 *
 * Shown overlaid on the terminal during an active recording.
 * Displays a red "REC" badge with elapsed time and event count,
 * with pause/resume and stop buttons.
 */

import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Circle, Pause, Play, Square } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useRecordingStore } from '../../store/recordingStore';

type RecordingControlsProps = {
  sessionId: string;
  /** Callback when the user stops recording (returns cast content) */
  onStop: (content: string) => void;
  /** Callback when the user discards the recording */
  onDiscard: () => void;
};

/** Format seconds as MM:SS */
function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export const RecordingControls: React.FC<RecordingControlsProps> = ({
  sessionId,
  onStop,
  onDiscard,
}) => {
  const { t } = useTranslation();
  // Select only primitive values to avoid new object references from
  // getRecordingMeta's spread, which causes infinite re-renders in Zustand v5.
  const hasRecording = useRecordingStore(s => s.recordings.has(sessionId));
  const recordingElapsed = useRecordingStore(s => {
    const tick = s.recordingTicks.get(sessionId);
    if (tick) return tick.elapsed;
    const entry = s.recordings.get(sessionId);
    return entry ? entry.meta.elapsed : 0;
  });
  const recordingState = useRecordingStore(s => s.getRecordingState(sessionId));
  const pauseRecording = useRecordingStore(s => s.pauseRecording);
  const resumeRecording = useRecordingStore(s => s.resumeRecording);
  const stopRecording = useRecordingStore(s => s.stopRecording);
  const discardRecording = useRecordingStore(s => s.discardRecording);

  const handlePauseResume = useCallback(() => {
    if (recordingState === 'recording') {
      pauseRecording(sessionId);
    } else if (recordingState === 'paused') {
      resumeRecording(sessionId);
    }
  }, [recordingState, sessionId, pauseRecording, resumeRecording]);

  const handleStop = useCallback(() => {
    const content = stopRecording(sessionId);
    if (content) {
      onStop(content);
    }
  }, [sessionId, stopRecording, onStop]);

  const handleDiscard = useCallback(() => {
    discardRecording(sessionId);
    onDiscard();
  }, [sessionId, discardRecording, onDiscard]);

  if (!hasRecording || recordingState === 'idle') return null;

  const isPaused = recordingState === 'paused';

  return (
    <div
      className={cn(
        'absolute top-2 right-2 z-20',
        'flex items-center gap-1.5',
        'bg-theme-bg-panel/90 backdrop-blur-sm border border-theme-border/60',
        'rounded-lg px-2.5 py-1.5 shadow-lg',
        'select-none pointer-events-auto',
        'transition-all duration-200',
      )}
    >
      {/* REC indicator with pulsing dot */}
      <div className="flex items-center gap-1.5">
        <Circle
          className={cn(
            'h-2.5 w-2.5 fill-current',
            isPaused
              ? 'text-amber-400'
              : 'text-red-500 animate-pulse',
          )}
        />
        <span
          className={cn(
            'text-[11px] font-mono font-semibold tracking-wider',
            isPaused ? 'text-amber-400' : 'text-red-400',
          )}
        >
          {isPaused
            ? t('terminal.recording.paused')
            : t('terminal.recording.recording')
          }
        </span>
      </div>

      {/* Elapsed time */}
      <span className="text-[11px] font-mono text-theme-text-muted ml-1">
        {formatElapsed(recordingElapsed)}
      </span>

      {/* Separator */}
      <div className="w-px h-3.5 bg-theme-text-muted/50" />

      {/* Pause/Resume button */}
      <button
        onClick={handlePauseResume}
        className={cn(
          'p-0.5 rounded hover:bg-theme-bg-hover/60 transition-colors',
          'text-theme-text-muted hover:text-theme-text',
        )}
        title={isPaused
          ? t('terminal.recording.resume')
          : t('terminal.recording.pause')
        }
      >
        {isPaused
          ? <Play className="h-3 w-3" />
          : <Pause className="h-3 w-3" />
        }
      </button>

      {/* Stop button */}
      <button
        onClick={handleStop}
        className={cn(
          'p-0.5 rounded hover:bg-theme-bg-hover/60 transition-colors',
          'text-theme-text-muted hover:text-red-400',
        )}
        title={t('terminal.recording.stop')}
      >
        <Square className="h-3 w-3" />
      </button>

      {/* Discard button (small X) */}
      <button
        onClick={handleDiscard}
        className={cn(
          'p-0.5 rounded hover:bg-theme-bg-hover/60 transition-colors',
          'text-theme-text-muted hover:text-theme-text text-[10px] leading-none',
        )}
        title={t('terminal.recording.discard')}
      >
        ✕
      </button>
    </div>
  );
};
