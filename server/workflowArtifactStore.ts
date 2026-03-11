import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { workflowArtifactSchema, type WorkflowArtifactRecord } from '../shared/workflowRuntime.ts';

const WORKFLOW_ARTIFACTS_FILE = 'workflow-artifacts.json';

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
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(records, null, 2), 'utf8');
  await fs.rename(tempPath, filePath);
}

export class WorkflowArtifactStore {
  #filePath: string;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(rootDir: string) {
    this.#filePath = path.join(rootDir, WORKFLOW_ARTIFACTS_FILE);
  }

  #withWriteLock<T>(operation: () => Promise<T>) {
    const result = this.#writeQueue.then(operation, operation);
    this.#writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async listByRun(runId: string): Promise<WorkflowArtifactRecord[]> {
    const artifacts = await readJsonMap(this.#filePath, (value) => workflowArtifactSchema.parse(value));
    return Object.values(artifacts)
      .filter((artifact) => artifact.run_id === runId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async getArtifact(id: string): Promise<WorkflowArtifactRecord | null> {
    const artifacts = await readJsonMap(this.#filePath, (value) => workflowArtifactSchema.parse(value));
    return artifacts[id] ?? null;
  }

  async saveArtifact(artifact: WorkflowArtifactRecord): Promise<WorkflowArtifactRecord> {
    return await this.#withWriteLock(async () => {
      const artifacts = await readJsonMap(this.#filePath, (value) => workflowArtifactSchema.parse(value));
      artifacts[artifact.id] = workflowArtifactSchema.parse(artifact);
      await writeJsonMap(this.#filePath, artifacts);
      return artifact;
    });
  }

  async clear(): Promise<void> {
    await this.#withWriteLock(async () => {
      await fs.rm(this.#filePath, { force: true });
    });
  }
}
