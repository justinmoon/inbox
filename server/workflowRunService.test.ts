import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { GateStore } from './gateStore.ts';
import { WorkflowDefinitionService } from './workflowDefinitionService.ts';
import { WorkflowRunService } from './workflowRunService.ts';
import { WorkflowRunStore } from './workflowRunStore.ts';
import { planImplementReviewWorkflow } from './workflows/planImplementReview.ts';

test('createRun persists the initial workflow run state without opening gates yet', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inbox-workflow-run-test-'));

  try {
    const definitions = new WorkflowDefinitionService([planImplementReviewWorkflow]);
    const runs = new WorkflowRunStore(rootDir);
    const gates = new GateStore(rootDir);
    let nextId = 1;
    const service = new WorkflowRunService({
      definitions,
      runs,
      gates,
      clock: () => '2026-03-10T00:00:00.000Z',
      idGenerator: () => String(nextId++),
    });

    const created = await service.createRun({
      workflow_id: 'plan-implement-review',
      repo_path: '/tmp/example-repo',
      goal_prompt: 'Add the first workflow runtime slice.',
      tags: ['developer'],
      metadata: { trigger: 'test' },
    });

    assert.deepEqual(created.open_gates, []);
    assert.equal(created.run.id, 'run_1');
    assert.equal(created.run.workflow_id, 'plan-implement-review');
    assert.equal(created.run.workflow_version, '0.1.0');
    assert.equal(created.run.current_state_id, 'planning_conversation');
    assert.equal(created.run.current_state_family, 'conversation');
    assert.equal(created.run.repo.repo_path, '/tmp/example-repo');
    assert.equal(created.run.goal_prompt, 'Add the first workflow runtime slice.');
    assert.deepEqual(created.run.open_gate_ids, []);
    assert.deepEqual(created.run.tags, ['developer']);
    assert.deepEqual(created.run.metadata, { trigger: 'test' });

    const persistedRun = await runs.getRun(created.run.id);
    const persistedGates = await gates.listByRun(created.run.id);

    assert.deepEqual(persistedRun, created.run);
    assert.deepEqual(persistedGates, []);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
