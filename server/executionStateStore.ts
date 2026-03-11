import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { ChangeUnitExecutionState } from '../shared/api.ts';
import { workspaceSchema } from '../shared/workspaces.ts';

const EXECUTION_STATE_FILE = 'change-unit-executions.json';

type StoredExecutionStates = Record<string, ChangeUnitExecutionState>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseExecutionState(input: unknown): ChangeUnitExecutionState | null {
  if (!isObject(input) || typeof input.status !== 'string') {
    return null;
  }

  switch (input.status) {
    case 'idle':
      return { status: 'idle' };
    case 'launching':
      if (typeof input.action_label !== 'string' || typeof input.started_at !== 'string') {
        return null;
      }
      return {
        status: 'launching',
        action_label: input.action_label,
        started_at: input.started_at,
        message: typeof input.message === 'string' ? input.message : null,
      };
    case 'launched':
      if (
        typeof input.action_label !== 'string' ||
        typeof input.started_at !== 'string' ||
        typeof input.thread_id !== 'string' ||
        typeof input.turn_id !== 'string' ||
        (input.thread_source !== 'forked' && input.thread_source !== 'resumed')
      ) {
        return null;
      }
      return {
        status: 'launched',
        action_label: input.action_label,
        started_at: input.started_at,
        thread_id: input.thread_id,
        turn_id: input.turn_id,
        thread_source: input.thread_source,
        workspace: input.workspace ? workspaceSchema.parse(input.workspace) : null,
        message: typeof input.message === 'string' ? input.message : null,
      };
    case 'failed':
      if (
        typeof input.action_label !== 'string' ||
        typeof input.started_at !== 'string' ||
        typeof input.error_message !== 'string'
      ) {
        return null;
      }
      return {
        status: 'failed',
        action_label: input.action_label,
        started_at: input.started_at,
        error_message: input.error_message,
        message: typeof input.message === 'string' ? input.message : null,
      };
    default:
      return null;
  }
}

async function readJsonFile(filePath: string): Promise<StoredExecutionStates> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isObject(parsed)) {
      return {};
    }

    const next: StoredExecutionStates = {};
    for (const [changeUnitId, value] of Object.entries(parsed)) {
      const state = parseExecutionState(value);
      if (state) {
        next[changeUnitId] = state;
      }
    }
    return next;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

async function writeJsonFile(filePath: string, value: StoredExecutionStates) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tempPath, filePath);
}

export class ExecutionStateStore {
  #filePath: string;

  constructor(rootDir: string) {
    this.#filePath = path.join(rootDir, EXECUTION_STATE_FILE);
  }

  async read(changeUnitId: string): Promise<ChangeUnitExecutionState> {
    const states = await readJsonFile(this.#filePath);
    return states[changeUnitId] ?? { status: 'idle' };
  }

  async write(changeUnitId: string, state: ChangeUnitExecutionState): Promise<ChangeUnitExecutionState> {
    const states = await readJsonFile(this.#filePath);
    states[changeUnitId] = state;
    await writeJsonFile(this.#filePath, states);
    return state;
  }

  async clear(): Promise<void> {
    await fs.rm(this.#filePath, { force: true });
  }
}
