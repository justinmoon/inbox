import { randomUUID } from 'node:crypto';
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
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(records, null, 2), 'utf8');
  await fs.rename(tempPath, filePath);
}

function compareRunEvents(a: RunEventRecord, b: RunEventRecord) {
  if (a.sequence !== b.sequence) {
    return a.sequence - b.sequence;
  }

  const timestampOrder = a.created_at.localeCompare(b.created_at);
  if (timestampOrder !== 0) {
    return timestampOrder;
  }

  return a.id.localeCompare(b.id);
}

export class RunEventStore {
  #filePath: string;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(rootDir: string) {
    this.#filePath = path.join(rootDir, RUN_EVENTS_FILE);
  }

  #withWriteLock<T>(operation: () => Promise<T>) {
    const result = this.#writeQueue.then(operation, operation);
    this.#writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async listByRun(runId: string): Promise<RunEventRecord[]> {
    const events = await readJsonMap(this.#filePath, (value) => runEventSchema.parse(value));
    return Object.values(events)
      .filter((event) => event.run_id === runId)
      .sort(compareRunEvents);
  }

  async saveEvent(event: RunEventRecord): Promise<RunEventRecord> {
    return await this.#withWriteLock(async () => {
      const events = await readJsonMap(this.#filePath, (value) => runEventSchema.parse(value));
      let nextSequence = 0;
      const runEvents = Object.values(events).filter((existingEvent) => existingEvent.run_id === event.run_id);
      if (runEvents.some((existingEvent) => existingEvent.sequence === 0)) {
        for (const existingEvent of [...runEvents].sort((a, b) => {
          const timestampOrder = a.created_at.localeCompare(b.created_at);
          if (timestampOrder !== 0) {
            return timestampOrder;
          }

          return a.id.localeCompare(b.id);
        })) {
          nextSequence += 1;
          events[existingEvent.id] = runEventSchema.parse({
            ...existingEvent,
            sequence: nextSequence,
          });
        }
      } else {
        nextSequence = runEvents.reduce(
          (highestSequence, existingEvent) => Math.max(highestSequence, existingEvent.sequence),
          0,
        );
      }

      const persistedEvent = runEventSchema.parse({
        ...event,
        sequence: event.sequence > 0 ? event.sequence : nextSequence + 1,
      });
      events[persistedEvent.id] = persistedEvent;
      await writeJsonMap(this.#filePath, events);
      return persistedEvent;
    });
  }

  async clear(): Promise<void> {
    await this.#withWriteLock(async () => {
      await fs.rm(this.#filePath, { force: true });
    });
  }
}
