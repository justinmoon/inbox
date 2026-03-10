import fs from 'node:fs/promises';
import path from 'node:path';

import { workflowRunSchema, type WorkflowRunRecord } from '../shared/workflowRuntime.ts';

const WORKFLOW_RUNS_FILE = 'workflow-runs.json';

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

export class WorkflowRunStore {
  #filePath: string;

  constructor(rootDir: string) {
    this.#filePath = path.join(rootDir, WORKFLOW_RUNS_FILE);
  }

  async listRuns(): Promise<WorkflowRunRecord[]> {
    const runs = await readJsonMap(this.#filePath, (value) => workflowRunSchema.parse(value));
    return Object.values(runs).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async getRun(id: string): Promise<WorkflowRunRecord | null> {
    const runs = await readJsonMap(this.#filePath, (value) => workflowRunSchema.parse(value));
    return runs[id] ?? null;
  }

  async saveRun(run: WorkflowRunRecord): Promise<WorkflowRunRecord> {
    const runs = await readJsonMap(this.#filePath, (value) => workflowRunSchema.parse(value));
    runs[run.id] = workflowRunSchema.parse(run);
    await writeJsonMap(this.#filePath, runs);
    return run;
  }

  async clear(): Promise<void> {
    await fs.rm(this.#filePath, { force: true });
  }
}
