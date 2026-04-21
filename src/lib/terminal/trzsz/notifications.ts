import i18n from '@/i18n';
import { useToastStore, type ToastVariant } from '@/hooks/useToast';
import {
  getTrzszErrorCode,
  getTrzszErrorDetail,
  type TrzszTransferEvent,
} from '@/lib/terminal/trzsz/types';

function formatBinarySize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  const rounded = value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1);
  return `${rounded} ${units[index]}`;
}

function mapErrorToToast(error: unknown): {
  title: string;
  description?: string;
  variant: ToastVariant;
} {
  const code = getTrzszErrorCode(error);
  const detail = getTrzszErrorDetail(error);

  switch (code) {
    case 'invalid_api_version':
    case 'root_mismatch':
    case 'root_not_prepared':
      return {
        title: i18n.t('terminal.trzsz.version_mismatch_title'),
        description: i18n.t('terminal.trzsz.version_mismatch_description'),
        variant: 'error',
      };
    case 'invalid_path':
    case 'unauthorized_path':
    case 'reserved_name':
      return {
        title: i18n.t('terminal.trzsz.path_invalid_title'),
        description: i18n.t('terminal.trzsz.path_invalid_description'),
        variant: 'error',
      };
    case 'symlink_not_allowed':
      return {
        title: i18n.t('terminal.trzsz.symlink_not_supported_title'),
        description: i18n.t('terminal.trzsz.symlink_not_supported_description'),
        variant: 'error',
      };
    case 'already_exists':
      return {
        title: i18n.t('terminal.trzsz.conflict_detected_title'),
        description: i18n.t('terminal.trzsz.conflict_detected_description'),
        variant: 'warning',
      };
    case 'directory_not_allowed':
      return {
        title: i18n.t('terminal.trzsz.directory_not_allowed_title'),
        description: i18n.t('terminal.trzsz.directory_not_allowed_description'),
        variant: 'warning',
      };
    case 'max_file_count_exceeded': {
      const match = detail?.match(/selected=(\d+), max=(\d+)/);
      return {
        title: i18n.t('terminal.trzsz.max_file_count_title'),
        description: i18n.t('terminal.trzsz.max_file_count_description', {
          selected: match?.[1] ?? '?',
          max: match?.[2] ?? '?',
        }),
        variant: 'warning',
      };
    }
    case 'max_total_bytes_exceeded': {
      const match = detail?.match(/(?:selected|received)=(\d+), max=(\d+)/);
      return {
        title: i18n.t('terminal.trzsz.max_total_bytes_title'),
        description: i18n.t('terminal.trzsz.max_total_bytes_description', {
          selected: formatBinarySize(Number(match?.[1] ?? 0)),
          max: formatBinarySize(Number(match?.[2] ?? 0)),
        }),
        variant: 'warning',
      };
    }
    default:
      return {
        title: i18n.t('terminal.trzsz.failed_title'),
        description: i18n.t('terminal.trzsz.failed_description'),
        variant: 'error',
      };
  }
}

export function notifyTrzszTransferEvent(event: TrzszTransferEvent): void {
  const toast = useToastStore.getState().addToast;

  switch (event.type) {
    case 'prompt': {
      if (event.direction === 'upload' && event.selection === 'directory') {
        toast({
          title: i18n.t('terminal.trzsz.select_upload_directory_title'),
          description: i18n.t('terminal.trzsz.select_upload_directory_description'),
          variant: 'default',
        });
        return;
      }

      if (event.direction === 'upload') {
        toast({
          title: i18n.t('terminal.trzsz.select_upload_files_title'),
          description: i18n.t('terminal.trzsz.select_upload_files_description'),
          variant: 'default',
        });
        return;
      }

      toast({
        title: i18n.t('terminal.trzsz.select_download_directory_title'),
        description: i18n.t('terminal.trzsz.select_download_directory_description'),
        variant: 'default',
      });
      return;
    }
    case 'cancelled':
      toast({
        title: i18n.t('terminal.trzsz.cancelled_title'),
        description: i18n.t('terminal.trzsz.cancelled_description'),
        variant: 'warning',
      });
      return;
    case 'completed':
      toast({
        title: i18n.t('terminal.trzsz.completed_title'),
        description: i18n.t('terminal.trzsz.completed_description'),
        variant: 'success',
      });
      return;
    case 'failed': {
      const mapped = mapErrorToToast(event.error);
      toast(mapped);
      return;
    }
    case 'connection_lost':
      toast({
        title: i18n.t('terminal.trzsz.connection_lost_title'),
        description: i18n.t('terminal.trzsz.connection_lost_description'),
        variant: 'warning',
      });
      return;
    case 'partial_cleanup':
      toast({
        title: i18n.t('terminal.trzsz.partial_cleanup_title'),
        description: i18n.t('terminal.trzsz.partial_cleanup_description'),
        variant: 'warning',
      });
  }
}
