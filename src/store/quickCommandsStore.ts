// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import { create } from 'zustand';

const STORAGE_KEY = 'oxide-quick-commands-v1';

export type QuickCommandIcon = 'terminal' | 'server' | 'folder' | 'docker' | 'zap';

export interface QuickCommandCategory {
  id: string;
  name: string;
  icon: QuickCommandIcon;
}

export interface QuickCommand {
  id: string;
  name: string;
  command: string;
  category: string;
  description?: string;
  hostPattern?: string;
  createdAt: number;
  updatedAt: number;
}

type PersistedQuickCommands = {
  categories?: QuickCommandCategory[];
  commands?: QuickCommand[];
};

interface QuickCommandsState {
  categories: QuickCommandCategory[];
  commands: QuickCommand[];
  upsertCommand: (command: QuickCommandDraft) => QuickCommand;
  deleteCommand: (id: string) => void;
  resetDefaults: () => void;
}

export type QuickCommandDraft = Omit<QuickCommand, 'id' | 'createdAt' | 'updatedAt'> & {
  id?: string;
};

export const DEFAULT_QUICK_COMMAND_CATEGORIES: QuickCommandCategory[] = [
  { id: 'system', name: 'System', icon: 'server' },
  { id: 'network', name: 'Network', icon: 'terminal' },
  { id: 'files', name: 'Files', icon: 'folder' },
  { id: 'docker', name: 'Docker', icon: 'docker' },
  { id: 'custom', name: 'Custom', icon: 'zap' },
];

export const DEFAULT_QUICK_COMMANDS: QuickCommand[] = [
  commandSeed('qc-pwd', 'Print Working Directory', 'pwd', 'files', 'Show the current directory.'),
  commandSeed('qc-ls-la', 'List Files', 'ls -la', 'files', 'List files with details.'),
  commandSeed('qc-df-h', 'Disk Usage', 'df -h', 'system', 'Show mounted filesystem usage.'),
  commandSeed('qc-free-h', 'Memory Usage', 'free -h', 'system', 'Show memory usage.'),
  commandSeed('qc-uptime', 'Uptime', 'uptime', 'system', 'Show uptime and load average.'),
  commandSeed('qc-whoami', 'Current User', 'whoami', 'system', 'Show the current user.'),
  commandSeed('qc-ip-addr', 'IP Addresses', 'ip addr', 'network', 'Show network interface addresses.'),
  commandSeed('qc-ifconfig', 'Interface Config', 'ifconfig', 'network', 'Show network interfaces on systems without iproute2.'),
  commandSeed('qc-docker-ps', 'Docker Containers', 'docker ps', 'docker', 'List running containers.'),
  commandSeed('qc-git-status', 'Git Status', 'git status', 'files', 'Show repository status.'),
  commandSeed('qc-journal-errors', 'Recent Journal Errors', 'journalctl -xe --no-pager', 'system', 'Show recent system journal errors.'),
];

function commandSeed(
  id: string,
  name: string,
  command: string,
  category: string,
  description: string,
): QuickCommand {
  return {
    id,
    name,
    command,
    category,
    description,
    createdAt: 0,
    updatedAt: 0,
  };
}

function newId(): string {
  return `qc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadState(): Pick<QuickCommandsState, 'categories' | 'commands'> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {
        categories: DEFAULT_QUICK_COMMAND_CATEGORIES,
        commands: DEFAULT_QUICK_COMMANDS,
      };
    }
    const parsed = JSON.parse(raw) as PersistedQuickCommands;
    const categories = sanitizeCategories(parsed.categories);
    const commands = sanitizeCommands(parsed.commands, categories);
    return { categories, commands };
  } catch {
    return {
      categories: DEFAULT_QUICK_COMMAND_CATEGORIES,
      commands: DEFAULT_QUICK_COMMANDS,
    };
  }
}

function persist(categories: QuickCommandCategory[], commands: QuickCommand[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ categories, commands }));
  } catch {
    // Ignore quota/private-mode failures; the in-memory command list remains usable.
  }
}

function sanitizeCategories(value: unknown): QuickCommandCategory[] {
  if (!Array.isArray(value)) return DEFAULT_QUICK_COMMAND_CATEGORIES;
  const seen = new Set<string>();
  const categories = value
    .filter((category): category is QuickCommandCategory => (
      category
      && typeof category.id === 'string'
      && typeof category.name === 'string'
      && isQuickCommandIcon(category.icon)
    ))
    .filter((category) => {
      if (seen.has(category.id)) return false;
      seen.add(category.id);
      return true;
    });
  return categories.length > 0 ? categories : DEFAULT_QUICK_COMMAND_CATEGORIES;
}

function sanitizeCommands(value: unknown, categories: QuickCommandCategory[]): QuickCommand[] {
  const categoryIds = new Set(categories.map((category) => category.id));
  if (!Array.isArray(value)) return DEFAULT_QUICK_COMMANDS;
  return value
    .filter((command): command is QuickCommand => (
      command
      && typeof command.id === 'string'
      && typeof command.name === 'string'
      && typeof command.command === 'string'
      && typeof command.category === 'string'
      && typeof command.createdAt === 'number'
      && typeof command.updatedAt === 'number'
    ))
    .map((command) => ({
      ...command,
      category: categoryIds.has(command.category) ? command.category : 'custom',
      description: typeof command.description === 'string' ? command.description : undefined,
      hostPattern: typeof command.hostPattern === 'string' ? command.hostPattern : undefined,
    }));
}

function isQuickCommandIcon(value: unknown): value is QuickCommandIcon {
  return value === 'terminal' || value === 'server' || value === 'folder' || value === 'docker' || value === 'zap';
}

export function matchQuickCommandHostPattern(pattern: string | undefined, targetFields: Array<string | null | undefined>): boolean {
  const normalizedPattern = pattern?.trim();
  if (!normalizedPattern) return true;
  const escaped = normalizedPattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const regex = new RegExp(`^${escaped}$`, 'i');
  return targetFields.some((field) => typeof field === 'string' && regex.test(field));
}

export const useQuickCommandsStore = create<QuickCommandsState>((set, get) => ({
  ...loadState(),

  upsertCommand: (draft) => {
    const now = Date.now();
    const existing = draft.id ? get().commands.find((command) => command.id === draft.id) : undefined;
    const command: QuickCommand = {
      id: draft.id ?? newId(),
      name: draft.name.trim(),
      command: draft.command.trim(),
      category: draft.category || 'custom',
      description: draft.description?.trim() || undefined,
      hostPattern: draft.hostPattern?.trim() || undefined,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    set((state) => {
      const commands = existing
        ? state.commands.map((candidate) => candidate.id === command.id ? command : candidate)
        : [...state.commands, command];
      persist(state.categories, commands);
      return { commands };
    });
    return command;
  },

  deleteCommand: (id) => set((state) => {
    const commands = state.commands.filter((command) => command.id !== id);
    persist(state.categories, commands);
    return { commands };
  }),

  resetDefaults: () => {
    persist(DEFAULT_QUICK_COMMAND_CATEGORIES, DEFAULT_QUICK_COMMANDS);
    set({
      categories: DEFAULT_QUICK_COMMAND_CATEGORIES,
      commands: DEFAULT_QUICK_COMMANDS,
    });
  },
}));
