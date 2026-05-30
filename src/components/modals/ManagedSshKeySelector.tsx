// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import { useCallback, useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { api } from '../../lib/api';
import type { ManagedSshKeyInfo } from '../../types';

type ManagedSshKeySelectorProps = {
  selectedId: string;
  onSelectedIdChange: (id: string) => void;
  passphrase: string;
  onPassphraseChange: (value: string) => void;
};

const MANAGED_KEY_SELECT_PLACEHOLDER = '__select_managed_key__';

export function ManagedSshKeySelector({
  selectedId,
  onSelectedIdChange,
  passphrase,
  onPassphraseChange,
}: ManagedSshKeySelectorProps) {
  const { t } = useTranslation();
  const [keys, setKeys] = useState<ManagedSshKeyInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [fileDialogOpen, setFileDialogOpen] = useState(false);
  const [pasteDialogOpen, setPasteDialogOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [filePath, setFilePath] = useState('');
  const [fileName, setFileName] = useState('');
  const [filePassphrase, setFilePassphrase] = useState('');
  const [pasteName, setPasteName] = useState('');
  const [pastedPrivateKey, setPastedPrivateKey] = useState('');
  const [pastePassphrase, setPastePassphrase] = useState('');

  const refreshKeys = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setKeys(await api.listManagedSshKeys());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshKeys();
  }, [refreshKeys]);

  const resetFileDraft = () => {
    setFilePath('');
    setFileName('');
    setFilePassphrase('');
  };

  const resetPasteDraft = () => {
    setPasteName('');
    setPastedPrivateKey('');
    setPastePassphrase('');
  };

  const handleBrowseImportFile = async () => {
    const selected = await open({
      multiple: false,
      directory: false,
      title: t('modals.managed_key.import_file.browse_title'),
      defaultPath: '~/.ssh',
    });
    if (typeof selected === 'string') {
      setFilePath(selected);
    }
  };

  const handleImportFile = async () => {
    if (!filePath.trim()) return;
    setImporting(true);
    setError('');
    try {
      const key = await api.createManagedSshKeyFromFile(
        filePath.trim(),
        fileName.trim() || undefined,
        filePassphrase || undefined,
      );
      await refreshKeys();
      onSelectedIdChange(key.id);
      setFileDialogOpen(false);
      resetFileDraft();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  const handlePasteImport = async () => {
    if (!pastedPrivateKey.trim()) return;
    setImporting(true);
    setError('');
    try {
      const key = await api.createManagedSshKeyFromText(
        pastedPrivateKey,
        pasteName.trim() || undefined,
        pastePassphrase || undefined,
      );
      await refreshKeys();
      onSelectedIdChange(key.id);
      setPasteDialogOpen(false);
      resetPasteDraft();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="grid gap-3 pt-2">
      <div className="space-y-2">
        <Label>{t('modals.managed_key.selector.label')}</Label>
        <Select
          value={selectedId || MANAGED_KEY_SELECT_PLACEHOLDER}
          onValueChange={(value) => {
            onSelectedIdChange(value === MANAGED_KEY_SELECT_PLACEHOLDER ? '' : value);
          }}
        >
          <SelectTrigger>
            <SelectValue placeholder={t('modals.managed_key.selector.placeholder')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={MANAGED_KEY_SELECT_PLACEHOLDER} disabled>
              {loading
                ? t('modals.managed_key.selector.loading')
                : t('modals.managed_key.selector.placeholder')}
            </SelectItem>
            {keys.map((key) => (
              <SelectItem key={key.id} value={key.id}>
                {key.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {selectedId && (
          <p className="text-xs font-mono text-theme-text-muted">
            {keys.find((key) => key.id === selectedId)?.fingerprint ?? selectedId}
          </p>
        )}
        {error && <p className="text-xs text-theme-error">{error}</p>}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setFileDialogOpen(true)}>
          {t('modals.managed_key.import_file.open')}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => setPasteDialogOpen(true)}>
          {t('modals.managed_key.paste.open')}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => void refreshKeys()}>
          {t('modals.managed_key.selector.refresh')}
        </Button>
      </div>

      <div className="space-y-2">
        <Label>{t('modals.managed_key.passphrase')}</Label>
        <Input
          type="password"
          value={passphrase}
          onChange={(event) => onPassphraseChange(event.target.value)}
          placeholder={t('modals.managed_key.passphrase_placeholder')}
        />
        <p className="text-xs text-theme-text-muted">
          {t('modals.managed_key.passphrase_hint')}
        </p>
      </div>

      <p className="rounded-md border border-theme-border/60 bg-theme-bg/40 p-3 text-xs text-theme-text-muted">
        {t('modals.managed_key.custody_hint')}
      </p>

      <Dialog open={fileDialogOpen} onOpenChange={(open) => {
        setFileDialogOpen(open);
        if (!open) resetFileDraft();
      }}>
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>{t('modals.managed_key.import_file.title')}</DialogTitle>
            <DialogDescription>{t('modals.managed_key.import_file.description')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 p-4">
            <div className="space-y-2">
              <Label>{t('modals.managed_key.display_name')}</Label>
              <Input value={fileName} onChange={(event) => setFileName(event.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>{t('modals.managed_key.import_file.path')}</Label>
              <div className="flex gap-2">
                <Input value={filePath} onChange={(event) => setFilePath(event.target.value)} />
                <Button type="button" variant="outline" onClick={handleBrowseImportFile}>
                  {t('modals.new_connection.browse')}
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              <Label>{t('modals.managed_key.passphrase')}</Label>
              <Input
                type="password"
                value={filePassphrase}
                onChange={(event) => setFilePassphrase(event.target.value)}
                placeholder={t('modals.managed_key.passphrase_placeholder')}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setFileDialogOpen(false)}>
              {t('modals.managed_key.cancel')}
            </Button>
            <Button type="button" onClick={handleImportFile} disabled={!filePath.trim() || importing}>
              {importing ? t('modals.managed_key.importing') : t('modals.managed_key.import')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={pasteDialogOpen} onOpenChange={(open) => {
        setPasteDialogOpen(open);
        if (!open) resetPasteDraft();
      }}>
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>{t('modals.managed_key.paste.title')}</DialogTitle>
            <DialogDescription>{t('modals.managed_key.paste.description')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 p-4">
            <div className="space-y-2">
              <Label>{t('modals.managed_key.display_name')}</Label>
              <Input value={pasteName} onChange={(event) => setPasteName(event.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>{t('modals.managed_key.paste.private_key')}</Label>
              <textarea
                value={pastedPrivateKey}
                onChange={(event) => setPastedPrivateKey(event.target.value)}
                spellCheck={false}
                className="min-h-48 w-full resize-y rounded-md border border-theme-border/50 bg-theme-bg/50 px-3 py-2 font-mono text-sm text-theme-text outline-none placeholder:text-theme-text-muted focus-visible:border-theme-accent focus-visible:ring-1 focus-visible:ring-theme-accent"
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              />
            </div>
            <div className="space-y-2">
              <Label>{t('modals.managed_key.passphrase')}</Label>
              <Input
                type="password"
                value={pastePassphrase}
                onChange={(event) => setPastePassphrase(event.target.value)}
                placeholder={t('modals.managed_key.passphrase_placeholder')}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setPasteDialogOpen(false)}>
              {t('modals.managed_key.cancel')}
            </Button>
            <Button
              type="button"
              onClick={handlePasteImport}
              disabled={!pastedPrivateKey.trim() || importing}
            >
              {importing ? t('modals.managed_key.importing') : t('modals.managed_key.import')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
