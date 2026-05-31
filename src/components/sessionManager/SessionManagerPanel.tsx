// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useSessionManager } from './useSessionManager';
import { FolderTree } from './FolderTree';
import { ConnectionTable } from './ConnectionTable';
import { ManagerToolbar } from './ManagerToolbar';
import { OxideExportModal } from '../modals/OxideExportModal';
import { OxideImportModal } from '../modals/OxideImportModal';
import { EditConnectionModal } from '../modals/EditConnectionModal';
import {
  EditConnectionPropertiesModal,
  type DuplicateConnectionDraft,
} from '../modals/EditConnectionPropertiesModal';
import { HostKeyConfirmDialog } from '../modals/HostKeyConfirmDialog';
import { buildSaveConnectionRequestFromSaved } from '../../lib/buildSaveConnectionRequestFromSaved';
import {
  connectToSaved,
  continueConnectToSavedPlan,
  type PendingSavedConnectionPlan,
} from '../../lib/connectToSaved';
import { findUnsupportedProxyHopAuth } from '../../lib/proxyHopSupport';
import { cleanupSessionTreeConnectPlan } from '../../lib/sessionTreeConnectPlan';
import { useAppStore } from '../../store/appStore';
import { useLocalTerminalStore } from '../../store/localTerminalStore';
import { useToast } from '../../hooks/useToast';
import { useConfirm } from '../../hooks/useConfirm';
import { useTabBgActive } from '../../hooks/useTabBackground';
import { api } from '../../lib/api';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import {
  buildSavedConnectionTestRequest,
  buildTestConnectionRequest,
  requiresSavedConnectionPasswordPrompt,
} from '../../lib/testConnectionRequest';
import type { ConnectionInfo, HostKeyStatus, SerialProfile } from '../../types';
import type { EditConnectionSubmitPayload } from '../modals/EditConnectionModal';

const DUPLICATE_NAME_MARKER = 'Copy';
const DUPLICATE_DRAFT_ID_PREFIX = 'duplicate-template';

const isValidGroupPath = (name: string) => {
  const trimmedName = name.trim();
  if (!trimmedName) {
    return false;
  }

  return trimmedName.split('/').every(part => part.trim().length > 0);
};

const buildDuplicateConnectionName = (sourceName: string, existingNames: string[]) => {
  const normalizedExistingNames = new Set(
    existingNames.map(existingName => existingName.trim().toLocaleLowerCase()),
  );
  const baseName = `${sourceName} (${DUPLICATE_NAME_MARKER})`;

  if (!normalizedExistingNames.has(baseName.toLocaleLowerCase())) {
    return baseName;
  }

  // Connection names are unique in storage, so generate a draft name before opening the editor.
  for (let index = 2; ; index += 1) {
    const candidateName = `${sourceName} (${DUPLICATE_NAME_MARKER} ${index})`;
    if (!normalizedExistingNames.has(candidateName.toLocaleLowerCase())) {
      return candidateName;
    }
  }
};

type SerialProfileSectionProps = {
  profiles: SerialProfile[];
  onOpen: (profile: SerialProfile) => void;
  onDelete: (profile: SerialProfile) => void;
};

const SerialProfileSection = ({ profiles, onOpen, onDelete }: SerialProfileSectionProps) => {
  const { t } = useTranslation();

  if (profiles.length === 0) {
    return null;
  }

  return (
    <div className="border-b border-theme-border bg-theme-bg-secondary/60 px-3 py-2">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-theme-text-muted">
          {t('sessionManager.serial_profiles.title')}
        </div>
        <div className="text-[11px] text-theme-text-muted">
          {t('sessionManager.serial_profiles.count', { count: profiles.length })}
        </div>
      </div>
      <div className="space-y-1">
        {profiles.map((profile) => (
          <div
            key={profile.id}
            className="flex items-center gap-2 rounded-md border border-theme-border/60 bg-theme-bg px-2 py-1.5 text-xs"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-theme-text">{profile.name}</div>
              <div className="truncate font-mono text-[11px] text-theme-text-muted">
                {profile.portPath} · {profile.baudRate}
              </div>
            </div>
            <Button variant="ghost" size="sm" className="h-7" onClick={() => onOpen(profile)}>
              {t('sessionManager.serial_profiles.open')}
            </Button>
            <Button variant="ghost" size="sm" className="h-7 text-red-400" onClick={() => onDelete(profile)}>
              {t('sessionManager.serial_profiles.delete')}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
};

export const SessionManagerPanel = () => {
  const { t } = useTranslation();
  const bgActive = useTabBgActive('session_manager');
  const { toast } = useToast();
  const { confirm, ConfirmDialog } = useConfirm();
  const createTab = useAppStore(s => s.createTab);
  const createSerialTerminal = useLocalTerminalStore(s => s.createSerialTerminal);

  const {
    connections,
    allConnections,
    serialProfiles,
    allSerialProfiles,
    groups,
    loading,
    folderTree,
    ungroupedCount,
    selectedGroup,
    setSelectedGroup,
    expandedGroups,
    toggleExpand,
    expandPath,
    searchQuery,
    setSearchQuery,
    sortField,
    sortDirection,
    toggleSort,
    selectedIds,
    toggleSelect,
    toggleSelectAll,
    clearSelection,
    refresh,
  } = useSessionManager();

  const [showExport, setShowExport] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [editingConnectionId, setEditingConnectionId] = useState<string | null>(null);
  const [duplicateDraft, setDuplicateDraft] = useState<DuplicateConnectionDraft | null>(null);
  const [connectPromptConnectionId, setConnectPromptConnectionId] = useState<string | null>(null);
  const [connectPromptAction, setConnectPromptAction] = useState<'connect' | 'test'>('connect');
  const [testHostKeyStatus, setTestHostKeyStatus] = useState<HostKeyStatus | null>(null);
  const [connectHostKeyStatus, setConnectHostKeyStatus] = useState<HostKeyStatus | null>(null);
  const [pendingSavedConnectPlan, setPendingSavedConnectPlan] = useState<PendingSavedConnectionPlan | null>(null);
  const [pendingTestConnection, setPendingTestConnection] = useState<{
    label: string;
    request: Parameters<typeof api.testConnection>[0];
  } | null>(null);
  const [hostKeyActionLoading, setHostKeyActionLoading] = useState(false);
  const [connectHostKeyActionLoading, setConnectHostKeyActionLoading] = useState(false);
  const [createGroupDialogOpen, setCreateGroupDialogOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [creatingGroup, setCreatingGroup] = useState(false);

  const notifySavedConnectionsChanged = useCallback(() => {
    window.dispatchEvent(new CustomEvent('saved-connections-changed', {
      detail: { source: 'session-manager' },
    }));
  }, []);

  const getConnectToSavedOptions = useCallback(() => ({
    createTab,
    toast,
    t,
    onError: (id: string, reason?: 'missing-password' | 'connect-failed') => {
      if (reason === 'missing-password') {
        setConnectPromptAction('connect');
        setConnectPromptConnectionId(id);
        return;
      }
    },
    onHostKeyChallenge: ({
      pendingPlan,
      status,
    }: {
      pendingPlan: PendingSavedConnectionPlan;
      status: Extract<HostKeyStatus, { status: 'unknown' } | { status: 'changed' }>;
    }) => {
      setPendingSavedConnectPlan(pendingPlan);
      setConnectHostKeyStatus(status);
    },
  }), [createTab, t, toast]);

  const resetPendingSavedConnectPlan = useCallback(() => {
    const planToCleanup = pendingSavedConnectPlan;
    setPendingSavedConnectPlan(null);
    setConnectHostKeyStatus(null);

    if (planToCleanup) {
      void cleanupSessionTreeConnectPlan(planToCleanup.plan).catch((error) => {
        console.warn('Failed to clean up pending saved connection plan:', error);
      });
    }
  }, [pendingSavedConnectPlan]);

  // Connect action
  const handleConnect = useCallback(async (connectionId: string) => {
    await connectToSaved(connectionId, getConnectToSavedOptions());
  }, [getConnectToSavedOptions]);

  const handleAcceptConnectHostKey = useCallback(async (persist: boolean) => {
    if (!pendingSavedConnectPlan || !connectHostKeyStatus || connectHostKeyStatus.status !== 'unknown') {
      return;
    }

    setConnectHostKeyActionLoading(true);
    try {
      const { currentIndex, steps } = pendingSavedConnectPlan.plan;
      const result = await continueConnectToSavedPlan({
        ...pendingSavedConnectPlan,
        plan: {
          ...pendingSavedConnectPlan.plan,
          steps: steps.map((step, index) => index === currentIndex ? {
            ...step,
            trustHostKey: persist,
            expectedHostKeyFingerprint: connectHostKeyStatus.fingerprint,
          } : step),
        },
      }, getConnectToSavedOptions());

      if (result) {
        setPendingSavedConnectPlan(null);
        setConnectHostKeyStatus(null);
      }
    } finally {
      setConnectHostKeyActionLoading(false);
    }
  }, [connectHostKeyStatus, getConnectToSavedOptions, pendingSavedConnectPlan]);

  const handleRemoveChangedConnectHostKey = useCallback(async () => {
    if (!pendingSavedConnectPlan || !connectHostKeyStatus || connectHostKeyStatus.status !== 'changed') {
      return;
    }

    const currentStep = pendingSavedConnectPlan.plan.steps[pendingSavedConnectPlan.plan.currentIndex];
    setConnectHostKeyActionLoading(true);
    try {
      await api.sshRemoveHostKey({
        host: currentStep.host,
        port: currentStep.port,
        keyType: connectHostKeyStatus.keyType,
        expectedFingerprint: connectHostKeyStatus.expectedFingerprint,
      });

      const result = await continueConnectToSavedPlan(pendingSavedConnectPlan, getConnectToSavedOptions());
      if (result) {
        setPendingSavedConnectPlan(null);
        setConnectHostKeyStatus(null);
      }
    } finally {
      setConnectHostKeyActionLoading(false);
    }
  }, [connectHostKeyStatus, getConnectToSavedOptions, pendingSavedConnectPlan]);

  // Edit action
  const handleEdit = useCallback((connectionId: string) => {
    setEditingConnectionId(connectionId);
  }, []);

  // Duplicate action
  const handleDuplicate = useCallback(async (conn: ConnectionInfo) => {
    try {
      const saved = await api.getSavedConnectionForConnect(conn.id);
      const duplicateName = buildDuplicateConnectionName(
        conn.name,
        allConnections.map(existingConnection => existingConnection.name),
      );
      const saveRequest = buildSaveConnectionRequestFromSaved(conn, saved, {
        id: undefined,
        name: duplicateName,
      });

      setDuplicateDraft({
        connection: {
          ...conn,
          id: `${DUPLICATE_DRAFT_ID_PREFIX}:${conn.id}`,
          name: duplicateName,
          group: saveRequest.group,
          host: saveRequest.host,
          port: saveRequest.port,
          username: saveRequest.username,
          auth_type: saveRequest.auth_type === 'default_key' ? 'key' : saveRequest.auth_type,
          key_path: saveRequest.key_path ?? null,
          cert_path: saveRequest.cert_path ?? null,
          color: saveRequest.color ?? null,
          tags: saveRequest.tags ?? conn.tags,
          agent_forwarding: saveRequest.agent_forwarding,
          post_connect_command: saveRequest.post_connect_command ?? null,
        },
        saveRequest,
      });
    } catch (err) {
      console.error('Failed to duplicate connection:', err);
    }
  }, [allConnections]);

  const handleDuplicateSaved = useCallback(async () => {
    setDuplicateDraft(null);
    toast({
      title: t('sessionManager.toast.connection_duplicated'),
      description: '',
      variant: 'success',
    });
    await refresh();
    notifySavedConnectionsChanged();
  }, [notifySavedConnectionsChanged, refresh, toast, t]);

  // Delete action
  const handleDelete = useCallback(async (conn: ConnectionInfo) => {
    const confirmed = await confirm({
      title: t('sessionManager.actions.confirm_delete', { name: conn.name }),
      confirmLabel: t('sessionManager.actions.delete'),
      variant: 'danger',
    });
    if (!confirmed) {
      return;
    }

    try {
      await api.deleteConnection(conn.id);
      toast({
        title: t('sessionManager.toast.connection_deleted'),
        description: '',
        variant: 'success',
      });
      await refresh();
      notifySavedConnectionsChanged();
    } catch (err) {
      console.error('Failed to delete connection:', err);
    }
  }, [notifySavedConnectionsChanged, refresh, toast, t]);

  // Test connection action
  const runTestConnection = useCallback(async (label: string, request: Parameters<typeof api.testConnection>[0]) => {
    toast({
      title: t('sessionManager.toast.test_in_progress'),
      description: label,
    });
    const result = await api.testConnection(request);
    if (!result.success) {
      const description = result.diagnostic.detail && result.diagnostic.detail !== result.diagnostic.summary
        ? `${result.diagnostic.summary}: ${result.diagnostic.detail}`
        : result.diagnostic.summary;
      toast({
        title: t('sessionManager.toast.test_failed'),
        description,
        variant: 'error',
      });
      return;
    }
    toast({
      title: t('sessionManager.toast.test_success'),
      description: t('sessionManager.toast.test_elapsed', { ms: result.elapsedMs }),
      variant: 'success',
    });
  }, [toast, t]);

  const prepareTestConnection = useCallback(async (label: string, request: Parameters<typeof api.testConnection>[0]) => {
    if (request.proxy_chain?.length) {
      await runTestConnection(label, request);
      return;
    }

    const preflight = await api.sshPreflight({ host: request.host, port: request.port });

    if (preflight.status === 'verified') {
      await runTestConnection(label, request);
      return;
    }

    if (preflight.status === 'unknown') {
      setPendingTestConnection({ label, request });
      setTestHostKeyStatus(preflight);
      return;
    }

    if (preflight.status === 'changed') {
      setPendingTestConnection({ label, request });
      setTestHostKeyStatus(preflight);
      return;
    }

    toast({
      title: t('sessionManager.toast.test_failed'),
      description: preflight.message,
      variant: 'error',
    });
  }, [runTestConnection, t, toast]);

  const handleTestConnection = useCallback(async (conn: ConnectionInfo) => {
    try {
      const savedConn = await api.getSavedConnectionForConnect(conn.id);
      const unsupportedProxyHop = findUnsupportedProxyHopAuth(savedConn.proxy_chain);
      if (unsupportedProxyHop) {
        toast({
          title: t('sessionManager.toast.test_failed'),
          description: unsupportedProxyHop.reason === 'keyboard_interactive'
            ? t('sessionManager.toast.proxy_hop_kbi_unsupported', { hop: unsupportedProxyHop.hopIndex })
            : t('sessionManager.toast.proxy_hop_auth_unsupported', {
              hop: unsupportedProxyHop.hopIndex,
              authType: unsupportedProxyHop.authType,
            }),
          variant: 'error',
        });
        return;
      }

      if (requiresSavedConnectionPasswordPrompt(savedConn)) {
        setConnectPromptAction('test');
        setConnectPromptConnectionId(conn.id);
        return;
      }

      await prepareTestConnection(
        `${conn.username}@${conn.host}:${conn.port}`,
        buildSavedConnectionTestRequest(savedConn),
      );
    } catch (err) {
      toast({
        title: t('sessionManager.toast.test_failed'),
        description: String(err),
        variant: 'error',
      });
    }
  }, [prepareTestConnection, t, toast]);

  const handlePromptTestConnection = useCallback(async ({
    connection,
    authType,
    password,
    keyPath,
    certPath,
    passphrase,
  }: EditConnectionSubmitPayload) => {
    await prepareTestConnection(
      `${connection.username}@${connection.host}:${connection.port}`,
      buildTestConnectionRequest({
        host: connection.host,
        port: connection.port,
        username: connection.username,
        name: connection.name,
        authType,
        password,
        keyPath,
        certPath,
        passphrase,
      }),
    );
  }, [prepareTestConnection]);

  const handleAcceptTestHostKey = useCallback(async (persist: boolean) => {
    if (!pendingTestConnection || !testHostKeyStatus || testHostKeyStatus.status !== 'unknown') {
      return;
    }

    await runTestConnection(pendingTestConnection.label, {
      ...pendingTestConnection.request,
      trust_host_key: persist,
      expected_host_key_fingerprint: testHostKeyStatus.fingerprint,
    });

    setPendingTestConnection(null);
    setTestHostKeyStatus(null);
  }, [pendingTestConnection, runTestConnection, testHostKeyStatus]);

  const handleRemoveChangedHostKey = useCallback(async () => {
    if (!pendingTestConnection || !testHostKeyStatus || testHostKeyStatus.status !== 'changed') {
      return;
    }

    setHostKeyActionLoading(true);
    try {
      await api.sshRemoveHostKey({
        host: pendingTestConnection.request.host,
        port: pendingTestConnection.request.port,
        keyType: testHostKeyStatus.keyType,
        expectedFingerprint: testHostKeyStatus.expectedFingerprint,
      });

      const preflight = await api.sshPreflight({
        host: pendingTestConnection.request.host,
        port: pendingTestConnection.request.port,
      });

      setTestHostKeyStatus(preflight);
    } catch (err) {
      toast({
        title: t('sessionManager.toast.test_failed'),
        description: String(err),
        variant: 'error',
      });
    } finally {
      setHostKeyActionLoading(false);
    }
  }, [pendingTestConnection, testHostKeyStatus, toast, t]);

  // Handle import/export close with refresh
  const handleImportClose = useCallback(async () => {
    setShowImport(false);
    await refresh();
  }, [refresh]);

  const handleOpenCreateGroupDialog = useCallback(() => {
    setNewGroupName('');
    setCreateGroupDialogOpen(true);
  }, []);

  const handleCreateGroupFromTree = useCallback(async () => {
    const trimmedGroupName = newGroupName.trim();
    if (!isValidGroupPath(trimmedGroupName)) {
      return;
    }

    setCreatingGroup(true);
    try {
      await api.createGroup(trimmedGroupName);
      setCreateGroupDialogOpen(false);
      setNewGroupName('');
      await refresh();
      expandPath(trimmedGroupName);
      setSelectedGroup(trimmedGroupName);
      notifySavedConnectionsChanged();
      toast({
        title: t('sessionManager.toast.group_created'),
        description: trimmedGroupName,
        variant: 'success',
      });
    } catch (error) {
      console.error('Failed to create group from Session Manager:', error);
      toast({
        title: t('sessionManager.toast.create_group_failed'),
        description: String(error),
        variant: 'error',
      });
    } finally {
      setCreatingGroup(false);
    }
  }, [expandPath, newGroupName, notifySavedConnectionsChanged, refresh, setSelectedGroup, t, toast]);

  const handleOpenSerialProfile = useCallback(async (profile: SerialProfile) => {
    try {
      const info = await createSerialTerminal({
        portPath: profile.portPath,
        baudRate: profile.baudRate,
        dataBits: profile.dataBits,
        stopBits: profile.stopBits,
        parity: profile.parity,
        flowControl: profile.flowControl,
        cols: 120,
        rows: 40,
      });
      createTab('local_terminal', info.id);
      await api.markSerialProfileUsed(profile.id);
      await refresh();
    } catch (error) {
      toast({
        title: t('sessionManager.serial_profiles.open_failed'),
        description: String(error),
        variant: 'error',
      });
    }
  }, [createSerialTerminal, createTab, refresh, t, toast]);

  const handleDeleteSerialProfile = useCallback(async (profile: SerialProfile) => {
    const confirmed = await confirm({
      title: t('sessionManager.serial_profiles.confirm_delete', { name: profile.name }),
      confirmLabel: t('sessionManager.serial_profiles.delete'),
      variant: 'danger',
    });
    if (!confirmed) {
      return;
    }

    try {
      await api.deleteSerialProfile(profile.id);
      await refresh();
      notifySavedConnectionsChanged();
    } catch (error) {
      toast({
        title: t('sessionManager.serial_profiles.delete_failed'),
        description: String(error),
        variant: 'error',
      });
    }
  }, [confirm, notifySavedConnectionsChanged, refresh, t, toast]);

  return (
    <div className={`h-full w-full flex flex-col text-theme-text ${bgActive ? '' : 'bg-theme-bg'}`} data-bg-active={bgActive || undefined}>
      {/* Toolbar */}
      <ManagerToolbar
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        selectedIds={selectedIds}
        allConnections={allConnections}
        groups={groups}
        onRefresh={refresh}
        onClearSelection={clearSelection}
        onShowImport={() => setShowImport(true)}
        onShowExport={() => setShowExport(true)}
      />

      {/* Content area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Folder Tree */}
        <div className="w-[180px] min-w-[140px] border-r border-theme-border shrink-0 overflow-hidden">
          <FolderTree
            folderTree={folderTree}
            selectedGroup={selectedGroup}
            expandedGroups={expandedGroups}
            totalCount={allConnections.length + allSerialProfiles.length}
            ungroupedCount={ungroupedCount}
            onSelectGroup={setSelectedGroup}
            onToggleExpand={toggleExpand}
            onRequestCreateGroup={handleOpenCreateGroupDialog}
          />
        </div>

        {/* Right: Connection Table */}
        <div className="flex-1 min-w-0 overflow-hidden flex flex-col">
          {loading ? (
            <div className="flex items-center justify-center h-full text-theme-text-muted">
              <div className="animate-pulse">{t('common.loading', { defaultValue: 'Loading...' })}</div>
            </div>
          ) : (
            <>
              <SerialProfileSection
                profiles={serialProfiles}
                onOpen={handleOpenSerialProfile}
                onDelete={handleDeleteSerialProfile}
              />
              <div className="min-h-0 flex-1">
                <ConnectionTable
                  connections={connections}
                  selectedIds={selectedIds}
                  sortField={sortField}
                  sortDirection={sortDirection}
                  onToggleSort={toggleSort}
                  onToggleSelect={toggleSelect}
                  onToggleSelectAll={toggleSelectAll}
                  onConnect={handleConnect}
                  onEdit={handleEdit}
                  onDuplicate={handleDuplicate}
                  onDelete={handleDelete}
                  onTestConnection={handleTestConnection}
                />
              </div>
            </>
          )}
        </div>
      </div>

      {/* Modals */}
      <EditConnectionPropertiesModal
        open={!!editingConnectionId || !!duplicateDraft}
        onOpenChange={(open) => {
          if (!open) {
            setEditingConnectionId(null);
            setDuplicateDraft(null);
          }
        }}
        connection={duplicateDraft?.connection ?? (editingConnectionId ? allConnections.find(c => c.id === editingConnectionId) ?? null : null)}
        duplicateDraft={duplicateDraft}
        onSaved={duplicateDraft ? handleDuplicateSaved : refresh}
      />

      <EditConnectionModal
        open={!!connectPromptConnectionId}
        onOpenChange={(open) => {
          if (!open) {
            setConnectPromptConnectionId(null);
            setConnectPromptAction('connect');
          }
        }}
        connection={connectPromptConnectionId ? allConnections.find(c => c.id === connectPromptConnectionId) ?? null : null}
        action={connectPromptAction}
        onSubmit={connectPromptAction === 'test' ? handlePromptTestConnection : undefined}
        onConnect={connectPromptAction === 'connect' ? refresh : undefined}
      />

      <HostKeyConfirmDialog
        open={!!connectHostKeyStatus && connectHostKeyStatus.status !== 'verified'}
        onClose={resetPendingSavedConnectPlan}
        status={connectHostKeyStatus}
        host={pendingSavedConnectPlan?.plan.steps[pendingSavedConnectPlan.plan.currentIndex]?.host ?? ''}
        port={pendingSavedConnectPlan?.plan.steps[pendingSavedConnectPlan.plan.currentIndex]?.port ?? 22}
        onAccept={handleAcceptConnectHostKey}
        onRemoveSavedKey={handleRemoveChangedConnectHostKey}
        onCancel={resetPendingSavedConnectPlan}
        loading={connectHostKeyActionLoading}
      />

      <HostKeyConfirmDialog
        open={!!testHostKeyStatus && testHostKeyStatus.status !== 'verified'}
        onClose={() => {
          setTestHostKeyStatus(null);
          setPendingTestConnection(null);
        }}
        status={testHostKeyStatus}
        host={pendingTestConnection?.request.host ?? ''}
        port={pendingTestConnection?.request.port ?? 22}
        onAccept={handleAcceptTestHostKey}
        onRemoveSavedKey={handleRemoveChangedHostKey}
        onCancel={() => {
          setTestHostKeyStatus(null);
          setPendingTestConnection(null);
        }}
        loading={hostKeyActionLoading}
      />

      <Dialog
        open={createGroupDialogOpen}
        onOpenChange={(open) => {
          setCreateGroupDialogOpen(open);
          if (!open) {
            setNewGroupName('');
          }
        }}
      >
        <DialogContent className="sm:max-w-[420px] bg-theme-bg-elevated border-theme-border text-theme-text">
          <DialogHeader>
            <DialogTitle>{t('sessionManager.folder_tree.new_group')}</DialogTitle>
            <DialogDescription>
              {t('sessionManager.folder_tree.new_group_description')}
            </DialogDescription>
          </DialogHeader>
          <div className="px-4 py-2 space-y-2">
            <Label htmlFor="session-manager-new-group-name" className="text-theme-text">
              {t('sessionManager.folder_tree.new_group')}
            </Label>
            <Input
              id="session-manager-new-group-name"
              autoFocus
              value={newGroupName}
              onChange={(event) => setNewGroupName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && isValidGroupPath(newGroupName) && !creatingGroup) {
                  event.preventDefault();
                  void handleCreateGroupFromTree();
                }
              }}
              placeholder={t('sessionManager.folder_tree.new_group_placeholder')}
            />
            <div className="rounded-md border border-theme-border/60 bg-theme-bg-sunken/60 px-3 py-2 text-xs text-theme-text-muted">
              <span>{t('sessionManager.folder_tree.new_group_nested_hint')}</span>
              <code className="ml-1 rounded bg-theme-bg px-1.5 py-0.5 font-mono text-[11px] text-theme-text">
                {t('sessionManager.folder_tree.nested_hint_example')}
              </code>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setCreateGroupDialogOpen(false);
                setNewGroupName('');
              }}
              disabled={creatingGroup}
            >
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => void handleCreateGroupFromTree()}
              disabled={!isValidGroupPath(newGroupName) || creatingGroup}
            >
              {creatingGroup ? t('common.loading', { defaultValue: 'Loading...' }) : t('common.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <OxideExportModal
        isOpen={showExport}
        onClose={() => setShowExport(false)}
      />
      <OxideImportModal
        isOpen={showImport}
        onClose={handleImportClose}
      />
      {ConfirmDialog}
    </div>
  );
};
