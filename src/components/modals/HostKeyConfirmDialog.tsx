// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '../ui/dialog';
import { AlertTriangle, ShieldAlert, ShieldCheck, Key, Loader2 } from 'lucide-react';
import type { HostKeyStatus } from '../../types';

export interface HostKeyConfirmDialogProps {
  /** Whether the dialog is open */
  open: boolean;
  /** Close handler */
  onClose: () => void;
  /** Host key status from preflight */
  status: HostKeyStatus | null;
  /** Host being connected to */
  host: string;
  /** Port being connected to */
  port: number;
  /** Called when user accepts the key */
  onAccept: (persist: boolean) => void;
  /** Called when user removes the saved key for a changed host */
  onRemoveSavedKey?: () => void;
  /** Called when user cancels */
  onCancel: () => void;
  /** Loading state */
  loading?: boolean;
}

export const HostKeyConfirmDialog = ({
  open,
  onClose,
  status,
  host,
  port,
  onAccept,
  onRemoveSavedKey,
  onCancel,
  loading = false,
}: HostKeyConfirmDialogProps) => {
  const { t } = useTranslation();
  const [confirmInput, setConfirmInput] = useState('');

  // Reset input when dialog opens
  useEffect(() => {
    if (open) {
      setConfirmInput('');
    }
  }, [open]);

  if (!status || status.status === 'verified') {
    return null;
  }

  const isChanged = status.status === 'changed';
  const isUnknown = status.status === 'unknown';
  const isError = status.status === 'error';

  // For changed status, require user to type the hostname to confirm
  const confirmRequired = isChanged ? host : null;
  const confirmMatches = !confirmRequired || confirmInput.toLowerCase() === confirmRequired.toLowerCase();

  const handleTrustOnce = () => {
    if (!confirmMatches) return;
    onAccept(false);
  };

  const handleTrustAndSave = () => {
    if (!confirmMatches) return;
    onAccept(true);
  };

  const handleRemoveSavedKey = () => {
    if (!confirmMatches || !onRemoveSavedKey) return;
    onRemoveSavedKey();
  };

  const renderUnknownContent = () => {
    if (status.status !== 'unknown') return null;
    return (
      <>
        <div className="flex items-start gap-3 p-3 rounded-md bg-amber-950/30 border border-amber-700/50">
          <ShieldCheck className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-amber-200">
            {t('modals.host_key.unknown_message')}
          </div>
        </div>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-theme-text-muted text-xs">
              {t('modals.host_key.key_type_label')}
            </Label>
            <div className="font-mono text-sm text-theme-text bg-theme-bg-hover/50 px-3 py-2 rounded">
              {status.keyType}
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-theme-text-muted text-xs">
              {t('modals.host_key.fingerprint_label')}
            </Label>
            <div className="font-mono text-sm text-green-400 bg-theme-bg-hover/50 px-3 py-2 rounded break-all select-all">
              {status.fingerprint}
            </div>
          </div>
        </div>
      </>
    );
  };

  const renderChangedContent = () => {
    if (status.status !== 'changed') return null;
    return (
      <>
        <div className="flex items-start gap-3 p-3 rounded-md bg-red-950/40 border border-red-700/50">
          <ShieldAlert className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-red-200">
            {t('modals.host_key.changed_warning')}
          </div>
        </div>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-theme-text-muted text-xs">
              {t('modals.host_key.key_type_label')}
            </Label>
            <div className="font-mono text-sm text-theme-text bg-theme-bg-hover/50 px-3 py-2 rounded">
              {status.keyType}
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-theme-text-muted text-xs">
              {t('modals.host_key.expected_fingerprint')}
            </Label>
            <div className="font-mono text-sm text-theme-text-muted bg-theme-bg-hover/50 px-3 py-2 rounded break-all line-through">
              {status.expectedFingerprint}
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-theme-text-muted text-xs">
              {t('modals.host_key.actual_fingerprint')}
            </Label>
            <div className="font-mono text-sm text-red-400 bg-theme-bg-hover/50 px-3 py-2 rounded break-all select-all">
              {status.actualFingerprint}
            </div>
          </div>

          <div className="space-y-2 pt-2">
            <Label className="text-red-400 text-xs font-medium">
              {t('modals.host_key.remove_prompt', { host })}
            </Label>
            <Input
              value={confirmInput}
              onChange={(e) => setConfirmInput(e.target.value)}
              placeholder={host}
              className="font-mono"
              disabled={loading}
            />
          </div>
        </div>
      </>
    );
  };

  const renderErrorContent = () => {
    if (status.status !== 'error') return null;
    return (
      <div className="flex items-start gap-3 p-3 rounded-md bg-theme-bg-hover/50 border border-theme-border">
        <AlertTriangle className="w-5 h-5 text-theme-text-muted flex-shrink-0 mt-0.5" />
        <div className="text-sm text-theme-text">
          {status.message}
        </div>
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && !loading && onClose()}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isChanged ? (
              <ShieldAlert className="w-5 h-5 text-red-500" />
            ) : isUnknown ? (
              <Key className="w-5 h-5 text-amber-500" />
            ) : (
              <AlertTriangle className="w-5 h-5 text-theme-text-muted" />
            )}
            {isChanged
              ? t('modals.host_key.title_changed')
              : isUnknown
              ? t('modals.host_key.title_unknown')
              : t('modals.host_key.title_error')}
          </DialogTitle>
          <DialogDescription>
            <span className="font-mono text-theme-text">
              {host}:{port}
            </span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {renderUnknownContent()}
          {renderChangedContent()}
          {renderErrorContent()}
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          <Button
            variant="outline"
            onClick={onCancel}
            disabled={loading}
            className="w-full sm:w-auto"
          >
            {t('modals.host_key.actions.cancel')}
          </Button>

          {isUnknown && (
            <>
              <Button
                variant="secondary"
                onClick={handleTrustOnce}
                disabled={loading || !confirmMatches}
                className="w-full sm:w-auto"
              >
                {loading ? (
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                ) : null}
                {t('modals.host_key.actions.trust_once')}
              </Button>

              <Button
                variant={isChanged ? 'destructive' : 'default'}
                onClick={handleTrustAndSave}
                disabled={loading || !confirmMatches}
                className="w-full sm:w-auto"
              >
                {loading ? (
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                ) : null}
                {t('modals.host_key.actions.trust_save')}
              </Button>
            </>
          )}

          {isChanged && (
            <Button
              variant="destructive"
              onClick={handleRemoveSavedKey}
              disabled={loading || !confirmMatches}
              className="w-full sm:w-auto"
            >
              {loading ? (
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
              ) : null}
              {t('modals.host_key.actions.remove_saved')}
            </Button>
          )}

          {isError && (
            <Button
              variant="default"
              onClick={onCancel}
              className="w-full sm:w-auto"
            >
              {t('modals.host_key.actions.ok')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default HostKeyConfirmDialog;
