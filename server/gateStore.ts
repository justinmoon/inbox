import fs from 'node:fs/promises';
import path from 'node:path';

import { gateSchema, type GateRecord } from '../shared/workflowRuntime.ts';

const GATES_FILE = 'workflow-gates.json';

async function readJsonMap<T>(
  filePath: string,
  parser: (input: unknown) => T,
): Promise<Record<string, T>> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    const next: Record<string, T> = {};
    for (const [key, value] of Object.entries(parsed)) {
      try {
        next[key] = parser(value);
      } catch {
        // Ignore invalid persisted records instead of taking the app down.
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

async function writeJsonMap<T>(filePath: string, records: Record<string, T>) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(records, null, 2), 'utf8');
  await fs.rename(tempPath, filePath);
}

export class GateStore {
  #filePath: string;

  constructor(rootDir: string) {
    this.#filePath = path.join(rootDir, GATES_FILE);
  }

  async listByRun(runId: string): Promise<GateRecord[]> {
    const gates = await readJsonMap(this.#filePath, (value) => gateSchema.parse(value));
    return Object.values(gates)
      .filter((gate) => gate.run_id === runId)
      .sort((a, b) => a.opened_at.localeCompare(b.opened_at));
  }

  async saveGate(gate: GateRecord): Promise<GateRecord> {
    const gates = await readJsonMap(this.#filePath, (value) => gateSchema.parse(value));
    gates[gate.id] = gateSchema.parse(gate);
    await writeJsonMap(this.#filePath, gates);
    return gate;
  }

  async clear(): Promise<void> {
    await fs.rm(this.#filePath, { force: true });
  }
}
