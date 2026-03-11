import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { RunEventRecord } from '../shared/workflowRuntime.ts';
import { RunEventStore } from './runEventStore.ts';

const EVENTS_FILE = 'workflow-run-events.json';

function createEvent(args: {
  id: string;
  runId: string;
  type: string;
  createdAt?: string;
  sequence?: number;
}): RunEventRecord {
  return {
    id: args.id,
    run_id: args.runId,
    workflow_id: 'plan-implement-review',
    sequence: args.sequence ?? 0,
    type: args.type,
    summary: `${args.type} summary`,
    state_id: 'artifact_forking',
    from_state_id: null,
    to_state_id: null,
    transition_id: null,
    session_id: null,
    thread_id: null,
    turn_id: null,
    created_at: args.createdAt ?? '2026-03-11T00:00:00.000Z',
    tags: ['workflow-runtime'],
    metadata: {},
  };
}

test('saveEvent assigns unique monotonic sequences for concurrent same-run writes', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inbox-run-events-test-'));
  const store = new RunEventStore(rootDir);

  try {
    const [first, second, third, otherRun] = await Promise.all([
      store.saveEvent(
        createEvent({
          id: 'event_1',
          runId: 'run_1',
          type: 'tutorial_worker_turn_completed',
        }),
      ),
      store.saveEvent(
        createEvent({
          id: 'event_2',
          runId: 'run_1',
          type: 'tutorial_artifact_persisted',
        }),
      ),
      store.saveEvent(
        createEvent({
          id: 'event_3',
          runId: 'run_1',
          type: 'next_prompt_artifact_persisted',
        }),
      ),
      store.saveEvent(
        createEvent({
          id: 'event_4',
          runId: 'run_2',
          type: 'run_created',
        }),
      ),
    ]);

    assert.deepEqual([first.sequence, second.sequence, third.sequence], [1, 2, 3]);
    assert.equal(otherRun.sequence, 1);

    const runEvents = await store.listByRun('run_1');
    assert.deepEqual(
      runEvents.map((event) => [event.id, event.sequence]),
      [
        ['event_1', 1],
        ['event_2', 2],
        ['event_3', 3],
      ],
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('saveEvent backfills legacy same-run events without sequences before appending new ones', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inbox-run-events-test-'));
  const store = new RunEventStore(rootDir);

  try {
    const filePath = path.join(rootDir, EVENTS_FILE);
    await fs.writeFile(
      filePath,
      JSON.stringify(
        {
          event_b: {
            ...createEvent({
              id: 'event_b',
              runId: 'run_1',
              type: 'gate_opened',
              createdAt: '2026-03-11T00:01:00.000Z',
            }),
            sequence: undefined,
          },
          event_a: {
            ...createEvent({
              id: 'event_a',
              runId: 'run_1',
              type: 'state_transition',
              createdAt: '2026-03-11T00:00:00.000Z',
            }),
            sequence: undefined,
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const persisted = await store.saveEvent(
      createEvent({
        id: 'event_c',
        runId: 'run_1',
        type: 'tutorial_artifact_persisted',
        createdAt: '2026-03-11T00:00:00.000Z',
      }),
    );

    assert.equal(persisted.sequence, 3);

    const runEvents = await store.listByRun('run_1');
    assert.deepEqual(
      runEvents.map((event) => [event.id, event.sequence]),
      [
        ['event_a', 1],
        ['event_b', 2],
        ['event_c', 3],
      ],
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
