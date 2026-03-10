import { randomUUID } from 'node:crypto';

import type { CreateWorkflowRunRequest } from '../shared/api.ts';
import type { GateRecord, WorkflowRunRecord } from '../shared/workflowRuntime.ts';
import { GateStore } from './gateStore.ts';
import { WorkflowDefinitionService } from './workflowDefinitionService.ts';
import { WorkflowRunStore } from './workflowRunStore.ts';

type Clock = () => string;
type IdGenerator = () => string;

function timestamp() {
  return new Date().toISOString();
}

function createId(prefix: string, generateId: IdGenerator) {
  return `${prefix}_${generateId()}`;
}

export class WorkflowRunService {
  #definitions: WorkflowDefinitionService;
  #runs: WorkflowRunStore;
  #gates: GateStore;
  #clock: Clock;
  #idGenerator: IdGenerator;

  constructor(args: {
    definitions: WorkflowDefinitionService;
    runs: WorkflowRunStore;
    gates: GateStore;
    clock?: Clock;
    idGenerator?: IdGenerator;
  }) {
    this.#definitions = args.definitions;
    this.#runs = args.runs;
    this.#gates = args.gates;
    this.#clock = args.clock ?? timestamp;
    this.#idGenerator = args.idGenerator ?? randomUUID;
  }

  async createRun(request: CreateWorkflowRunRequest): Promise<{
    run: WorkflowRunRecord;
    open_gates: GateRecord[];
  }> {
    const definition = this.#definitions.getDefinition(request.workflow_id);
    if (!definition) {
      throw new Error(`Workflow "${request.workflow_id}" was not found.`);
    }

    const validation = this.#definitions.validateDefinition(request.workflow_id);
    if (!validation?.valid) {
      throw new Error(`Workflow "${request.workflow_id}" is invalid and cannot be run.`);
    }

    const initialState = definition.states.find((state) => state.id === definition.initial_state_id);
    if (!initialState) {
      throw new Error(`Workflow "${request.workflow_id}" is missing its initial state.`);
    }

    const now = this.#clock();
    const runId = createId('run', this.#idGenerator);
    const run: WorkflowRunRecord = {
      id: runId,
      workflow_id: definition.id,
      workflow_version: definition.version,
      status: 'active',
      current_state_id: initialState.id,
      current_state_family: initialState.family,
      repo: {
        repo_id: request.repo_id ?? null,
        repo_path: request.repo_path ?? null,
      },
      goal_prompt: request.goal_prompt,
      open_gate_ids: [],
      last_transition_id: null,
      created_at: now,
      updated_at: now,
      completed_at: null,
      tags: [...new Set(request.tags ?? [])],
      metadata: request.metadata ?? {},
    };

    await this.#runs.saveRun(run);

    const openGates: GateRecord[] = [];
    for (const gateDefinition of definition.gates.filter((gate) => gate.state_id === initialState.id)) {
      const gate: GateRecord = {
        id: createId('gate', this.#idGenerator),
        run_id: run.id,
        workflow_id: run.workflow_id,
        definition_gate_id: gateDefinition.id,
        state_id: gateDefinition.state_id,
        kind: gateDefinition.kind,
        actor: gateDefinition.actor,
        title: gateDefinition.title,
        description: gateDefinition.description,
        status: 'open',
        blocking: gateDefinition.blocking,
        options: gateDefinition.options,
        opened_at: now,
        answered_at: null,
        closed_at: null,
        tags: [],
        metadata: {},
      };
      await this.#gates.saveGate(gate);
      openGates.push(gate);
    }

    const persistedRun: WorkflowRunRecord = {
      ...run,
      open_gate_ids: openGates.map((gate) => gate.id),
      updated_at: this.#clock(),
    };
    await this.#runs.saveRun(persistedRun);

    return {
      run: persistedRun,
      open_gates: openGates,
    };
  }
}
