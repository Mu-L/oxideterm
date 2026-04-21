import {
  createUnavailableTrzszCapabilities,
  isTrzszCapabilitiesAvailable,
  type TrzszCapabilitiesProbeResult,
} from '@/lib/terminal/trzsz/capabilities';
import { notifyTrzszTransferEvent } from '@/lib/terminal/trzsz/notifications';
import { buildTauriFileReaders } from '@/lib/terminal/trzsz/TauriFileReader';
import { createTauriOpenSaveFile } from '@/lib/terminal/trzsz/TauriFileWriter';
import { chooseSaveRoot, chooseSendEntries } from '@/lib/terminal/trzsz/dialogs';
import type { InBandTransferSettings } from '@/store/settingsStore';
import type { TrzszTransferPolicy } from '@/lib/terminal/trzsz/types';
import { TrzszError } from '@/lib/terminal/trzsz/upstream/comm';
import { TrzszFilter } from '@/lib/terminal/trzsz/upstream/filter';
import type { RemoteTerminalTransport } from '@/lib/terminal/trzsz/transport';

type TrzszControllerState = 'active' | 'draining' | 'disposed';

const DEFAULT_TRANSFER_SETTINGS: InBandTransferSettings = {
  enabled: false,
  provider: 'trzsz',
  allowDirectory: true,
  maxChunkBytes: 1024 * 1024,
  maxFileCount: 1024,
  maxTotalBytes: 10 * 1024 * 1024 * 1024,
};

const TRZSZ_CAPABILITIES_API_VERSION = 1;

export type TrzszControllerParams = {
  sessionId: string;
  connectionId: string;
  wsUrl: string;
  ownerId: string;
  isRuntimeCurrent: () => boolean;
  transport: RemoteTerminalTransport;
  writeServerOutput: (output: Uint8Array) => void;
  loadCapabilities: () => Promise<TrzszCapabilitiesProbeResult>;
  cleanupOwner: () => Promise<void>;
  transferSettings?: InBandTransferSettings;
};

function toUint8Array(output: Uint8Array | ArrayBuffer): Uint8Array {
  return output instanceof Uint8Array ? output : new Uint8Array(output);
}

function encodeTextOutput(output: string): Uint8Array {
  return new TextEncoder().encode(output);
}

export class TrzszController {
  private state: TrzszControllerState = 'active';
  private terminalColumns: number | null = null;
  private capabilityRequestVersion = 0;
  private capabilities: TrzszCapabilitiesProbeResult = createUnavailableTrzszCapabilities('invoke-failed');
  private capabilityError: TrzszError | null = null;
  private allowCleanupProtocol = false;
  private readonly filter: TrzszFilter;
  private readonly capabilitiesReady: Promise<void>;
  private transferSettings: InBandTransferSettings;

  readonly sessionId: string;
  readonly connectionId: string;
  readonly wsUrl: string;
  readonly ownerId: string;

  constructor(private readonly params: TrzszControllerParams) {
    this.sessionId = params.sessionId;
    this.connectionId = params.connectionId;
    this.wsUrl = params.wsUrl;
    this.ownerId = params.ownerId;
    this.transferSettings = params.transferSettings ?? DEFAULT_TRANSFER_SETTINGS;
    this.filter = new TrzszFilter({
      writeToTerminal: (output) => {
        if (!this.canProcessIo()) {
          return;
        }

        if (typeof output === 'string') {
          this.params.writeServerOutput(encodeTextOutput(output));
          return;
        }

        if (output instanceof Blob) {
          void output.arrayBuffer().then((buffer) => {
            if (!this.canProcessIo()) {
              return;
            }
            this.params.writeServerOutput(new Uint8Array(buffer));
          });
          return;
        }

        this.params.writeServerOutput(toUint8Array(output));
      },
      sendToServer: (input) => {
        if (!this.canSendCleanupProtocol()) {
          return;
        }

        if (typeof input === 'string') {
          this.params.transport.sendRawInput(input);
          return;
        }

        this.params.transport.sendEncodedPayload(input);
      },
      waitForTransferReady: async () => this.waitForTransferReady(),
      chooseSendFiles: chooseSendEntries,
      buildFileReaders: (paths, directory, policy) => buildTauriFileReaders(this.ownerId, paths, directory, policy),
      chooseSaveDirectory: async () => {
        const saveRoot = await chooseSaveRoot();
        if (!saveRoot) {
          return undefined;
        }

        const prepared = await import('@/lib/api').then(({ api }) => api.trzszPrepareDownloadRoot(this.ownerId, saveRoot.rootPath));
        return {
          ...saveRoot,
          rootPath: prepared.rootPath,
        };
      },
      createOpenSaveFile: (policy) => createTauriOpenSaveFile(this.ownerId, policy),
      getTransferPolicy: () => this.getTransferPolicy(),
      onTransferEvent: (event) => {
        if (!this.params.isRuntimeCurrent() || this.state === 'disposed') {
          return;
        }
        notifyTrzszTransferEvent(event);
      },
      terminalColumns: this.terminalColumns ?? 80,
      isWindowsShell: false,
    });
    this.capabilitiesReady = this.refreshCapabilities();
    void this.capabilitiesReady;
  }

  private getTransferPolicy(): TrzszTransferPolicy {
    return {
      allowDirectory: this.transferSettings.allowDirectory,
      maxChunkBytes: this.transferSettings.maxChunkBytes,
      maxFileCount: this.transferSettings.maxFileCount,
      maxTotalBytes: this.transferSettings.maxTotalBytes,
    };
  }

  private canProcessIo(): boolean {
    return this.state === 'active' && this.params.isRuntimeCurrent();
  }

  private canSendCleanupProtocol(): boolean {
    return this.state === 'active' || this.allowCleanupProtocol;
  }

  private async refreshCapabilities(): Promise<void> {
    const requestVersion = ++this.capabilityRequestVersion;

    try {
      const result = await this.params.loadCapabilities();
      if (this.state === 'disposed' || requestVersion !== this.capabilityRequestVersion) {
        return;
      }
      this.capabilities = result;
      this.capabilityError = this.validateCapabilities(result);
    } catch (error) {
      if (this.state === 'disposed' || requestVersion !== this.capabilityRequestVersion) {
        return;
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      this.capabilities = createUnavailableTrzszCapabilities('invoke-failed', errorMessage);
      this.capabilityError = null;
    }
  }

  private validateCapabilities(result: TrzszCapabilitiesProbeResult): TrzszError | null {
    if (!isTrzszCapabilitiesAvailable(result)) {
      return null;
    }

    if (
      result.capabilities.provider !== 'trzsz'
      || result.capabilities.apiVersion !== TRZSZ_CAPABILITIES_API_VERSION
    ) {
      return new TrzszError(
        `Unsupported trzsz capabilities API version: expected ${TRZSZ_CAPABILITIES_API_VERSION}, received ${result.capabilities.apiVersion}`,
        'invalid_api_version',
      );
    }

    return null;
  }

  private async waitForTransferReady(): Promise<void> {
    await this.capabilitiesReady;
    if (this.capabilityError) {
      throw this.capabilityError;
    }
  }

  matchesRuntime(connectionId: string, wsUrl: string): boolean {
    return this.connectionId === connectionId && this.wsUrl === wsUrl;
  }

  processServerOutput(output: Uint8Array | ArrayBuffer): void {
    if (!this.canProcessIo()) {
      return;
    }

    this.filter.processServerOutput(toUint8Array(output));
  }

  processTerminalInput(input: string): boolean {
    if (!this.canProcessIo()) {
      return false;
    }

    this.filter.processTerminalInput(input);
    return true;
  }

  processBinaryInput(input: string): boolean {
    if (!this.canProcessIo()) {
      return false;
    }

    this.filter.processBinaryInput(input);
    return true;
  }

  sendTextInput(input: string): boolean {
    if (!this.canProcessIo()) {
      return false;
    }

    return this.params.transport.sendTextInput(input);
  }

  sendExecuteInput(input: string): boolean {
    if (!this.canProcessIo()) {
      return false;
    }

    return this.params.transport.sendExecuteInput(input);
  }

  setTerminalColumns(cols: number): void {
    if (!Number.isFinite(cols) || cols <= 0) {
      return;
    }

    this.terminalColumns = Math.floor(cols);
    this.filter.setTerminalColumns(this.terminalColumns);
  }

  getTerminalColumns(): number | null {
    return this.terminalColumns;
  }

  getCapabilities(): TrzszCapabilitiesProbeResult {
    return this.capabilities;
  }

  getTransferSettings(): InBandTransferSettings {
    return this.transferSettings;
  }

  updateTransferSettings(settings: InBandTransferSettings): void {
    this.transferSettings = settings;
  }

  isTransferring(): boolean {
    return this.filter.isTransferringFiles();
  }

  isDraining(): boolean {
    return this.state === 'draining';
  }

  isDisposed(): boolean {
    return this.state === 'disposed';
  }

  stop(): void {
    if (this.state === 'disposed') {
      return;
    }

    this.state = 'draining';
    this.allowCleanupProtocol = true;
    void this.filter.dispose().finally(() => {
      this.allowCleanupProtocol = false;
    });
  }

  dispose(): void {
    if (this.state === 'disposed') {
      return;
    }

    this.state = 'disposed';
    this.capabilityRequestVersion += 1;
    this.allowCleanupProtocol = true;
    void this.filter.dispose()
      .catch(() => {
        // Filter cleanup is best-effort during reconnect or unmount.
      })
      .finally(() => {
        this.allowCleanupProtocol = false;
        void this.params.cleanupOwner().catch(() => {
          if (this.params.isRuntimeCurrent()) {
            notifyTrzszTransferEvent({ type: 'partial_cleanup' });
          }
        });
      });
  }
}