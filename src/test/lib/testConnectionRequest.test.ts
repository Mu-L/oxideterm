import { describe, expect, it } from 'vitest';

import {
  buildSavedConnectionTestRequest,
  buildTestConnectionRequest,
  requiresSavedConnectionPasswordPrompt,
} from '@/lib/testConnectionRequest';

describe('testConnectionRequest helpers', () => {
  it('detects saved password connections without stored passwords', () => {
    expect(requiresSavedConnectionPasswordPrompt({ auth_type: 'password', password: undefined })).toBe(true);
    expect(requiresSavedConnectionPasswordPrompt({ auth_type: 'key', password: undefined })).toBe(false);
  });

  it('maps saved key auth without key_path to default_key test request', () => {
    expect(buildSavedConnectionTestRequest({
      name: 'Default Key',
      host: 'example.com',
      port: 22,
      username: 'tester',
      auth_type: 'key',
      passphrase: 'secret',
      agent_forwarding: false,
      proxy_chain: [],
    })).toEqual({
      name: 'Default Key',
      host: 'example.com',
      port: 22,
      username: 'tester',
      auth_type: 'default_key',
      passphrase: 'secret',
    });
  });

  it('builds password test requests without nullable fields', () => {
    expect(buildTestConnectionRequest({
      host: 'example.com',
      port: 22,
      username: 'tester',
      authType: 'password',
      password: 'top-secret',
    })).toEqual({
      host: 'example.com',
      port: 22,
      username: 'tester',
      name: undefined,
      auth_type: 'password',
      password: 'top-secret',
    });
  });

  it('rejects key and certificate requests when required paths are missing', () => {
    expect(() => buildTestConnectionRequest({
      host: 'example.com',
      port: 22,
      username: 'tester',
      authType: 'key',
    })).toThrow('SSH key path is required for key authentication');

    expect(() => buildTestConnectionRequest({
      host: 'example.com',
      port: 22,
      username: 'tester',
      authType: 'certificate',
      keyPath: '/tmp/id_ed25519',
    })).toThrow('Certificate path is required for certificate authentication');
  });
});