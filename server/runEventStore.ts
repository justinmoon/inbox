import fs from 'node:fs/promises';
import path from 'node:path';

import { runEventSchema, type RunEventRecord } from '../shared/workflowRuntime.ts';

const RUN_EVENTS_FILE = 'workflow-run-events.json';

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

export class RunEventStore {
  #filePath: string;

  constructor(rootDir: string) {
    this.#filePath = path.join(rootDir, RUN_EVENTS_FILE);
  }

  async listByRun(runId: string): Promise<RunEventRecord[]> {
    const events = await readJsonMap(this.#filePath, (value) => runEventSchema.parse(value));
    return Object.values(events)
      .filter((event) => event.run_id === runId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async saveEvent(event: RunEventRecord): Promise<RunEventRecord> {
    const events = await readJsonMap(this.#filePath, (value) => runEventSchema.parse(value));
    events[event.id] = runEventSchema.parse(event);
    await writeJsonMap(this.#filePath, events);
    return event;
  }

  async clear(): Promise<void> {
    await fs.rm(this.#filePath, { force: true });
  }
}
