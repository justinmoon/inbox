import { randomUUID } from 'node:crypto';

import type {
  CodexThread,
  CodexThreadItem,
  CreateWorkflowRunRequest,
  EnsureRepositoryResult,
  WorkflowRunDetail,
  WorkflowRunSessionDetail,
} from '../shared/api.ts';
import type {
  AgentSessionRecord,
  GateRecord,
  RunEventRecord,
  WorkflowRunRecord,
} from '../shared/workflowRuntime.ts';
import type { RepositoryRecord, WorkspaceRecord } from '../shared/workspaces.ts';
import { AgentSessionStore } from './agentSessionStore.ts';
import type { CodexClient } from './codexClient.ts';
import { GateStore } from './gateStore.ts';
import { RunEventStore } from './runEventStore.ts';
import { WorkflowDefinitionService } from './workflowDefinitionService.ts';
import { WorkflowRunStore } from './workflowRunStore.ts';
import {
  findWorkflowTransition,
  getWorkflowParserHook,
  getWorkflowPrompt,
  getWorkflowState,
} from './workflows/index.ts';

type Clock = () => string;
type IdGenerator = () => string;

type WorkflowWorkspaceResolver = {
  ensureRepository(request: {
    id?: string;
    source: string;
    tags?: string[];
    metadata?: Record<string, string>;
  }): Promise<EnsureRepositoryResult>;
  getRepository(id: string): Promise<RepositoryRecord | null>;
  getWorkspace(id: string): Promise<WorkspaceRecord | null>;
};

type CodexExecutionOptions = {
  approvalPolicy?: 'on-request' | 'on-failure' | 'never' | 'untrusted';
  sandboxPolicy?: unknown;
  model?: string | null;
};

function timestamp() {
  return new Date().toISOString();
}

function createId(prefix: string, generateId: IdGenerator) {
  return `${prefix}_${generateId()}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function latestAssistantTextForTurn(thread: CodexThread, turnId: string) {
  return (
    thread.turns
      .find((turn) => turn.id === turnId)
      ?.items.findLast(
        (item): item is Extract<CodexThreadItem, { type: 'agentMessage' }> => item.type === 'agentMessage',
      )?.text ?? null
  );
}

function stringMetadata(entries: Record<string, string | null | undefined>) {
  return Object.fromEntries(
    Object.entries(entries).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

export class WorkflowRunService {
  #definitions: WorkflowDefinitionService;
  #runs: WorkflowRunStore;
  #gates: GateStore;
  #sessions: AgentSessionStore;
  #events: RunEventStore;
  #workspaces: WorkflowWorkspaceResolver;
  #codex: CodexClient;
  #clock: Clock;
  #idGenerator: IdGenerator;
  #codexExecution: CodexExecutionOptions;

  constructor(args: {
    definitions: WorkflowDefinitionService;
    runs: WorkflowRunStore;
    gates: GateStore;
    sessions: AgentSessionStore;
    events: RunEventStore;
    workspaces: WorkflowWorkspaceResolver;
    codex: CodexClient;
    codexExecution?: CodexExecutionOptions;
    clock?: Clock;
    idGenerator?: IdGenerator;
  }) {
    this.#definitions = args.definitions;
    this.#runs = args.runs;
    this.#gates = args.gates;
    this.#sessions = args.sessions;
    this.#events = args.events;
    this.#workspaces = args.workspaces;
    this.#codex = args.codex;
    this.#codexExecution = args.codexExecution ?? {};
    this.#clock = args.clock ?? timestamp;
    this.#idGenerator = args.idGenerator ?? randomUUID;
  }

  async createRun(request: CreateWorkflowRunRequest): Promise<WorkflowRunDetail> {
    const definition = this.#loadDefinitionOrThrow(request.workflow_id);
    const initialState = getWorkflowState(definition, definition.initial_state_id);
    if (!initialState) {
      throw new Error(`Workflow "${request.workflow_id}" is missing its initial state.`);
    }

    const repositoryContext = await this.#resolveRepositoryContext(request);
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
        repo_id: repositoryContext.repository.id,
        repo_path: repositoryContext.repository.source,
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
    await this.#recordEvent({
      run,
      type: 'run_created',
      summary: 'Workflow run created in its initial state.',
      state_id: run.current_state_id,
      metadata: stringMetadata({
        repo_id: run.repo.repo_id,
        workspace_id: repositoryContext.workspace.id,
      }),
    });

    await this.#startPlanningConversation({
      run,
      definitionId: definition.id,
      stateId: initialState.id,
      workspace: repositoryContext.workspace,
    });

    const detail = await this.readRunDetail(run.id);
    if (!detail) {
      throw new Error(`Workflow run "${run.id}" could not be reloaded after creation.`);
    }
    return detail;
  }

  async sendPlanningMessage(args: { runId: string; message: string }): Promise<WorkflowRunDetail> {
    const run = await this.#runs.getRun(args.runId);
    if (!run) {
      throw new Error(`Workflow run "${args.runId}" was not found.`);
    }

    if (run.current_state_id !== 'planning_conversation') {
      throw new Error('Planning messages are only allowed while the run is in planning_conversation.');
    }

    const definition = this.#loadDefinitionOrThrow(run.workflow_id);
    const session = await this.#loadPlanningSession(run.id);
    if (!session) {
      throw new Error(`Workflow run "${args.runId}" does not have an active planning session.`);
    }

    const promptId = session.metadata.prompt_id;
    if (!promptId) {
      throw new Error(`Planning session "${session.id}" is missing its prompt_id metadata.`);
    }

    const prompt = getWorkflowPrompt(definition, promptId);
    if (!prompt) {
      throw new Error(`Prompt "${promptId}" for workflow "${definition.id}" was not found.`);
    }

    await this.#codex.resumeThread({
      threadId: session.thread_id,
      ...this.#codexExecution,
      persistExtendedHistory: true,
    });

    const turn = await this.#codex.startTurn({
      threadId: session.thread_id,
      text: args.message,
      cwd: session.cwd,
      ...this.#codexExecution,
    });

    await this.#completePlanningTurn({
      run,
      definitionId: definition.id,
      session,
      promptId: prompt.id,
      turnId: turn.turnId,
      turnSummary: 'Planning message turn completed.',
      eventMetadata: stringMetadata({ message: args.message }),
    });

    const detail = await this.readRunDetail(run.id);
    if (!detail) {
      throw new Error(`Workflow run "${run.id}" could not be reloaded after sending a planning message.`);
    }
    return detail;
  }

  async readRunDetail(runId: string): Promise<WorkflowRunDetail | null> {
    const run = await this.#runs.getRun(runId);
    if (!run) {
      return null;
    }

    const sessions = await this.#sessions.listByRun(runId);
    const openGates = (await this.#gates.listByRun(runId)).filter((gate) => gate.status === 'open');
    const events = await this.#events.listByRun(runId);
    const sessionDetails: WorkflowRunSessionDetail[] = await Promise.all(
      sessions.map(async (session) => {
        try {
          return {
            session,
            thread: await this.#codex.readThread({ threadId: session.thread_id, includeTurns: true }),
            load_error: null,
          };
        } catch (error) {
          return {
            session,
            thread: null,
            load_error: error instanceof Error ? error.message : 'Failed to load workflow session thread.',
          };
        }
      }),
    );

    return {
      run,
      sessions: sessionDetails,
      open_gates: openGates,
      events,
    };
  }

  #loadDefinitionOrThrow(workflowId: string) {
    const definition = this.#definitions.getDefinition(workflowId);
    if (!definition) {
      throw new Error(`Workflow "${workflowId}" was not found.`);
    }

    const validation = this.#definitions.validateDefinition(workflowId);
    if (!validation?.valid) {
      throw new Error(`Workflow "${workflowId}" is invalid and cannot be run.`);
    }

    return definition;
  }

  async #resolveRepositoryContext(request: CreateWorkflowRunRequest) {
    let repository: RepositoryRecord | null = null;

    if (request.repo_path) {
      const ensured = await this.#workspaces.ensureRepository({
        id: request.repo_id,
        source: request.repo_path,
        tags: ['workflow-runtime'],
        metadata: stringMetadata({ workflow_id: request.workflow_id }),
      });
      repository = ensured.repository;
    } else if (request.repo_id) {
      repository = await this.#workspaces.getRepository(request.repo_id);
    }

    if (!repository) {
      throw new Error('Workflow run creation requires a registered repository or repo_path.');
    }

    const workspace = await this.#workspaces.getWorkspace(repository.trunk_workspace_id);
    if (!workspace) {
      throw new Error(`Repository "${repository.id}" is missing its trunk workspace.`);
    }

    return { repository, workspace };
  }

  async #startPlanningConversation(args: {
    run: WorkflowRunRecord;
    definitionId: string;
    stateId: string;
    workspace: WorkspaceRecord;
  }) {
    const definition = this.#loadDefinitionOrThrow(args.definitionId);
    const state = getWorkflowState(definition, args.stateId);
    if (!state) {
      throw new Error(`State "${args.stateId}" was not found in workflow "${args.definitionId}".`);
    }

    const promptId = state.prompt_ids[0] ?? null;
    if (!promptId) {
      throw new Error(`State "${state.id}" does not define a primary prompt.`);
    }

    const prompt = getWorkflowPrompt(definition, promptId);
    if (!prompt) {
      throw new Error(`Prompt "${promptId}" was not found in workflow "${definition.id}".`);
    }

    const thread = await this.#codex.startThread({
      cwd: args.workspace.path,
      ...this.#codexExecution,
      persistExtendedHistory: true,
    });

    const now = this.#clock();
    const session: AgentSessionRecord = {
      id: createId('session', this.#idGenerator),
      run_id: args.run.id,
      workflow_id: args.run.workflow_id,
      backend: 'codex',
      kind: state.id,
      actor: prompt.actor_label,
      state_id: state.id,
      thread_id: thread.threadId,
      workspace_id: args.workspace.id,
      cwd: args.workspace.path,
      latest_turn_id: null,
      status: 'active',
      created_at: now,
      updated_at: now,
      tags: ['workflow-runtime', state.family],
      metadata: stringMetadata({ prompt_id: prompt.id }),
    };

    await this.#sessions.saveSession(session);
    await this.#recordEvent({
      run: args.run,
      type: 'agent_session_started',
      summary: 'Planner conversation session started.',
      state_id: args.run.current_state_id,
      session_id: session.id,
      thread_id: session.thread_id,
      metadata: stringMetadata({
        actor: session.actor,
        workspace_id: args.workspace.id,
        prompt_id: prompt.id,
      }),
    });

    const initialTurn = await this.#codex.startTurn({
      threadId: thread.threadId,
      text: prompt.render({ run: args.run }),
      cwd: args.workspace.path,
      ...this.#codexExecution,
    });

    await this.#completePlanningTurn({
      run: args.run,
      definitionId: definition.id,
      session,
      promptId: prompt.id,
      turnId: initialTurn.turnId,
      turnSummary: 'Initial planning turn completed.',
      eventMetadata: {},
    });
  }

  async #completePlanningTurn(args: {
    run: WorkflowRunRecord;
    definitionId: string;
    session: AgentSessionRecord;
    promptId: string;
    turnId: string;
    turnSummary: string;
    eventMetadata: Record<string, string>;
  }) {
    const completion = await this.#codex.waitForTurnCompletion({
      threadId: args.session.thread_id,
      turnId: args.turnId,
    });
    const thread = await this.#codex.readThread({
      threadId: args.session.thread_id,
      includeTurns: true,
    });

    const updatedSession: AgentSessionRecord = {
      ...args.session,
      latest_turn_id: args.turnId,
      updated_at: this.#clock(),
      status: completion.status === 'completed' ? 'active' : 'failed',
    };
    await this.#sessions.saveSession(updatedSession);

    await this.#recordEvent({
      run: args.run,
      type: 'planner_turn_completed',
      summary: args.turnSummary,
      state_id: args.run.current_state_id,
      session_id: updatedSession.id,
      thread_id: updatedSession.thread_id,
      turn_id: args.turnId,
      metadata: stringMetadata({
        status: completion.status,
        ...args.eventMetadata,
      }),
    });

    if (completion.status !== 'completed') {
      throw new Error(`Planning turn ${args.turnId} finished with status "${completion.status}".`);
    }

    await this.#applyPlanningTurnOutcome({
      run: args.run,
      definitionId: args.definitionId,
      promptId: args.promptId,
      session: updatedSession,
      turnId: args.turnId,
      thread,
    });
  }

  async #applyPlanningTurnOutcome(args: {
    run: WorkflowRunRecord;
    definitionId: string;
    promptId: string;
    session: AgentSessionRecord;
    turnId: string;
    thread: CodexThread;
  }) {
    const definition = this.#loadDefinitionOrThrow(args.definitionId);
    const prompt = getWorkflowPrompt(definition, args.promptId);
    if (!prompt) {
      throw new Error(`Prompt "${args.promptId}" was not found in workflow "${definition.id}".`);
    }

    const latestAssistantText = latestAssistantTextForTurn(args.thread, args.turnId);
    if (!latestAssistantText) {
      await this.#recordEvent({
        run: args.run,
        type: 'planner_output_missing',
        summary: 'Planner turn completed without an assistant message.',
        state_id: args.run.current_state_id,
        session_id: args.session.id,
        thread_id: args.session.thread_id,
        turn_id: args.turnId,
        metadata: {},
      });
      return;
    }

    for (const parserHookId of prompt.parser_hook_ids) {
      const parserHook = getWorkflowParserHook(definition, parserHookId);
      if (!parserHook) {
        continue;
      }

      const parserResult = parserHook.parse(latestAssistantText);
      if (parserResult == null) {
        continue;
      }

      if (!parserHook.transition_event) {
        return;
      }

      const transition = findWorkflowTransition(definition, {
        fromStateId: args.run.current_state_id,
        event: parserHook.transition_event,
      });
      if (!transition) {
        throw new Error(
          `Workflow "${definition.id}" has no transition for event "${parserHook.transition_event}" from state "${args.run.current_state_id}".`,
        );
      }

      const nextState = getWorkflowState(definition, transition.to);
      if (!nextState) {
        throw new Error(`Workflow "${definition.id}" is missing target state "${transition.to}".`);
      }

      const promptCandidate =
        typeof parserResult === 'string'
          ? parserResult
          : isObject(parserResult) && typeof parserResult.prompt_candidate === 'string'
            ? parserResult.prompt_candidate
            : null;

      const openedGates = await this.#openGatesForState({
        run: args.run,
        state: nextState,
        definitionId: definition.id,
        metadata: stringMetadata({
          prompt_candidate: promptCandidate,
          parser_hook_id: parserHook.id,
        }),
      });

      const updatedRun: WorkflowRunRecord = {
        ...args.run,
        current_state_id: nextState.id,
        current_state_family: nextState.family,
        open_gate_ids: openedGates.map((gate) => gate.id),
        last_transition_id: transition.id,
        updated_at: this.#clock(),
      };
      await this.#runs.saveRun(updatedRun);

      await this.#recordEvent({
        run: updatedRun,
        type: 'state_transition',
        summary: `Run transitioned from ${transition.from} to ${transition.to}.`,
        state_id: updatedRun.current_state_id,
        from_state_id: transition.from,
        to_state_id: transition.to,
        transition_id: transition.id,
        session_id: args.session.id,
        thread_id: args.session.thread_id,
        turn_id: args.turnId,
        metadata: stringMetadata({
          parser_hook_id: parserHook.id,
          prompt_candidate: promptCandidate,
        }),
      });

      return;
    }

    await this.#recordEvent({
      run: args.run,
      type: 'planner_marker_not_found',
      summary: 'Planner turn completed without emitting a transition marker.',
      state_id: args.run.current_state_id,
      session_id: args.session.id,
      thread_id: args.session.thread_id,
      turn_id: args.turnId,
      metadata: {},
    });
  }

  async #openGatesForState(args: {
    run: WorkflowRunRecord;
    definitionId: string;
    state: ReturnType<typeof getWorkflowState> extends infer T ? Exclude<T, null> : never;
    metadata: Record<string, string>;
  }) {
    const definition = this.#loadDefinitionOrThrow(args.definitionId);
    const now = this.#clock();
    const gates: GateRecord[] = [];

    for (const gateDefinition of definition.gates.filter((gate) => gate.state_id === args.state.id)) {
      const gate: GateRecord = {
        id: createId('gate', this.#idGenerator),
        run_id: args.run.id,
        workflow_id: args.run.workflow_id,
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
        tags: ['workflow-runtime', args.state.family],
        metadata: args.metadata,
      };

      await this.#gates.saveGate(gate);
      gates.push(gate);
      await this.#recordEvent({
        run: args.run,
        type: 'gate_opened',
        summary: `Gate "${gate.title}" opened for state "${args.state.id}".`,
        state_id: args.state.id,
        session_id: null,
        thread_id: null,
        turn_id: null,
        metadata: stringMetadata({
          gate_id: gate.id,
          definition_gate_id: gate.definition_gate_id,
        }),
      });
    }

    return gates;
  }

  async #loadPlanningSession(runId: string) {
    const sessions = await this.#sessions.listByRun(runId);
    return (
      sessions.find((session) => session.kind === 'planning_conversation' && session.status === 'active') ??
      null
    );
  }

  async #recordEvent(args: {
    run: WorkflowRunRecord;
    type: string;
    summary: string;
    state_id?: string | null;
    from_state_id?: string | null;
    to_state_id?: string | null;
    transition_id?: string | null;
    session_id?: string | null;
    thread_id?: string | null;
    turn_id?: string | null;
    metadata: Record<string, string>;
  }) {
    const event: RunEventRecord = {
      id: createId('event', this.#idGenerator),
      run_id: args.run.id,
      workflow_id: args.run.workflow_id,
      type: args.type,
      summary: args.summary,
      state_id: args.state_id ?? null,
      from_state_id: args.from_state_id ?? null,
      to_state_id: args.to_state_id ?? null,
      transition_id: args.transition_id ?? null,
      session_id: args.session_id ?? null,
      thread_id: args.thread_id ?? null,
      turn_id: args.turn_id ?? null,
      created_at: this.#clock(),
      tags: [],
      metadata: args.metadata,
    };

    await this.#events.saveEvent(event);
    return event;
  }
}
