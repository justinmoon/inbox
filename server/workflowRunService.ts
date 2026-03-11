import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

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
  WorkflowArtifactRecord,
  WorkflowRunRecord,
} from '../shared/workflowRuntime.ts';
import type { RepositoryRecord, WorkspaceRecord } from '../shared/workspaces.ts';
import { AgentSessionStore } from './agentSessionStore.ts';
import type { CodexClient } from './codexClient.ts';
import { GateStore } from './gateStore.ts';
import { RunEventStore } from './runEventStore.ts';
import { buildWorkflowRunSwarmView } from './swarmRunView.ts';
import { SwarmDefinitionService } from './swarmDefinitionService.ts';
import { WorkflowArtifactStore } from './workflowArtifactStore.ts';
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

function isRemoteRepositorySource(source: string | null | undefined) {
  return typeof source === 'string' && /^(https?:\/\/|ssh:\/\/|git@|file:\/\/)/.test(source);
}

async function runCommand(command: string, args: string[], cwd?: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve(stdout.trimEnd());
        return;
      }

      reject(new Error(stderr.trim() || `${command} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

async function git(args: string[], cwd: string) {
  return await runCommand('git', args, cwd);
}

async function realpathOrResolve(targetPath: string) {
  try {
    return await fs.realpath(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

export class WorkflowRunService {
  #definitions: WorkflowDefinitionService;
  #runs: WorkflowRunStore;
  #gates: GateStore;
  #sessions: AgentSessionStore;
  #events: RunEventStore;
  #artifacts: WorkflowArtifactStore;
  #swarms: SwarmDefinitionService;
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
    artifacts: WorkflowArtifactStore;
    swarms?: SwarmDefinitionService;
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
    this.#artifacts = args.artifacts;
    this.#swarms = args.swarms ?? new SwarmDefinitionService();
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

  async waitForIdle() {
    while (this.#turnTasks.size > 0) {
      await Promise.allSettled([...this.#turnTasks.values()]);
    }
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
        text: prompt.render({
          run,
          runtime_context: {
            planning_workspace_path: repositoryContext.workspace.path,
            authoritative_workspace_path: repositoryContext.workspace.path,
          },
        }),
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
    const artifacts = await this.#artifacts.listByRun(runId);
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

    const detail = {
      run,
      sessions: sessionDetails,
      artifacts,
      open_gates: openGates,
      events,
      swarm: null,
    };

    return {
      ...detail,
      swarm: buildWorkflowRunSwarmView(detail),
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

  async #buildWorkspaceContractMetadata(args: {
    run: WorkflowRunRecord;
    workspacePath: string | null;
  }) {
    const metadata = stringMetadata({
      authoritative_workspace_path: args.workspacePath,
    });
    const sourceRepoPath = args.run.repo.repo_path;
    if (!args.workspacePath || !sourceRepoPath || isRemoteRepositorySource(sourceRepoPath)) {
      return metadata;
    }

    const [resolvedSourceRepoPath, resolvedWorkspacePath] = await Promise.all([
      realpathOrResolve(sourceRepoPath),
      realpathOrResolve(args.workspacePath),
    ]);
    if (resolvedSourceRepoPath === resolvedWorkspacePath) {
      return metadata;
    }

    const sourceRepoStatus = await git(['status', '--porcelain'], resolvedSourceRepoPath);
    return {
      ...metadata,
      source_repo_path: resolvedSourceRepoPath,
      source_repo_status_before: sourceRepoStatus,
    };
  }

  #rewriteTextForWorkspaceContract(args: {
    text: string | null;
    sourceRepoPath: string | null;
    workspacePath: string | null;
  }) {
    const text = args.text?.trim();
    if (!text) {
      return null;
    }

    if (!args.sourceRepoPath || !args.workspacePath || args.sourceRepoPath === args.workspacePath) {
      return text;
    }

    return text.split(args.sourceRepoPath).join(args.workspacePath);
  }

  async #enforceWorkspaceContract(args: {
    run: WorkflowRunRecord;
    session: AgentSessionRecord;
    turnId: string;
    summary: string;
    transitionEvent: string;
  }) {
    const sourceRepoPath = args.session.metadata.source_repo_path ?? null;
    const expectedSourceStatus = args.session.metadata.source_repo_status_before;
    if (!sourceRepoPath || typeof expectedSourceStatus !== 'string') {
      return true;
    }

    const currentSourceStatus = await git(['status', '--porcelain'], sourceRepoPath);
    if (currentSourceStatus === expectedSourceStatus) {
      return true;
    }

    await this.#transitionRunToFailed({
      runId: args.run.id,
      sessionId: args.session.id,
      threadId: args.session.thread_id,
      turnId: args.turnId,
      eventType: 'workspace_contract_violated',
      summary: args.summary,
      error: new Error(
        [
          `Authoritative workspace: ${args.session.cwd ?? 'unavailable'}`,
          `Source repository: ${sourceRepoPath}`,
          'The source repository changed while worker execution was bound to a peer workspace.',
        ].join('\n'),
      ),
      transitionEvent: args.transitionEvent,
    });
    return false;
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
        metadata: stringMetadata({
          prompt_id: prompt.id,
          authoritative_workspace_path: args.workspace.path,
        }),
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
          workspace_path: args.workspace.path,
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

      this.#schedulePlanningTurnWatcher({
        runId: run.id,
        sessionId: updatedSession.id,
        promptId: args.promptId,
        turnId: turn.turnId,
      });

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

      const rawPromptCandidate =
        typeof parserResult === 'string'
          ? parserResult
          : isObject(parserResult) && typeof parserResult.prompt_candidate === 'string'
            ? parserResult.prompt_candidate
            : null;
      const promptCandidate = this.#rewriteTextForWorkspaceContract({
        text: rawPromptCandidate,
        sourceRepoPath: run.repo.repo_path ?? null,
        workspacePath: session.cwd,
      });

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
      const workspaceContractMetadata = await this.#buildWorkspaceContractMetadata({
        run: args.run,
        workspacePath: workspaceResult.workspace.path,
      });
      const implementerPrompt = this.#buildImplementerTurnText({
        workflowId: args.run.workflow_id,
        promptCandidate,
        goalPrompt: args.run.goal_prompt,
        workspacePath: workspaceResult.workspace.path,
        sourceRepoPath: args.run.repo.repo_path ?? null,
      });

      await this.#recordEvent({
        run: args.run,
        type: 'implementer_workspace_created',
        summary: 'Implementer workspace created from the approved first prompt.',
        state_id: args.run.current_state_id,
        metadata: stringMetadata({
          workspace_id: workspaceResult.workspace.id,
          workspace_path: workspaceResult.workspace.path,
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
          ...workspaceContractMetadata,
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
          workspace_path: workspaceResult.workspace.path,
          source_gate_id: args.sourceGate.id,
        }),
      });

      const turn = await this.#codex.startTurn({
        threadId: session.thread_id,
        text: implementerPrompt,
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

      this.#scheduleImplementerTurnWatcher({
        runId: args.run.id,
        sessionId: updatedSession.id,
        turnId: turn.turnId,
      });

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
      summary:
        run.current_state_id === 'fixup_implementing'
          ? 'Implementer fixup turn completed.'
          : 'Implementer turn completed.',
      state_id: run.current_state_id,
      session_id: updatedSession.id,
      thread_id: updatedSession.thread_id,
      turn_id: args.turnId,
      metadata: stringMetadata({ status: completion.status }),
    });

    const workspaceContractOk = await this.#enforceWorkspaceContract({
      run,
      session: updatedSession,
      turnId: args.turnId,
      summary:
        'Source repository changed while implementer execution was bound to a surfaced peer workspace.',
      transitionEvent: 'implementer.failed',
    });
    if (!workspaceContractOk) {
      return;
    }

    const definition = this.#loadDefinitionOrThrow(run.workflow_id);
    const transition = findWorkflowTransition(definition, {
      fromStateId: run.current_state_id,
      event: 'implementer.completed',
    });
    if (!transition) {
      return;
    }

    const transitionResult = await this.#transitionRun({
      run,
      transition,
      sessionId: updatedSession.id,
      threadId: updatedSession.thread_id,
      turnId: args.turnId,
      metadata: stringMetadata({ status: completion.status }),
      gateMetadata: {},
    });

    if (transitionResult.nextState.id !== 'auto_review') {
      return;
    }

    const implementerThread = await this.#codex.readThread({
      threadId: updatedSession.thread_id,
      includeTurns: true,
    });

    await this.#startReviewTurn({
      run: transitionResult.run,
      implementerSession: updatedSession,
      implementerThread,
      implementerTurnId: args.turnId,
    });
  }

  async #startReviewTurn(args: {
    run: WorkflowRunRecord;
    implementerSession: AgentSessionRecord;
    implementerThread: CodexThread;
    implementerTurnId: string;
  }) {
    const definition = this.#loadDefinitionOrThrow(args.run.workflow_id);
    const state = getWorkflowState(definition, 'auto_review');
    const promptId = state?.prompt_ids[0] ?? null;
    const prompt = promptId ? getWorkflowPrompt(definition, promptId) : null;
    const session = await this.#loadPlanningSession(args.run.id);

    if (!state || !promptId || !prompt || !session) {
      await this.#transitionRunToFailed({
        runId: args.run.id,
        sessionId: session?.id ?? null,
        threadId: session?.thread_id ?? null,
        turnId: args.implementerTurnId,
        eventType: 'review_startup_failed',
        summary: 'Planner review could not start after implementer completion.',
        error: new Error('Planner review state, prompt, or session is unavailable.'),
        transitionEvent: 'review.abort',
      });
      return;
    }

    const reviewContext: Record<string, string | null> = {
      approved_prompt_candidate: args.implementerSession.metadata.prompt_candidate ?? null,
      implementer_output: latestAssistantTextForTurn(args.implementerThread, args.implementerTurnId),
      implementer_workspace_path: args.implementerSession.cwd,
      implementer_thread_id: args.implementerSession.thread_id,
      implementer_turn_id: args.implementerTurnId,
    };

    try {
      const preparedSession: AgentSessionRecord = {
        ...session,
        state_id: state.id,
        status: 'active',
        workspace_id: args.implementerSession.workspace_id,
        cwd: args.implementerSession.cwd,
        updated_at: this.#clock(),
        metadata: {
          ...session.metadata,
          ...stringMetadata({
            prompt_id: prompt.id,
            last_reviewed_turn_id: args.implementerTurnId,
            last_reviewed_thread_id: args.implementerSession.thread_id,
            authoritative_workspace_path: args.implementerSession.cwd,
          }),
        },
      };
      await this.#sessions.saveSession(preparedSession);

      await this.#codex.resumeThread({
        threadId: preparedSession.thread_id,
        ...this.#codexExecution,
        persistExtendedHistory: true,
      });

      const turn = await this.#codex.startTurn({
        threadId: preparedSession.thread_id,
        text: prompt.render({
          run: args.run,
          runtime_context: reviewContext,
        }),
        cwd: preparedSession.cwd,
        ...this.#codexExecution,
      });

      const updatedSession: AgentSessionRecord = {
        ...preparedSession,
        active_turn_id: turn.turnId,
        active_turn_started_at: this.#clock(),
        updated_at: this.#clock(),
      };
      await this.#sessions.saveSession(updatedSession);

      this.#scheduleReviewTurnWatcher({
        runId: args.run.id,
        sessionId: updatedSession.id,
        promptId: prompt.id,
        turnId: turn.turnId,
      });

      await this.#recordEvent({
        run: args.run,
        type: 'review_turn_started',
        summary: 'Planner review turn started after implementer completion.',
        state_id: args.run.current_state_id,
        session_id: updatedSession.id,
        thread_id: updatedSession.thread_id,
        turn_id: turn.turnId,
        metadata: stringMetadata({
          prompt_id: prompt.id,
          reviewed_turn_id: args.implementerTurnId,
          implementer_thread_id: args.implementerSession.thread_id,
          workspace_id: preparedSession.workspace_id,
          workspace_path: preparedSession.cwd,
        }),
      });
    } catch (error) {
      await this.#transitionRunToFailed({
        runId: args.run.id,
        sessionId: session.id,
        threadId: session.thread_id,
        turnId: args.implementerTurnId,
        eventType: 'review_startup_failed',
        summary: 'Planner review failed to start after implementer completion.',
        error,
        transitionEvent: 'review.abort',
      });
    }
  }

  #scheduleReviewTurnWatcher(args: {
    runId: string;
    sessionId: string;
    promptId: string;
    turnId: string;
  }) {
    const key = `${args.sessionId}:${args.turnId}`;
    if (this.#turnTasks.has(key)) {
      return;
    }

    const task = this.#waitForReviewTurnCompletion(args)
      .catch(async (error) => {
        await this.#transitionRunToFailed({
          runId: args.runId,
          sessionId: args.sessionId,
          turnId: args.turnId,
          eventType: 'review_turn_failed',
          summary: 'Planner review execution failed after starting.',
          error,
          transitionEvent: 'review.abort',
        });
      })
      .finally(() => {
        this.#turnTasks.delete(key);
      });

    this.#turnTasks.set(key, task);
  }

  async #waitForReviewTurnCompletion(args: {
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
        type: 'review_turn_failed',
        summary: `Planner review finished with status "${completion.status}".`,
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
        eventType: 'review_runtime_failed',
        summary: `Planner review completed with status "${completion.status}".`,
        error: new Error(`Review turn ${args.turnId} finished with status "${completion.status}".`),
        transitionEvent: 'review.abort',
      });
      return;
    }

    await this.#recordEvent({
      run,
      type: 'review_turn_completed',
      summary: 'Planner review turn completed.',
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

    await this.#applyReviewTurnOutcome({
      runId: run.id,
      sessionId: updatedSession.id,
      definitionId: run.workflow_id,
      promptId: args.promptId,
      turnId: args.turnId,
      thread,
    });
  }

  async #applyReviewTurnOutcome(args: {
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
      await this.#transitionRunToFailed({
        runId: run.id,
        sessionId: session.id,
        threadId: session.thread_id,
        turnId: args.turnId,
        eventType: 'review_output_missing',
        summary: 'Planner review completed without an assistant verdict.',
        error: new Error('Planner review did not emit an assistant message.'),
        transitionEvent: 'review.abort',
      });
      return;
    }

    for (const parserHookId of prompt.parser_hook_ids) {
      const parserHook = getWorkflowParserHook(definition, parserHookId);
      if (!parserHook) {
        continue;
      }

      const parserResult = parserHook.parse(latestAssistantText);
      if (!isObject(parserResult) || typeof parserResult.status !== 'string') {
        continue;
      }

      const reviewStatus = parserResult.status;
      const reviewBody = typeof parserResult.body === 'string' ? parserResult.body : null;
      const transitionEvent =
        reviewStatus === 'accepted'
          ? 'review.accepted'
          : reviewStatus === 'fixup_required'
            ? 'review.fixup_required'
            : reviewStatus === 'replan_required'
              ? 'review.replan_required'
              : null;

      if (!transitionEvent) {
        continue;
      }

      await this.#recordEvent({
        run,
        type: 'review_result_detected',
        summary: `Planner review emitted the "${reviewStatus}" verdict.`,
        state_id: run.current_state_id,
        session_id: session.id,
        thread_id: session.thread_id,
        turn_id: args.turnId,
        metadata: stringMetadata({
          parser_hook_id: parserHook.id,
          review_status: reviewStatus,
          review_body: reviewBody,
        }),
      });

      const transition = findWorkflowTransition(definition, {
        fromStateId: run.current_state_id,
        event: transitionEvent,
      });
      if (!transition) {
        throw new Error(
          `Workflow "${definition.id}" has no transition for event "${transitionEvent}" from state "${run.current_state_id}".`,
        );
      }

      if (reviewStatus === 'accepted') {
        await this.#sessions.saveSession({
          ...session,
          state_id: transition.to,
          updated_at: this.#clock(),
        });
      }

      if (reviewStatus === 'replan_required') {
        await this.#sessions.saveSession({
          ...session,
          state_id: transition.to,
          updated_at: this.#clock(),
          metadata: {
            ...session.metadata,
            ...stringMetadata({
              prompt_id: 'planner_conversation',
              review_replan_body: reviewBody,
            }),
          },
        });
      }

      const transitionResult = await this.#transitionRun({
        run,
        transition,
        sessionId: session.id,
        threadId: session.thread_id,
        turnId: args.turnId,
        metadata: stringMetadata({
          parser_hook_id: parserHook.id,
          review_status: reviewStatus,
          review_body: reviewBody,
        }),
        gateMetadata: {},
      });

      if (reviewStatus === 'accepted') {
        await this.#startArtifactWorkers({
          run: transitionResult.run,
          plannerSession: session,
          reviewOutput: latestAssistantText,
          reviewTurnId: args.turnId,
        });
        return;
      }

      if (reviewStatus === 'replan_required') {
        return;
      }

      await this.#startFixupImplementerTurn({
        run: transitionResult.run,
        promptCandidate: reviewBody,
        reviewSession: session,
        reviewTurnId: args.turnId,
      });
      return;
    }

    await this.#transitionRunToFailed({
      runId: run.id,
      sessionId: session.id,
      threadId: session.thread_id,
      turnId: args.turnId,
      eventType: 'review_marker_not_found',
      summary: 'Planner review completed without an explicit verdict marker.',
      error: new Error('Planner review did not emit an explicit verdict marker.'),
      transitionEvent: 'review.abort',
    });
  }

  async #startFixupImplementerTurn(args: {
    run: WorkflowRunRecord;
    promptCandidate: string | null;
    reviewSession: AgentSessionRecord;
    reviewTurnId: string;
  }) {
    const promptCandidate = args.promptCandidate?.trim() ?? null;
    const session = await this.#loadImplementerSession(args.run.id);
    if (!promptCandidate || !session) {
      await this.#transitionRunToFailed({
        runId: args.run.id,
        sessionId: args.reviewSession.id,
        threadId: args.reviewSession.thread_id,
        turnId: args.reviewTurnId,
        eventType: 'implementer_startup_failed',
        summary: 'Implementer fixup could not start after planner review.',
        error: new Error('Fixup prompt or implementer session is unavailable.'),
        transitionEvent: 'implementer.failed',
      });
      return;
    }

    try {
      await this.#codex.resumeThread({
        threadId: session.thread_id,
        ...this.#codexExecution,
        persistExtendedHistory: true,
      });
      const workspaceContractMetadata = await this.#buildWorkspaceContractMetadata({
        run: args.run,
        workspacePath: session.cwd,
      });

      const preparedSession: AgentSessionRecord = {
        ...session,
        state_id: args.run.current_state_id,
        status: 'active',
        updated_at: this.#clock(),
        metadata: {
          ...session.metadata,
          ...stringMetadata({
            prompt_candidate: promptCandidate,
            fixup_review_turn_id: args.reviewTurnId,
            ...workspaceContractMetadata,
          }),
        },
      };
      await this.#sessions.saveSession(preparedSession);

      const turn = await this.#codex.startTurn({
        threadId: preparedSession.thread_id,
        text: this.#buildImplementerTurnText({
          workflowId: args.run.workflow_id,
          promptCandidate,
          goalPrompt: args.run.goal_prompt,
          workspacePath: preparedSession.cwd,
          sourceRepoPath: args.run.repo.repo_path ?? null,
          promptLabel: 'Fixup prompt',
        }),
        cwd: preparedSession.cwd,
        ...this.#codexExecution,
      });

      const updatedSession: AgentSessionRecord = {
        ...preparedSession,
        active_turn_id: turn.turnId,
        active_turn_started_at: this.#clock(),
        updated_at: this.#clock(),
      };
      await this.#sessions.saveSession(updatedSession);

      this.#scheduleImplementerTurnWatcher({
        runId: args.run.id,
        sessionId: updatedSession.id,
        turnId: turn.turnId,
      });

      await this.#recordEvent({
        run: args.run,
        type: 'implementer_turn_started',
        summary: 'Implementer fixup turn started from planner review.',
        state_id: args.run.current_state_id,
        session_id: updatedSession.id,
        thread_id: updatedSession.thread_id,
        turn_id: turn.turnId,
        metadata: stringMetadata({
          prompt_candidate: promptCandidate,
          review_turn_id: args.reviewTurnId,
        }),
      });
    } catch (error) {
      await this.#transitionRunToFailed({
        runId: args.run.id,
        sessionId: session.id,
        threadId: session.thread_id,
        turnId: args.reviewTurnId,
        eventType: 'implementer_startup_failed',
        summary: 'Implementer fixup failed to start after planner review.',
        error,
        transitionEvent: 'implementer.failed',
      });
    }
  }

  async #startArtifactWorkers(args: {
    run: WorkflowRunRecord;
    plannerSession: AgentSessionRecord;
    reviewOutput: string;
    reviewTurnId: string;
  }) {
    const preparedPlannerSession: AgentSessionRecord = {
      ...args.plannerSession,
      state_id: args.run.current_state_id,
      active_turn_id: null,
      active_turn_started_at: null,
      status: 'active',
      updated_at: this.#clock(),
      metadata: {
        ...args.plannerSession.metadata,
        ...stringMetadata({
          prompt_id: 'planner_conversation',
          last_accepted_review_turn_id: args.reviewTurnId,
        }),
      },
    };
    await this.#sessions.saveSession(preparedPlannerSession);

    const runtimeContext = await this.#buildArtifactRuntimeContext({
      run: args.run,
      reviewOutput: args.reviewOutput,
    });

    await this.#startArtifactWorker({
      run: args.run,
      plannerSession: preparedPlannerSession,
      worker: 'tutorial_artifact',
      runtimeContext,
      reviewTurnId: args.reviewTurnId,
    });

    const refreshedRun = await this.#requireRun(args.run.id);
    if (refreshedRun.current_state_id !== 'artifact_forking' || refreshedRun.status !== 'active') {
      return;
    }

    await this.#startArtifactWorker({
      run: refreshedRun,
      plannerSession: preparedPlannerSession,
      worker: 'next_prompt_artifact',
      runtimeContext,
      reviewTurnId: args.reviewTurnId,
    });
  }

  async #buildArtifactRuntimeContext(args: {
    run: WorkflowRunRecord;
    reviewOutput: string;
  }): Promise<Record<string, string | null>> {
    const implementerSession = await this.#loadImplementerSession(args.run.id);
    if (!implementerSession?.latest_turn_id) {
      throw new Error(`Workflow run "${args.run.id}" is missing implementer context for artifact workers.`);
    }

    const implementerThread = await this.#codex.readThread({
      threadId: implementerSession.thread_id,
      includeTurns: true,
    });

    return {
      approved_prompt_candidate: implementerSession.metadata.prompt_candidate ?? null,
      implementer_output: latestAssistantTextForTurn(implementerThread, implementerSession.latest_turn_id),
      implementer_workspace_path: implementerSession.cwd,
      implementer_thread_id: implementerSession.thread_id,
      review_output: args.reviewOutput,
    };
  }

  #artifactWorkerConfig(args: {
    workflowId: string;
    worker: 'tutorial_artifact' | 'next_prompt_artifact';
  }) {
    const swarm = this.#swarms.getDefinition(args.workflowId);
    if (!swarm) {
      throw new Error(`Swarm definition "${args.workflowId}" was not found.`);
    }

    if (args.worker === 'tutorial_artifact') {
      return {
        artifactKind: 'tutorial_artifact' as const,
        agentId: 'tutorial_writer',
        sessionKind: 'tutorial_writing',
        promptId: 'tutorial',
        sessionStartedEventType: 'tutorial_worker_session_started',
        turnStartedEventType: 'tutorial_worker_turn_started',
        turnCompletedEventType: 'tutorial_worker_turn_completed',
        turnFailedEventType: 'tutorial_worker_turn_failed',
        artifactSavedEventType: 'tutorial_artifact_persisted',
        sessionStartedSummary: 'Tutorial worker session started from the accepted review.',
        turnStartedSummary: 'Tutorial worker turn started.',
        turnCompletedSummary: 'Tutorial worker turn completed.',
        artifactSavedSummary: 'Tutorial artifact persisted from worker output.',
        startupFailureSummary: 'Tutorial worker could not start after accepted review.',
      };
    }

    return {
      artifactKind: 'next_prompt_artifact' as const,
      agentId: 'next_prompt_writer',
      sessionKind: 'next_prompt_writing',
      promptId: 'next_prompt',
      sessionStartedEventType: 'next_prompt_worker_session_started',
      turnStartedEventType: 'next_prompt_worker_turn_started',
      turnCompletedEventType: 'next_prompt_worker_turn_completed',
      turnFailedEventType: 'next_prompt_worker_turn_failed',
      artifactSavedEventType: 'next_prompt_artifact_persisted',
      sessionStartedSummary: 'Next-prompt worker session started from the accepted review.',
      turnStartedSummary: 'Next-prompt worker turn started.',
      turnCompletedSummary: 'Next-prompt worker turn completed.',
      artifactSavedSummary: 'Next-prompt artifact persisted from worker output.',
      startupFailureSummary: 'Next-prompt worker could not start after accepted review.',
    };
  }

  async #startArtifactWorker(args: {
    run: WorkflowRunRecord;
    plannerSession: AgentSessionRecord;
    worker: 'tutorial_artifact' | 'next_prompt_artifact';
    runtimeContext: Record<string, string | null>;
    reviewTurnId: string;
  }) {
    const latestRun = await this.#requireRun(args.run.id);
    if (latestRun.current_state_id !== 'artifact_forking' || latestRun.status !== 'active') {
      return;
    }

    const config = this.#artifactWorkerConfig({
      workflowId: latestRun.workflow_id,
      worker: args.worker,
    });
    const definition = this.#loadDefinitionOrThrow(latestRun.workflow_id);
    const prompt = getWorkflowPrompt(definition, config.promptId);
    if (!prompt) {
      throw new Error(`Prompt "${config.promptId}" was not found in workflow "${definition.id}".`);
    }

    let session: AgentSessionRecord | null = null;
    let artifact: WorkflowArtifactRecord | null = null;
    let threadId: string | null = null;

    try {
      const forkedThread = await this.#codex.forkThread({
        threadId: args.plannerSession.thread_id,
        persistExtendedHistory: true,
        personality: 'pragmatic',
      });
      threadId = forkedThread.threadId;

      const now = this.#clock();
      session = {
        id: createId('session', this.#idGenerator),
        run_id: latestRun.id,
        workflow_id: latestRun.workflow_id,
        backend: 'codex',
        kind: config.sessionKind,
        actor: config.agentId,
        state_id: latestRun.current_state_id,
        thread_id: forkedThread.threadId,
        workspace_id: args.plannerSession.workspace_id,
        cwd: args.plannerSession.cwd,
        active_turn_id: null,
        active_turn_started_at: null,
        latest_turn_id: null,
        latest_turn_completed_at: null,
        last_turn_status: null,
        status: 'active',
        created_at: now,
        updated_at: now,
        tags: ['workflow-runtime', 'artifact-worker'],
        metadata: stringMetadata({
          prompt_id: prompt.id,
          parent_thread_id: args.plannerSession.thread_id,
          artifact_kind: config.artifactKind,
          authoritative_workspace_path: args.plannerSession.cwd,
        }),
      };
      await this.#sessions.saveSession(session);

      artifact = {
        id: createId('artifact', this.#idGenerator),
        run_id: latestRun.id,
        workflow_id: latestRun.workflow_id,
        kind: config.artifactKind,
        status: 'pending',
        state_id: latestRun.current_state_id,
        session_id: session.id,
        thread_id: session.thread_id,
        turn_id: null,
        content: null,
        created_at: now,
        updated_at: now,
        completed_at: null,
        tags: ['workflow-runtime', 'artifact'],
        metadata: stringMetadata({
          prompt_id: prompt.id,
          approved_prompt_candidate: args.runtimeContext.approved_prompt_candidate ?? null,
          source_review_turn_id: args.reviewTurnId,
        }),
      };
      await this.#artifacts.saveArtifact(artifact);

      await this.#recordEvent({
        run: latestRun,
        type: config.sessionStartedEventType,
        summary: config.sessionStartedSummary,
        state_id: latestRun.current_state_id,
        session_id: session.id,
        thread_id: session.thread_id,
        metadata: stringMetadata({
          artifact_id: artifact.id,
          artifact_kind: artifact.kind,
          prompt_id: prompt.id,
          workspace_id: session.workspace_id,
          workspace_path: session.cwd,
        }),
      });

      const turn = await this.#codex.startTurn({
        threadId: session.thread_id,
        text: prompt.render({
          run: latestRun,
          runtime_context: args.runtimeContext,
        }),
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
      await this.#artifacts.saveArtifact({
        ...artifact,
        turn_id: turn.turnId,
        updated_at: this.#clock(),
      });

      this.#scheduleArtifactWorkerWatcher({
        runId: latestRun.id,
        sessionId: updatedSession.id,
        promptId: prompt.id,
        turnId: turn.turnId,
        artifactId: artifact.id,
        worker: config.artifactKind,
      });

      await this.#recordEvent({
        run: latestRun,
        type: config.turnStartedEventType,
        summary: config.turnStartedSummary,
        state_id: latestRun.current_state_id,
        session_id: updatedSession.id,
        thread_id: updatedSession.thread_id,
        turn_id: turn.turnId,
        metadata: stringMetadata({
          artifact_id: artifact.id,
          artifact_kind: artifact.kind,
          prompt_id: prompt.id,
          workspace_id: updatedSession.workspace_id,
          workspace_path: updatedSession.cwd,
        }),
      });
    } catch (error) {
      if (artifact) {
        await this.#artifacts.saveArtifact({
          ...artifact,
          status: 'failed',
          updated_at: this.#clock(),
          completed_at: this.#clock(),
        });
      }
      await this.#transitionRunToFailed({
        runId: latestRun.id,
        sessionId: session?.id ?? null,
        threadId: threadId ?? session?.thread_id ?? null,
        turnId: artifact?.turn_id ?? null,
        eventType: 'artifact_worker_startup_failed',
        summary: config.startupFailureSummary,
        error,
        transitionEvent: 'artifacts.failed',
      });
    }
  }

  #scheduleArtifactWorkerWatcher(args: {
    runId: string;
    sessionId: string;
    promptId: string;
    turnId: string;
    artifactId: string;
    worker: 'tutorial_artifact' | 'next_prompt_artifact';
  }) {
    const key = `${args.sessionId}:${args.turnId}`;
    if (this.#turnTasks.has(key)) {
      return;
    }

    const task = this.#waitForArtifactWorkerCompletion(args)
      .catch(async (error) => {
        const config = this.#artifactWorkerConfig({
          workflowId: (await this.#requireRun(args.runId)).workflow_id,
          worker: args.worker,
        });
        await this.#transitionRunToFailed({
          runId: args.runId,
          sessionId: args.sessionId,
          turnId: args.turnId,
          eventType: config.turnFailedEventType,
          summary: `${config.turnCompletedSummary.replace('completed', 'failed after starting')}.`,
          error,
          transitionEvent: 'artifacts.failed',
        });
      })
      .finally(() => {
        this.#turnTasks.delete(key);
      });

    this.#turnTasks.set(key, task);
  }

  async #waitForArtifactWorkerCompletion(args: {
    runId: string;
    sessionId: string;
    promptId: string;
    turnId: string;
    artifactId: string;
    worker: 'tutorial_artifact' | 'next_prompt_artifact';
  }) {
    const completion = await this.#codex.waitForTurnCompletion({
      threadId: (await this.#requireSession(args.sessionId)).thread_id,
      turnId: args.turnId,
    });

    const session = await this.#requireSession(args.sessionId);
    const artifact = await this.#requireArtifact(args.artifactId);
    const run = await this.#requireRun(args.runId);
    const config = this.#artifactWorkerConfig({
      workflowId: run.workflow_id,
      worker: args.worker,
    });
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
      await this.#artifacts.saveArtifact({
        ...artifact,
        status: 'failed',
        updated_at: completedAt,
        completed_at: completedAt,
      });

      await this.#recordEvent({
        run,
        type: config.turnFailedEventType,
        summary: `${config.turnCompletedSummary.replace('completed', `finished with status "${completion.status}"`)}`,
        state_id: run.current_state_id,
        session_id: updatedSession.id,
        thread_id: updatedSession.thread_id,
        turn_id: args.turnId,
        metadata: stringMetadata({
          artifact_id: artifact.id,
          artifact_kind: artifact.kind,
          status: completion.status,
        }),
      });

      await this.#transitionRunToFailed({
        runId: run.id,
        sessionId: updatedSession.id,
        threadId: updatedSession.thread_id,
        turnId: args.turnId,
        eventType: 'artifact_runtime_failed',
        summary: `${config.turnCompletedSummary.replace('completed', `completed with status "${completion.status}"`)}`,
        error: new Error(`Artifact worker turn ${args.turnId} finished with status "${completion.status}".`),
        transitionEvent: 'artifacts.failed',
      });
      return;
    }

    await this.#recordEvent({
      run,
      type: config.turnCompletedEventType,
      summary: config.turnCompletedSummary,
      state_id: run.current_state_id,
      session_id: updatedSession.id,
      thread_id: updatedSession.thread_id,
      turn_id: args.turnId,
      metadata: stringMetadata({
        artifact_id: artifact.id,
        artifact_kind: artifact.kind,
      }),
    });

    const thread = await this.#codex.readThread({
      threadId: updatedSession.thread_id,
      includeTurns: true,
    });

    await this.#applyArtifactWorkerOutcome({
      runId: run.id,
      sessionId: updatedSession.id,
      definitionId: run.workflow_id,
      promptId: args.promptId,
      turnId: args.turnId,
      thread,
      artifactId: artifact.id,
      worker: args.worker,
    });
  }

  async #applyArtifactWorkerOutcome(args: {
    runId: string;
    sessionId: string;
    definitionId: string;
    promptId: string;
    turnId: string;
    thread: CodexThread;
    artifactId: string;
    worker: 'tutorial_artifact' | 'next_prompt_artifact';
  }) {
    const run = await this.#requireRun(args.runId);
    const session = await this.#requireSession(args.sessionId);
    const artifact = await this.#requireArtifact(args.artifactId);
    const config = this.#artifactWorkerConfig({
      workflowId: run.workflow_id,
      worker: args.worker,
    });
    const definition = this.#loadDefinitionOrThrow(args.definitionId);
    const prompt = getWorkflowPrompt(definition, args.promptId);
    if (!prompt) {
      throw new Error(`Prompt "${args.promptId}" was not found in workflow "${definition.id}".`);
    }

    const latestAssistantText = latestAssistantTextForTurn(args.thread, args.turnId);
    if (!latestAssistantText) {
      await this.#artifacts.saveArtifact({
        ...artifact,
        status: 'failed',
        updated_at: this.#clock(),
        completed_at: this.#clock(),
      });
      await this.#transitionRunToFailed({
        runId: run.id,
        sessionId: session.id,
        threadId: session.thread_id,
        turnId: args.turnId,
        eventType: 'artifact_output_missing',
        summary: `${config.artifactSavedSummary.replace('persisted from worker output', 'completed without artifact output')}`,
        error: new Error('Artifact worker did not emit an assistant artifact.'),
        transitionEvent: 'artifacts.failed',
      });
      return;
    }

    for (const parserHookId of prompt.parser_hook_ids) {
      const parserHook = getWorkflowParserHook(definition, parserHookId);
      if (!parserHook) {
        continue;
      }

      const parserResult = parserHook.parse(latestAssistantText);
      if (typeof parserResult !== 'string' || !parserResult.trim()) {
        continue;
      }

      const readyArtifact: WorkflowArtifactRecord = {
        ...artifact,
        status: 'ready',
        content: parserResult.trim(),
        updated_at: this.#clock(),
        completed_at: this.#clock(),
        metadata: {
          ...artifact.metadata,
          ...stringMetadata({ parser_hook_id: parserHook.id }),
        },
      };
      await this.#artifacts.saveArtifact(readyArtifact);

      await this.#recordEvent({
        run,
        type: config.artifactSavedEventType,
        summary: config.artifactSavedSummary,
        state_id: run.current_state_id,
        session_id: session.id,
        thread_id: session.thread_id,
        turn_id: args.turnId,
        metadata: stringMetadata({
          artifact_id: readyArtifact.id,
          artifact_kind: readyArtifact.kind,
          parser_hook_id: parserHook.id,
        }),
      });

      await this.#maybeAdvanceArtifactForking(run.id);
      return;
    }

    await this.#artifacts.saveArtifact({
      ...artifact,
      status: 'failed',
      updated_at: this.#clock(),
      completed_at: this.#clock(),
    });
    await this.#transitionRunToFailed({
      runId: run.id,
      sessionId: session.id,
      threadId: session.thread_id,
      turnId: args.turnId,
      eventType: 'artifact_marker_not_found',
      summary: `${config.artifactSavedSummary.replace('persisted from worker output', 'completed without an explicit artifact marker')}`,
      error: new Error('Artifact worker did not emit an explicit artifact marker.'),
      transitionEvent: 'artifacts.failed',
    });
  }

  async #maybeAdvanceArtifactForking(runId: string) {
    const run = await this.#requireRun(runId);
    if (run.current_state_id !== 'artifact_forking' || run.status !== 'active') {
      return;
    }

    const tutorialArtifact = await this.#loadLatestArtifact(runId, 'tutorial_artifact');
    const nextPromptArtifact = await this.#loadLatestArtifact(runId, 'next_prompt_artifact');
    if (!tutorialArtifact || !nextPromptArtifact) {
      return;
    }

    const definition = this.#loadDefinitionOrThrow(run.workflow_id);
    const transition = findWorkflowTransition(definition, {
      fromStateId: run.current_state_id,
      event: 'artifacts.ready',
    });
    if (!transition) {
      throw new Error(`Workflow "${definition.id}" has no transition for event "artifacts.ready".`);
    }

    const plannerSession = await this.#loadPlanningSession(run.id);
    if (plannerSession) {
      await this.#sessions.saveSession({
        ...plannerSession,
        state_id: 'step_approval',
        updated_at: this.#clock(),
        metadata: {
          ...plannerSession.metadata,
          ...stringMetadata({
            prompt_id: 'planner_conversation',
          }),
        },
      });
    }

    await this.#transitionRun({
      run,
      transition,
      sessionId: plannerSession?.id ?? null,
      threadId: plannerSession?.thread_id ?? null,
      metadata: stringMetadata({
        tutorial_artifact_id: tutorialArtifact.id,
        next_prompt_artifact_id: nextPromptArtifact.id,
      }),
      gateMetadata: stringMetadata({
        tutorial_artifact_id: tutorialArtifact.id,
        tutorial_artifact_content: tutorialArtifact.content,
        next_prompt_artifact_id: nextPromptArtifact.id,
        next_prompt_artifact_content: nextPromptArtifact.content,
        prompt_candidate: nextPromptArtifact.content,
        approved_prompt_candidate:
          nextPromptArtifact.metadata.approved_prompt_candidate ??
          tutorialArtifact.metadata.approved_prompt_candidate ??
          null,
      }),
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

  async #loadImplementerSession(runId: string) {
    const sessions = await this.#sessions.listByRun(runId);
    return sessions.findLast((session) => session.actor === 'implementer') ?? null;
  }

  async #loadLatestArtifact(
    runId: string,
    kind: 'tutorial_artifact' | 'next_prompt_artifact',
  ) {
    const artifacts = await this.#artifacts.listByRun(runId);
    return artifacts.findLast((artifact) => artifact.kind === kind && artifact.status === 'ready') ?? null;
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

  async #requireArtifact(artifactId: string) {
    const artifact = await this.#artifacts.getArtifact(artifactId);
    if (!artifact) {
      throw new Error(`Workflow artifact "${artifactId}" was not found.`);
    }
    return artifact;
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
      sequence: 0,
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
    const persistedEvent = await this.#events.saveEvent(event);

    const update: WorkflowRunUpdate = {
      run_id: persistedEvent.run_id,
      event: persistedEvent,
    };
    for (const listener of this.#listeners) {
      try {
        listener(update);
      } catch {
        // Ignore subscriber errors so workflow execution keeps moving.
      }
    }

    return persistedEvent;
  }

  #buildImplementerTurnText(args: {
    workflowId: string;
    promptCandidate: string;
    goalPrompt: string;
    workspacePath: string | null;
    sourceRepoPath: string | null;
    promptLabel?: string;
  }) {
    const swarm = this.#swarms.getDefinition(args.workflowId);
    const implementer = swarm?.agents.find((agent) => agent.id === 'implementer') ?? null;
    const workspaceBoundPrompt =
      this.#rewriteTextForWorkspaceContract({
        text: args.promptCandidate,
        sourceRepoPath: args.sourceRepoPath,
        workspacePath: args.workspacePath,
      }) ?? args.promptCandidate;

    if (!implementer) {
      return workspaceBoundPrompt;
    }

    return [
      implementer.role_prompt,
      '',
      'Operating guidelines:',
      ...implementer.operating_guidelines.map((guideline) => `- ${guideline}`),
      '',
      'Workflow goal:',
      args.goalPrompt,
      '',
      'Authoritative workspace path:',
      args.workspacePath ?? 'Unavailable.',
      '',
      'Use repo-root relative paths or the authoritative workspace path above.',
      'Do not edit the original source repository checkout or any other directory.',
      '',
      `${args.promptLabel ?? 'Approved prompt candidate'}:`,
      workspaceBoundPrompt,
    ].join('\n');
  }
}
