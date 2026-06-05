// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
  detectPrivilegePrompt,
  findPrivilegeCredentialForPrompt,
  findPrivilegeCredentialsForPrompt,
} from '../lib/privilegePromptHelper';
import type { SavedPrivilegeCredential } from '../types';

describe('detectPrivilegePrompt', () => {
  it('detects sudo prompts with the requested username', () => {
    expect(detectPrivilegePrompt('sudo -k true\n[sudo] password for dominical:')).toEqual({
      kind: 'sudo_password',
      username: 'dominical',
      promptText: '[sudo] password for dominical:',
    });
  });

  it('detects localized sudo prompts with the requested username', () => {
    expect(detectPrivilegePrompt('sudo yazi\n[sudo] deploy 的密码：')).toEqual({
      kind: 'sudo_password',
      username: 'deploy',
      promptText: '[sudo] deploy 的密码：',
    });
  });

  it('detects localized sudo prompts after retry output', () => {
    expect(
      detectPrivilegePrompt(
        'sudo yazi\n[sudo] lipsc 的密码:\n对不起，请重试。\n[sudo] lipsc 的密码:',
      ),
    ).toEqual({
      kind: 'sudo_password',
      username: 'lipsc',
      promptText: '[sudo] lipsc 的密码:',
    });
  });

  it('detects su prompts with explicit su prefix', () => {
    expect(detectPrivilegePrompt('su - root\nsu: Password:')).toEqual({
      kind: 'su_password',
      promptText: 'su: Password:',
    });
  });

  it('detects generic password prompts only after privilege commands', () => {
    expect(detectPrivilegePrompt('su - root\nPassword:')).toEqual({
      kind: 'su_password',
      promptText: 'Password:',
    });
    expect(detectPrivilegePrompt('su - root\n密码：')).toEqual({
      kind: 'su_password',
      promptText: '密码：',
    });
    expect(detectPrivilegePrompt('mysql login\nPassword:')).toBeUndefined();
  });

  it('rejects password result and help lines', () => {
    expect(detectPrivilegePrompt('password changed')).toBeUndefined();
    expect(detectPrivilegePrompt('error: password failed')).toBeUndefined();
    expect(detectPrivilegePrompt('Usage: --password: value')).toBeUndefined();
  });

  it('matches detected prompts to enabled connection credentials', () => {
    const now = new Date().toISOString();
    const credentials: SavedPrivilegeCredential[] = [
      {
        id: 'other-user',
        connection_id: 'conn-1',
        label: 'Other sudo',
        kind: 'sudo_password',
        username_hint: 'root',
        prompt_patterns: [],
        keychain_id: 'secret-1',
        enabled: true,
        require_click_to_send: true,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'current-user',
        connection_id: 'conn-1',
        label: 'Current sudo',
        kind: 'sudo_password',
        username_hint: 'dominical',
        prompt_patterns: [],
        keychain_id: 'secret-2',
        enabled: true,
        require_click_to_send: true,
        created_at: now,
        updated_at: now,
      },
    ];

    expect(
      findPrivilegeCredentialForPrompt('[sudo] password for dominical:', credentials)?.credential.id,
    ).toBe('current-user');
  });

  it('returns every matching credential in stable saved order', () => {
    const now = new Date().toISOString();
    const credentials: SavedPrivilegeCredential[] = [
      {
        id: 'first-sudo',
        connection_id: 'conn-1',
        label: 'First sudo',
        kind: 'sudo_password',
        username_hint: 'dominical',
        prompt_patterns: [],
        keychain_id: 'secret-1',
        enabled: true,
        require_click_to_send: true,
        created_at: now,
        updated_at: now,
      },
      {
        id: 'custom-sudo',
        connection_id: 'conn-1',
        label: 'Custom sudo',
        kind: 'custom_prompt',
        username_hint: null,
        prompt_patterns: ['password for dominical'],
        keychain_id: 'secret-2',
        enabled: true,
        require_click_to_send: true,
        created_at: now,
        updated_at: now,
      },
    ];

    expect(
      findPrivilegeCredentialsForPrompt('[sudo] password for dominical:', credentials)
        .map((match) => match.credential.id),
    ).toEqual(['first-sudo', 'custom-sudo']);
  });
});
