// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import type { SavedConnectionForConnect, TestConnectionRequest } from './api';

type ManualTestConnectionInput = {
  host: string;
  port: number;
  username: string;
  name?: string;
  authType: 'password' | 'key' | 'default_key' | 'agent' | 'certificate';
  password?: string | null;
  keyPath?: string | null;
  certPath?: string | null;
  passphrase?: string | null;
};

export function requiresSavedConnectionPasswordPrompt(
  connection: Pick<SavedConnectionForConnect, 'auth_type' | 'password'>,
): boolean {
  return connection.auth_type === 'password' && !connection.password;
}

export function buildTestConnectionRequest(
  input: ManualTestConnectionInput,
): TestConnectionRequest {
  const base = {
    host: input.host,
    port: input.port,
    username: input.username,
    name: input.name,
  };

  switch (input.authType) {
    case 'password': {
      if (!input.password) {
        throw new Error('Password is required for password authentication');
      }
      return {
        ...base,
        auth_type: 'password',
        password: input.password,
      };
    }
    case 'key': {
      if (!input.keyPath) {
        throw new Error('SSH key path is required for key authentication');
      }
      return {
        ...base,
        auth_type: 'key',
        key_path: input.keyPath,
        passphrase: input.passphrase ?? undefined,
      };
    }
    case 'default_key': {
      return {
        ...base,
        auth_type: 'default_key',
        passphrase: input.passphrase ?? undefined,
      };
    }
    case 'certificate': {
      if (!input.keyPath) {
        throw new Error('SSH key path is required for certificate authentication');
      }
      if (!input.certPath) {
        throw new Error('Certificate path is required for certificate authentication');
      }
      return {
        ...base,
        auth_type: 'certificate',
        key_path: input.keyPath,
        cert_path: input.certPath,
        passphrase: input.passphrase ?? undefined,
      };
    }
    case 'agent':
    default:
      return {
        ...base,
        auth_type: 'agent',
      };
  }
}

export function buildSavedConnectionTestRequest(
  connection: SavedConnectionForConnect,
): TestConnectionRequest {
  return buildTestConnectionRequest({
    host: connection.host,
    port: connection.port,
    username: connection.username,
    name: connection.name,
    authType: connection.auth_type === 'key' && !connection.key_path
      ? 'default_key'
      : connection.auth_type,
    password: connection.password,
    keyPath: connection.key_path,
    certPath: connection.cert_path,
    passphrase: connection.passphrase,
  });
}