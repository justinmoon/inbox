import { randomUUID } from 'node:crypto';

import type {
  CodexThread,
  CodexThreadItem,
  CreateWorkspaceResult,
  CreateWorkflowRunRequest,
  EnsureRepositoryResult,
  WorkflowRunDetail,
  WorkflowRunSessionDetail,
} from '../shared/api.ts';
import type {
  AgentSessionRecord,
  AgentTurnStatus,
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
  createWorkspace(request:
    | {
        repo_id: string;
        name_hint?: string;
        tags?: string[];
        metadata?: Record<string, string>;
      }
    | {
        source_workspace_id: string;
        name_hint?: string;
        tags?: string[];
        metadata?: Record<string, string>;
      }): Promise<CreateWorkspaceResult>;
};

type CodexExecutionOptions = {
  approvalPolicy?: 'on-request' | 'on-failure' | 'never' | 'untrusted';
  sandboxPolicy?: unknown;
  model?: string | null;
};

export type WorkflowRunUpdate = {
  run_id: string;
  event: RunEventRecord;
};

type WorkflowRunUpdateListener = (update: WorkflowRunUpdate) => void;

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

function normalizeTurnStatus(status: string): AgentTurnStatus {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'interrupted':
      return 'interrupted';
    default:
      return 'running';
  }
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
  #turnTasks = new Map<string, Promise<void>>();
  #listeners = new Set<WorkflowRunUpdateListener>();

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

  subscribe(listener: WorkflowRunUpdateListener) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async listRuns() {
    return await this.#runs.listRuns();
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

    const promptId = initialState.prompt_ids[0] ?? null;
    if (!promptId) {
      throw new Error(`State "${initialState.id}" does not define a primary prompt.`);
    }
    const prompt = getWorkflowPrompt(definition, promptId);
    if (!prompt) {
      throw new Error(`Prompt "${promptId}" was not found in workflow "${definition.id}".`);
    }

    const session = await this.#createPlanningSession({
      run,
      definitionId: definition.id,
      stateId: initialState.id,
      workspace: repositoryContext.workspace,
    });

    if (session) {
      await this.#startPlanningTurn({
        runId: run.id,
        sessionId: session.id,
        promptId: prompt.id,
        text: prompt.render({ run }),
        source: 'initial_prompt',
        shouldResumeThread: false,
      });
    }

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

    if (run.current_state_id !== 'planning_conversation' || run.status !== 'active') {
      throw new Error('Planning messages are only allowed while the run is active in planning_conversation.');
    }

    const session = await this.#loadPlanningSession(run.id);
    if (!session) {
      throw new Error(`Workflow run "${args.runId}" does not have an active planning session.`);
    }

    const promptId = session.metadata.prompt_id;
    if (!promptId) {
      throw new Error(`Planning session "${session.id}" is missing its prompt_id metadata.`);
    }

    if (session.active_turn_id) {
      const steered = await this.#steerPlanningTurn({
        runId: run.id,
        session,
        message: args.message,
      });
      if (!steered) {
        await this.#startPlanningTurn({
          runId: run.id,
          sessionId: session.id,
          promptId,
          text: args.message,
          source: 'user_message',
          shouldResumeThread: true,
          messageMetadata: stringMetadata({ message: args.message }),
        });
      }
    } else {
      await this.#startPlanningTurn({
        runId: run.id,
        sessionId: session.id,
        promptId,
        text: args.message,
        source: 'user_message',
        shouldResumeThread: true,
        messageMetadata: stringMetadata({ message: args.message }),
      });
    }

    const detail = await this.readRunDetail(run.id);
    if (!detail) {
      throw new Error(`Workflow run "${run.id}" could not be reloaded after sending a planning message.`);
    }
    return detail;
  }

  async answerGate(args: {
    runId: string;
    gateId: string;
    optionId: string;
    message?: string;
  }): Promise<WorkflowRunDetail> {
    const gate = await this.#gates.getGate(args.gateId);
    if (!gate || gate.run_id !== args.runId) {
      throw new Error(`Workflow gate "${args.gateId}" was not found for run "${args.runId}".`);
    }

    if (gate.status !== 'open') {
      throw new Error(`Workflow gate "${args.gateId}" is not open.`);
    }

    const run = await this.#requireRun(args.runId);
    if (run.current_state_id !== gate.state_id || run.status !== 'active') {
      throw new Error(`Workflow run "${args.runId}" is not currently waiting on gate "${args.gateId}".`);
    }

    const definition = this.#loadDefinitionOrThrow(run.workflow_id);
    const option = gate.options.find((entry) => entry.id === args.optionId) ?? null;
    if (!option) {
      throw new Error(`Gate "${gate.id}" does not define option "${args.optionId}".`);
    }

    const transition = definition.transitions.find((entry) => entry.id === option.transition_id) ?? null;
    if (!transition) {
      throw new Error(`Transition "${option.transition_id}" for gate "${gate.id}" was not found.`);
    }

    const nextState = getWorkflowState(definition, transition.to);
    if (!nextState) {
      throw new Error(`Workflow "${definition.id}" is missing target state "${transition.to}".`);
    }

    if (nextState.family === 'conversation' && !(args.message && args.message.trim())) {
      throw new Error(`Gate option "${args.optionId}" requires a follow-up message for the planner.`);
    }

    if (nextState.id === 'implementing' && !(gate.metadata.prompt_candidate?.trim())) {
      throw new Error(`Gate "${gate.id}" is missing the approved prompt candidate required to launch implementing.`);
    }

    await this.#answerGateRecord({
      run,
      gate,
      optionId: option.id,
      message: args.message ?? null,
    });

    const transitionResult = await this.#transitionRun({
      run,
      transition,
      metadata: stringMetadata({
        gate_id: gate.id,
        gate_option_id: option.id,
      }),
      gateMetadata:
        transition.to === 'first_prompt_approval'
          ? stringMetadata({
              prompt_candidate: gate.metadata.prompt_candidate ?? null,
              parser_hook_id: gate.metadata.parser_hook_id ?? null,
            })
          : {},
    });

    if (nextState.family === 'conversation') {
      const detail = await this.sendPlanningMessage({
        runId: run.id,
        message: args.message!.trim(),
      });
      return detail;
    }

    if (nextState.id === 'implementing') {
      await this.#launchImplementer({
        run: transitionResult.run,
        promptCandidate: gate.metadata.prompt_candidate ?? null,
        sourceGate: gate,
        selectedOptionId: option.id,
      });
    }

    const detail = await this.readRunDetail(run.id);
    if (!detail) {
      throw new Error(`Workflow run "${run.id}" could not be reloaded after answering gate "${gate.id}".`);
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

  async #createPlanningSession(args: {
    run: WorkflowRunRecord;
    definitionId: string;
    stateId: string;
    workspace: WorkspaceRecord;
  }): Promise<AgentSessionRecord | null> {
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

    try {
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
        active_turn_id: null,
        active_turn_started_at: null,
        latest_turn_id: null,
        latest_turn_completed_at: null,
        last_turn_status: null,
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

      return session;
    } catch (error) {
      await this.#transitionRunToFailed({
        runId: args.run.id,
        eventType: 'planner_startup_failed',
        summary: 'Planner conversation session failed to start.',
        error,
      });
      return null;
    }
  }

  async #startPlanningTurn(args: {
    runId: string;
    sessionId: string;
    promptId: string;
    text: string;
    source: 'initial_prompt' | 'user_message';
    shouldResumeThread: boolean;
    messageMetadata?: Record<string, string>;
  }) {
    if (!args.promptId) {
      throw new Error('Planning turns require a prompt id from the workflow definition.');
    }

    const run = await this.#runs.getRun(args.runId);
    if (!run) {
      throw new Error(`Workflow run "${args.runId}" was not found.`);
    }

    const session = await this.#sessions.getSession(args.sessionId);
    if (!session) {
      throw new Error(`Workflow session "${args.sessionId}" was not found.`);
    }

    if (run.current_state_id !== 'planning_conversation' || run.status !== 'active') {
      return null;
    }

    try {
      if (args.shouldResumeThread) {
        await this.#codex.resumeThread({
          threadId: session.thread_id,
          ...this.#codexExecution,
          persistExtendedHistory: true,
        });
      }

      const turn = await this.#codex.startTurn({
        threadId: session.thread_id,
        text: args.text,
        cwd: session.cwd,
        ...this.#codexExecution,
      });

      const updatedSession: AgentSessionRecord = {
        ...session,
        active_turn_id: turn.turnId,
        active_turn_started_at: this.#clock(),
        updated_at: this.#clock(),
      };
      await this.#sessions.saveSession(updatedSession);

      await this.#recordEvent({
        run,
        type: 'planner_turn_started',
        summary:
          args.source === 'initial_prompt'
            ? 'Initial planning turn started.'
            : 'Planning message turn started.',
        state_id: run.current_state_id,
        session_id: updatedSession.id,
        thread_id: updatedSession.thread_id,
        turn_id: turn.turnId,
        metadata: stringMetadata({
          prompt_id: args.promptId,
          source: args.source,
          ...args.messageMetadata,
        }),
      });

      this.#schedulePlanningTurnWatcher({
        runId: run.id,
        sessionId: updatedSession.id,
        promptId: args.promptId,
        turnId: turn.turnId,
      });

      return updatedSession;
    } catch (error) {
      await this.#transitionRunToFailed({
        runId: run.id,
        sessionId: session.id,
        threadId: session.thread_id,
        eventType: 'planner_turn_failed',
        summary:
          args.source === 'initial_prompt'
            ? 'Initial planning turn failed to start.'
            : 'Planning message turn failed to start.',
        error,
      });
      return null;
    }
  }

  async #steerPlanningTurn(args: {
    runId: string;
    session: AgentSessionRecord;
    message: string;
  }): Promise<boolean> {
    if (!args.session.active_turn_id) {
      return false;
    }

    try {
      await this.#codex.steerTurn({
        threadId: args.session.thread_id,
        turnId: args.session.active_turn_id,
        text: args.message,
      });

      const run = await this.#runs.getRun(args.runId);
      if (!run) {
        return true;
      }

      const refreshedSession = await this.#sessions.getSession(args.session.id);
      if (!refreshedSession) {
        return true;
      }

      await this.#recordEvent({
        run,
        type: 'planner_turn_steered',
        summary: 'Planning message appended to the active planner turn.',
        state_id: run.current_state_id,
        session_id: refreshedSession.id,
        thread_id: refreshedSession.thread_id,
        turn_id: refreshedSession.active_turn_id,
        metadata: stringMetadata({ message: args.message }),
      });

      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to steer the active planner turn.';
      if (/expectedturnid|no active turn|invalid request/i.test(message)) {
        return false;
      }

      await this.#transitionRunToFailed({
        runId: args.runId,
        sessionId: args.session.id,
        threadId: args.session.thread_id,
        turnId: args.session.active_turn_id,
        eventType: 'planner_turn_failed',
        summary: 'Planning message failed while steering the active planner turn.',
        error,
      });
      return true;
    }
  }

  #schedulePlanningTurnWatcher(args: {
    runId: string;
    sessionId: string;
    promptId: string;
    turnId: string;
  }) {
    const key = `${args.sessionId}:${args.turnId}`;
    if (this.#turnTasks.has(key)) {
      return;
    }

    const task = this.#waitForPlanningTurnCompletion(args)
      .catch(async (error) => {
        await this.#transitionRunToFailed({
          runId: args.runId,
          sessionId: args.sessionId,
          turnId: args.turnId,
          eventType: 'planner_turn_failed',
          summary: 'Planner turn execution failed after starting.',
          error,
        });
      })
      .finally(() => {
        this.#turnTasks.delete(key);
      });

    this.#turnTasks.set(key, task);
  }

  async #waitForPlanningTurnCompletion(args: {
    runId: string;
    sessionId: string;
    promptId: string;
    turnId: string;
  }) {
    const completion = await this.#codex.waitForTurnCompletion({
      threadId: (await this.#requireSession(args.sessionId)).thread_id,
      turnId: args.turnId,
    });

    const session = await this.#requireSession(args.sessionId);
    const run = await this.#requireRun(args.runId);
    const completedAt = this.#clock();
    const updatedSession: AgentSessionRecord = {
      ...session,
      active_turn_id: session.active_turn_id === args.turnId ? null : session.active_turn_id,
      active_turn_started_at: session.active_turn_id === args.turnId ? null : session.active_turn_started_at,
      latest_turn_id: args.turnId,
      latest_turn_completed_at: completedAt,
      last_turn_status: normalizeTurnStatus(completion.status),
      status: completion.status === 'completed' ? 'active' : 'failed',
      updated_at: completedAt,
    };
    await this.#sessions.saveSession(updatedSession);

    if (completion.status !== 'completed') {
      await this.#recordEvent({
        run,
        type: 'planner_turn_failed',
        summary: `Planner turn finished with status "${completion.status}".`,
        state_id: run.current_state_id,
        session_id: updatedSession.id,
        thread_id: updatedSession.thread_id,
        turn_id: args.turnId,
        metadata: stringMetadata({ status: completion.status }),
      });

      await this.#transitionRunToFailed({
        runId: run.id,
        sessionId: updatedSession.id,
        threadId: updatedSession.thread_id,
        turnId: args.turnId,
        eventType: 'planner_runtime_failed',
        summary: `Planner turn completed with status "${completion.status}".`,
        error: new Error(`Planning turn ${args.turnId} finished with status "${completion.status}".`),
      });
      return;
    }

    await this.#recordEvent({
      run,
      type: 'planner_turn_completed',
      summary: 'Planner turn completed.',
      state_id: run.current_state_id,
      session_id: updatedSession.id,
      thread_id: updatedSession.thread_id,
      turn_id: args.turnId,
      metadata: stringMetadata({ status: completion.status }),
    });

    const thread = await this.#codex.readThread({
      threadId: updatedSession.thread_id,
      includeTurns: true,
    });

    await this.#applyPlanningTurnOutcome({
      runId: run.id,
      sessionId: updatedSession.id,
      definitionId: run.workflow_id,
      promptId: args.promptId,
      turnId: args.turnId,
      thread,
    });
  }

  async #applyPlanningTurnOutcome(args: {
    runId: string;
    sessionId: string;
    definitionId: string;
    promptId: string;
    turnId: string;
    thread: CodexThread;
  }) {
    const run = await this.#requireRun(args.runId);
    const session = await this.#requireSession(args.sessionId);
    const definition = this.#loadDefinitionOrThrow(args.definitionId);
    const prompt = getWorkflowPrompt(definition, args.promptId);
    if (!prompt) {
      throw new Error(`Prompt "${args.promptId}" was not found in workflow "${definition.id}".`);
    }

    const latestAssistantText = latestAssistantTextForTurn(args.thread, args.turnId);
    if (!latestAssistantText) {
      await this.#recordEvent({
        run,
        type: 'planner_output_missing',
        summary: 'Planner turn completed without an assistant message.',
        state_id: run.current_state_id,
        session_id: session.id,
        thread_id: session.thread_id,
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

      const promptCandidate =
        typeof parserResult === 'string'
          ? parserResult
          : isObject(parserResult) && typeof parserResult.prompt_candidate === 'string'
            ? parserResult.prompt_candidate
            : null;

      await this.#recordEvent({
        run,
        type: 'planner_marker_detected',
        summary: `Planner emitted marker output for parser hook "${parserHook.id}".`,
        state_id: run.current_state_id,
        session_id: session.id,
        thread_id: session.thread_id,
        turn_id: args.turnId,
        metadata: stringMetadata({
          parser_hook_id: parserHook.id,
          prompt_candidate: promptCandidate,
        }),
      });

      if (!parserHook.transition_event) {
        return;
      }

      const transition = findWorkflowTransition(definition, {
        fromStateId: run.current_state_id,
        event: parserHook.transition_event,
      });
      if (!transition) {
        throw new Error(
          `Workflow "${definition.id}" has no transition for event "${parserHook.transition_event}" from state "${run.current_state_id}".`,
        );
      }

      const nextState = getWorkflowState(definition, transition.to);
      if (!nextState) {
        throw new Error(`Workflow "${definition.id}" is missing target state "${transition.to}".`);
      }

      await this.#transitionRun({
        run,
        transition,
        sessionId: session.id,
        threadId: session.thread_id,
        turnId: args.turnId,
        metadata: stringMetadata({
          prompt_candidate: promptCandidate,
          parser_hook_id: parserHook.id,
        }),
        gateMetadata: stringMetadata({
          parser_hook_id: parserHook.id,
          prompt_candidate: promptCandidate,
        }),
      });

      return;
    }

    await this.#recordEvent({
      run,
      type: 'planner_marker_not_found',
      summary: 'Planner turn completed without emitting a transition marker.',
      state_id: run.current_state_id,
      session_id: session.id,
      thread_id: session.thread_id,
      turn_id: args.turnId,
      metadata: {},
    });
  }

  async #answerGateRecord(args: {
    run: WorkflowRunRecord;
    gate: GateRecord;
    optionId: string;
    message: string | null;
  }) {
    const now = this.#clock();
    const relatedGates = (await this.#gates.listByRun(args.run.id)).filter(
      (gate) => gate.state_id === args.gate.state_id && gate.status === 'open',
    );

    const answeredGate: GateRecord = {
      ...args.gate,
      status: 'answered',
      answered_at: now,
      closed_at: now,
      metadata: {
        ...args.gate.metadata,
        ...stringMetadata({
          selected_option_id: args.optionId,
          answer_message: args.message,
        }),
      },
    };
    await this.#gates.saveGate(answeredGate);

    await this.#recordEvent({
      run: args.run,
      type: 'gate_answered',
      summary: `Gate "${answeredGate.title}" answered with option "${args.optionId}".`,
      state_id: args.run.current_state_id,
      metadata: stringMetadata({
        gate_id: answeredGate.id,
        selected_option_id: args.optionId,
      }),
    });

    for (const gate of relatedGates) {
      if (gate.id === answeredGate.id) {
        continue;
      }

      const dismissedGate: GateRecord = {
        ...gate,
        status: 'dismissed',
        closed_at: now,
      };
      await this.#gates.saveGate(dismissedGate);

      await this.#recordEvent({
        run: args.run,
        type: 'gate_dismissed',
        summary: `Gate "${dismissedGate.title}" was dismissed when state advanced.`,
        state_id: args.run.current_state_id,
        metadata: stringMetadata({ gate_id: dismissedGate.id }),
      });
    }

    return answeredGate;
  }

  async #transitionRun(args: {
    run: WorkflowRunRecord;
    transition: { id: string; from: string; to: string; title: string; description: string };
    metadata: Record<string, string>;
    gateMetadata: Record<string, string>;
    sessionId?: string | null;
    threadId?: string | null;
    turnId?: string | null;
  }) {
    if (args.run.current_state_id !== args.transition.from) {
      throw new Error(
        `Workflow run "${args.run.id}" is in "${args.run.current_state_id}" but transition "${args.transition.id}" starts at "${args.transition.from}".`,
      );
    }

    const definition = this.#loadDefinitionOrThrow(args.run.workflow_id);
    const nextState = getWorkflowState(definition, args.transition.to);
    if (!nextState) {
      throw new Error(`Workflow "${definition.id}" is missing target state "${args.transition.to}".`);
    }

    const openedGates = await this.#createGatesForState({
      run: args.run,
      state: nextState,
      metadata: args.gateMetadata,
    });

    const completedAt = nextState.terminal ? this.#clock() : args.run.completed_at;
    const updatedRun: WorkflowRunRecord = {
      ...args.run,
      status:
        nextState.id === 'failed'
          ? 'failed'
          : nextState.terminal
            ? 'completed'
            : 'active',
      current_state_id: nextState.id,
      current_state_family: nextState.family,
      open_gate_ids: openedGates.map((gate) => gate.id),
      last_transition_id: args.transition.id,
      updated_at: this.#clock(),
      completed_at: completedAt,
    };
    await this.#runs.saveRun(updatedRun);

    await this.#recordEvent({
      run: updatedRun,
      type: 'state_transition',
      summary: `Run transitioned from ${args.transition.from} to ${args.transition.to}.`,
      state_id: updatedRun.current_state_id,
      from_state_id: args.transition.from,
      to_state_id: args.transition.to,
      transition_id: args.transition.id,
      session_id: args.sessionId ?? null,
      thread_id: args.threadId ?? null,
      turn_id: args.turnId ?? null,
      metadata: args.metadata,
    });

    for (const gate of openedGates) {
      await this.#recordEvent({
        run: updatedRun,
        type: 'gate_opened',
        summary: `Gate "${gate.title}" opened for state "${nextState.id}".`,
        state_id: nextState.id,
        metadata: stringMetadata({
          gate_id: gate.id,
          definition_gate_id: gate.definition_gate_id,
        }),
      });
    }

    return {
      run: updatedRun,
      nextState,
      gates: openedGates,
    };
  }

  async #launchImplementer(args: {
    run: WorkflowRunRecord;
    promptCandidate: string | null;
    sourceGate: GateRecord;
    selectedOptionId: string;
  }) {
    const promptCandidate = args.promptCandidate?.trim() ?? null;
    if (!promptCandidate) {
      throw new Error(`Gate "${args.sourceGate.id}" does not contain an approved prompt candidate.`);
    }

    const planningSession = await this.#loadPlanningSession(args.run.id);
    if (!planningSession?.workspace_id && !args.run.repo.repo_id) {
      throw new Error(`Workflow run "${args.run.id}" is missing workspace context for the implementer.`);
    }

    let session: AgentSessionRecord | null = null;
    let threadId: string | null = null;

    try {
      const workspaceResult = planningSession?.workspace_id
        ? await this.#workspaces.createWorkspace({
            source_workspace_id: planningSession.workspace_id,
            name_hint: `implementer-${args.run.id}`,
            tags: ['workflow-runtime', 'implementer'],
            metadata: stringMetadata({
              run_id: args.run.id,
              workflow_id: args.run.workflow_id,
            }),
          })
        : await this.#workspaces.createWorkspace({
            repo_id: args.run.repo.repo_id!,
            name_hint: `implementer-${args.run.id}`,
            tags: ['workflow-runtime', 'implementer'],
            metadata: stringMetadata({
              run_id: args.run.id,
              workflow_id: args.run.workflow_id,
            }),
          });

      await this.#recordEvent({
        run: args.run,
        type: 'implementer_workspace_created',
        summary: 'Implementer workspace created from the approved first prompt.',
        state_id: args.run.current_state_id,
        metadata: stringMetadata({
          workspace_id: workspaceResult.workspace.id,
          repo_id: workspaceResult.repository.id,
        }),
      });

      const thread = await this.#codex.startThread({
        cwd: workspaceResult.workspace.path,
        ...this.#codexExecution,
        persistExtendedHistory: true,
      });
      threadId = thread.threadId;

      const now = this.#clock();
      session = {
        id: createId('session', this.#idGenerator),
        run_id: args.run.id,
        workflow_id: args.run.workflow_id,
        backend: 'codex',
        kind: 'implementing',
        actor: 'implementer',
        state_id: 'implementing',
        thread_id: thread.threadId,
        workspace_id: workspaceResult.workspace.id,
        cwd: workspaceResult.workspace.path,
        active_turn_id: null,
        active_turn_started_at: null,
        latest_turn_id: null,
        latest_turn_completed_at: null,
        last_turn_status: null,
        status: 'active',
        created_at: now,
        updated_at: now,
        tags: ['workflow-runtime', 'background'],
        metadata: stringMetadata({
          prompt_candidate: promptCandidate,
          source_gate_id: args.sourceGate.id,
          source_gate_option_id: args.selectedOptionId,
        }),
      };
      await this.#sessions.saveSession(session);

      await this.#recordEvent({
        run: args.run,
        type: 'implementer_session_started',
        summary: 'Implementer session started from the approved first prompt.',
        state_id: args.run.current_state_id,
        session_id: session.id,
        thread_id: session.thread_id,
        metadata: stringMetadata({
          workspace_id: workspaceResult.workspace.id,
          source_gate_id: args.sourceGate.id,
        }),
      });

      const turn = await this.#codex.startTurn({
        threadId: session.thread_id,
        text: promptCandidate,
        cwd: session.cwd,
        ...this.#codexExecution,
      });

      const updatedSession: AgentSessionRecord = {
        ...session,
        active_turn_id: turn.turnId,
        active_turn_started_at: this.#clock(),
        updated_at: this.#clock(),
      };
      await this.#sessions.saveSession(updatedSession);

      await this.#recordEvent({
        run: args.run,
        type: 'implementer_turn_started',
        summary: 'Implementer turn started from the approved first prompt.',
        state_id: args.run.current_state_id,
        session_id: updatedSession.id,
        thread_id: updatedSession.thread_id,
        turn_id: turn.turnId,
        metadata: stringMetadata({
          source_gate_id: args.sourceGate.id,
          prompt_candidate: promptCandidate,
        }),
      });

      this.#scheduleImplementerTurnWatcher({
        runId: args.run.id,
        sessionId: updatedSession.id,
        turnId: turn.turnId,
      });
    } catch (error) {
      await this.#transitionRunToFailed({
        runId: args.run.id,
        sessionId: session?.id ?? null,
        threadId: threadId ?? session?.thread_id ?? null,
        eventType: 'implementer_startup_failed',
        summary: 'Implementer launch failed after first-prompt approval.',
        error,
        transitionEvent: 'implementer.failed',
      });
    }
  }

  #scheduleImplementerTurnWatcher(args: {
    runId: string;
    sessionId: string;
    turnId: string;
  }) {
    const key = `${args.sessionId}:${args.turnId}`;
    if (this.#turnTasks.has(key)) {
      return;
    }

    const task = this.#waitForImplementerTurnCompletion(args)
      .catch(async (error) => {
        await this.#transitionRunToFailed({
          runId: args.runId,
          sessionId: args.sessionId,
          turnId: args.turnId,
          eventType: 'implementer_turn_failed',
          summary: 'Implementer turn execution failed after starting.',
          error,
          transitionEvent: 'implementer.failed',
        });
      })
      .finally(() => {
        this.#turnTasks.delete(key);
      });

    this.#turnTasks.set(key, task);
  }

  async #waitForImplementerTurnCompletion(args: {
    runId: string;
    sessionId: string;
    turnId: string;
  }) {
    const completion = await this.#codex.waitForTurnCompletion({
      threadId: (await this.#requireSession(args.sessionId)).thread_id,
      turnId: args.turnId,
    });

    const session = await this.#requireSession(args.sessionId);
    const run = await this.#requireRun(args.runId);
    const completedAt = this.#clock();
    const updatedSession: AgentSessionRecord = {
      ...session,
      active_turn_id: session.active_turn_id === args.turnId ? null : session.active_turn_id,
      active_turn_started_at: session.active_turn_id === args.turnId ? null : session.active_turn_started_at,
      latest_turn_id: args.turnId,
      latest_turn_completed_at: completedAt,
      last_turn_status: normalizeTurnStatus(completion.status),
      status: completion.status === 'completed' ? 'completed' : 'failed',
      updated_at: completedAt,
    };
    await this.#sessions.saveSession(updatedSession);

    if (completion.status !== 'completed') {
      await this.#recordEvent({
        run,
        type: 'implementer_turn_failed',
        summary: `Implementer turn finished with status "${completion.status}".`,
        state_id: run.current_state_id,
        session_id: updatedSession.id,
        thread_id: updatedSession.thread_id,
        turn_id: args.turnId,
        metadata: stringMetadata({ status: completion.status }),
      });

      await this.#transitionRunToFailed({
        runId: run.id,
        sessionId: updatedSession.id,
        threadId: updatedSession.thread_id,
        turnId: args.turnId,
        eventType: 'implementer_runtime_failed',
        summary: `Implementer turn completed with status "${completion.status}".`,
        error: new Error(`Implementer turn ${args.turnId} finished with status "${completion.status}".`),
        transitionEvent: 'implementer.failed',
      });
      return;
    }

    await this.#recordEvent({
      run,
      type: 'implementer_turn_completed',
      summary: 'Implementer turn completed. Reviewer execution is not wired yet.',
      state_id: run.current_state_id,
      session_id: updatedSession.id,
      thread_id: updatedSession.thread_id,
      turn_id: args.turnId,
      metadata: stringMetadata({ status: completion.status }),
    });
  }

  async #createGatesForState(args: {
    run: WorkflowRunRecord;
    state: ReturnType<typeof getWorkflowState> extends infer T ? Exclude<T, null> : never;
    metadata: Record<string, string>;
  }) {
    const now = this.#clock();
    const definition = this.#loadDefinitionOrThrow(args.run.workflow_id);
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

  async #transitionRunToFailed(args: {
    runId: string;
    sessionId?: string | null;
    threadId?: string | null;
    turnId?: string | null;
    eventType: string;
    summary: string;
    error: unknown;
    transitionEvent?: string;
  }) {
    const run = await this.#runs.getRun(args.runId);
    if (!run) {
      return null;
    }

    const definition = this.#loadDefinitionOrThrow(run.workflow_id);
    const failedState = getWorkflowState(definition, 'failed');
    if (!failedState) {
      throw new Error(`Workflow "${definition.id}" is missing its failed state.`);
    }

    const errorMessage = args.error instanceof Error ? args.error.message : String(args.error);
    await this.#recordEvent({
      run,
      type: args.eventType,
      summary: args.summary,
      state_id: run.current_state_id,
      session_id: args.sessionId ?? null,
      thread_id: args.threadId ?? null,
      turn_id: args.turnId ?? null,
      metadata: stringMetadata({ error: errorMessage }),
    });

    if (run.current_state_id === failedState.id && run.status === 'failed') {
      return run;
    }

    const transition = findWorkflowTransition(definition, {
      fromStateId: run.current_state_id,
      event: args.transitionEvent ?? 'planner.abort',
    });

    const updatedRun: WorkflowRunRecord = {
      ...run,
      status: 'failed',
      current_state_id: failedState.id,
      current_state_family: failedState.family,
      open_gate_ids: [],
      last_transition_id: transition?.id ?? run.last_transition_id,
      updated_at: this.#clock(),
      completed_at: this.#clock(),
    };
    await this.#runs.saveRun(updatedRun);

    await this.#recordEvent({
      run: updatedRun,
      type: 'state_transition',
      summary: transition
        ? `Run transitioned from ${transition.from} to ${transition.to}.`
        : 'Run moved into the failed terminal state.',
      state_id: updatedRun.current_state_id,
      from_state_id: transition?.from ?? run.current_state_id,
      to_state_id: failedState.id,
      transition_id: transition?.id ?? null,
      session_id: args.sessionId ?? null,
      thread_id: args.threadId ?? null,
      turn_id: args.turnId ?? null,
      metadata: stringMetadata({ error: errorMessage }),
    });

    if (args.sessionId) {
      const session = await this.#sessions.getSession(args.sessionId);
      if (session) {
        await this.#sessions.saveSession({
          ...session,
          active_turn_id: null,
          active_turn_started_at: null,
          status: 'failed',
          updated_at: this.#clock(),
        });
      }
    }

    return updatedRun;
  }

  async #requireRun(runId: string) {
    const run = await this.#runs.getRun(runId);
    if (!run) {
      throw new Error(`Workflow run "${runId}" was not found.`);
    }
    return run;
  }

  async #requireSession(sessionId: string) {
    const session = await this.#sessions.getSession(sessionId);
    if (!session) {
      throw new Error(`Workflow session "${sessionId}" was not found.`);
    }
    return session;
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
      tags: ['workflow-runtime'],
      metadata: args.metadata,
    };
    await this.#events.saveEvent(event);

    const update: WorkflowRunUpdate = {
      run_id: event.run_id,
      event,
    };
    for (const listener of this.#listeners) {
      try {
        listener(update);
      } catch {
        // Ignore subscriber errors so workflow execution keeps moving.
      }
    }

    return event;
  }
}
