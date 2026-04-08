import type { ForwardType } from '@/types';

export type ForwardFormErrorKey = 'forwards.form.port_required' | 'forwards.form.port_invalid';

type ForwardFormValidationInput = {
  forwardType: ForwardType;
  bindPort: string;
  targetPort: string;
};

type ForwardFormValidationResult = {
  bindPort?: number;
  targetPort?: number;
  errorKey?: ForwardFormErrorKey;
};

function parsePort(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || !/^\d+$/.test(trimmed)) {
    return null;
  }

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535) {
    return null;
  }

  return parsed;
}

function resolvePortErrorKey(value: string): ForwardFormErrorKey {
  return value.trim().length === 0
    ? 'forwards.form.port_required'
    : 'forwards.form.port_invalid';
}

export function validateForwardForm({
  forwardType,
  bindPort,
  targetPort,
}: ForwardFormValidationInput): ForwardFormValidationResult {
  const parsedBindPort = parsePort(bindPort);
  if (parsedBindPort === null) {
    return { errorKey: resolvePortErrorKey(bindPort) };
  }

  if (forwardType === 'dynamic') {
    return { bindPort: parsedBindPort };
  }

  const parsedTargetPort = parsePort(targetPort);
  if (parsedTargetPort === null) {
    return { errorKey: resolvePortErrorKey(targetPort) };
  }

  return {
    bindPort: parsedBindPort,
    targetPort: parsedTargetPort,
  };
}