import fs from 'node:fs/promises';
import path from 'node:path';

import express from 'express';

import type {
  ChangeUnitDetail,
  ChangeUnitExecutionLaunched,
  CreateWorkflowRunRequest,
  CreateWorkspaceRequest,
  EnsureRepositoryRequest,
  ExecuteNextActionResult,
  ListRepositoriesResponse,
  ListWorkflowDefinitionsResponse,
  ListWorkflowRunsResponse,
  ListWorkspacesResponse,
  RespondApprovalResult,
  WorkflowRunStreamEvent,
} from '../shared/api.ts';
import { revisionRefSchema } from '../shared/workspaces.ts';
import { getChangeUnitDetail, listChangeUnits } from './changeUnits.ts';
import { AppServerProcess } from './appServerProcess.ts';
import { readConfig } from './config.ts';
import { buildLinkedSessionViews, buildLiveSessionView } from './codexSessions.ts';
import { ExecutionStateStore } from './executionStateStore.ts';
import {
  clearImportedBundles,
  discoverBundleFiles,
  loadBundlesFromRoots,
  persistImportedBundle,
} from './importBundles.ts';
import { LiveApprovalStore } from './liveApprovalStore.ts';
import { AgentSessionStore } from './agentSessionStore.ts';
import { AppServerCodexClient } from './codexClient.ts';
import { GateStore } from './gateStore.ts';
import { RunEventStore } from './runEventStore.ts';
import { WorkflowArtifactStore } from './workflowArtifactStore.ts';
import { WorkflowDefinitionService } from './workflowDefinitionService.ts';
import { WorkflowRunService } from './workflowRunService.ts';
import { WorkflowRunStore } from './workflowRunStore.ts';
import { WorkspaceService } from './workspaceService.ts';

const config = readConfig(process.env);
const appServer = new AppServerProcess({ codexBin: config.codexBin });
const executionStateStore = new ExecutionStateStore(config.runtimeRoot);
const workspaceService = new WorkspaceService(config.runtimeRoot);
const workflowDefinitionService = new WorkflowDefinitionService();
const workflowRunStore = new WorkflowRunStore(config.runtimeRoot);
const gateStore = new GateStore(config.runtimeRoot);
const agentSessionStore = new AgentSessionStore(config.runtimeRoot);
const runEventStore = new RunEventStore(config.runtimeRoot);
const workflowArtifactStore = new WorkflowArtifactStore(config.runtimeRoot);
const liveSessionSubscribers = new Map<string, Set<express.Response>>();
const workflowRunSubscribers = new Map<string, Set<express.Response>>();
const liveApprovalStore = new LiveApprovalStore();

let appServerReady: Promise<void> | null = null;

type BundleState = {
  bundles: Awaited<ReturnType<typeof loadBundlesFromRoots>>;
  seedPaths: string[];
  importedPaths: string[];
};

async function readBundleState(): Promise<BundleState> {
  const [seedPaths, importedPaths] = await Promise.all([
    discoverBundleFiles(config.seedRoot),
    discoverBundleFiles(config.importedRoot),
  ]);

  return {
    bundles: await loadBundlesFromRoots([config.seedRoot, config.importedRoot]),
    seedPaths,
    importedPaths,
  };
}

async function readBundles() {
  return (await readBundleState()).bundles;
}

function formatBundleLoadError(error: unknown) {
  const message = error instanceof Error ? error.message : 'Failed to load change-unit bundles.';
  return `Failed to load change-unit bundles. ${message}`;
}

function buildEmptyMessage(state: BundleState) {
  if (state.seedPaths.length === 0 && state.importedPaths.length === 0) {
    return `No change-unit bundles were found. Expected the canonical checkpoint under ${config.seedRoot}.`;
  }

  return 'No change-unit bundles are currently available.';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function readStringMap(value: unknown): Record<string, string> {
  if (!isObject(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function buildSandboxPolicy() {
  if (config.sandboxMode === 'dangerFullAccess') {
    return { type: 'dangerFullAccess' };
  }

  if (config.sandboxMode === 'readOnly') {
    return { type: 'readOnly' };
  }

  return {
    type: 'workspaceWrite',
    writableRoots: [process.cwd()],
    networkAccess: config.networkAccess,
  };
}

function getThreadIdFromNotification(message: Record<string, unknown>): string | null {
  const params = isObject(message.params) ? message.params : null;
  if (!params) return null;

  if (typeof params.threadId === 'string') {
    return params.threadId;
  }

  if (isObject(params.thread) && typeof params.thread.id === 'string') {
    return params.thread.id;
  }

  if (isObject(params.turn) && typeof params.turn.threadId === 'string') {
    return params.turn.threadId;
  }

  return null;
}

function broadcastLiveSessionEvent(threadId: string, message: Record<string, unknown>) {
  const subscribers = liveSessionSubscribers.get(threadId);
  if (!subscribers || subscribers.size === 0) return;

  const payload = JSON.stringify({
    method: typeof message.method === 'string' ? message.method : 'unknown',
    params: message.params ?? null,
  });

  for (const response of subscribers) {
    response.write(`data: ${payload}\n\n`);
  }
}

function broadcastLiveSessionMessage(threadId: string, method: string, params: unknown) {
  broadcastLiveSessionEvent(threadId, { method, params });
}

function broadcastWorkflowRunMessage(event: WorkflowRunStreamEvent) {
  const runId = event.params.runId;
  const subscribers = workflowRunSubscribers.get(runId);
  if (!subscribers || subscribers.size === 0) return;

  const payload = JSON.stringify(event);
  for (const response of subscribers) {
    response.write(`data: ${payload}\n\n`);
  }
}

async function ensureAppServerStarted() {
  if (appServer.running) return;
  if (!appServerReady) {
    appServerReady = appServer.start({
      name: 'inbox_review_cockpit',
      title: 'Inbox Review Cockpit',
      version: '0.1.0',
    });

    appServer.on('serverRequest', (message) => {
      const id = typeof message.id === 'number' ? message.id : null;
      if (id === null) return;
      const captured = liveApprovalStore.captureServerRequest(message);
      if (captured) {
        broadcastLiveSessionMessage(captured.thread_id, 'codex/serverRequest', {
          id,
          method: message.method,
          params: message.params ?? null,
        });
        return;
      }

      void appServer.respondError(id, 'Inbox only supports live approval requests in this build.');
    });

    appServer.on('notification', (message) => {
      if (message.method === 'serverRequest/resolved' && isObject(message.params)) {
        const threadId = readString(message.params.threadId);
        const requestId =
          typeof message.params.requestId === 'number' ? message.params.requestId : null;
        if (threadId && requestId !== null) {
          liveApprovalStore.resolve(threadId, requestId);
        }
      }

      const threadId = getThreadIdFromNotification(message);
      if (!threadId) return;
      broadcastLiveSessionEvent(threadId, message);
    });
  }

  try {
    await appServerReady;
  } finally {
    appServerReady = null;
  }
}

const codexClient = new AppServerCodexClient({
  process: appServer,
  clientInfo: {
    name: 'inbox_review_cockpit',
    title: 'Inbox Review Cockpit',
    version: '0.1.0',
  },
  ensureStarted: ensureAppServerStarted,
});
const workflowRunService = new WorkflowRunService({
  definitions: workflowDefinitionService,
  runs: workflowRunStore,
  gates: gateStore,
  sessions: agentSessionStore,
  events: runEventStore,
  artifacts: workflowArtifactStore,
  workspaces: workspaceService,
  codex: codexClient,
  codexExecution: {
    approvalPolicy: config.approvalPolicy,
    sandboxPolicy: buildSandboxPolicy(),
    model: config.model,
  },
});

workflowRunService.subscribe((update) => {
  broadcastWorkflowRunMessage({
    method: 'workflow-run/event',
    params: {
      runId: update.run_id,
      event: update.event,
    },
  });
});

function resolveActionPath(rawPath: string) {
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);
}

function resolveWorkspaceCwd(args: {
  action: ChangeUnitDetail['change_unit']['next_action'];
  workspacePath: string | null;
}) {
  const { action, workspacePath } = args;
  if (!workspacePath) {
    return action?.cwd ? resolveActionPath(action.cwd) : null;
  }

  if (!action?.cwd) {
    return workspacePath;
  }

  const requestedCwd = resolveActionPath(action.cwd);
  const repoSource = action.workspace_request?.repo.source
    ? resolveActionPath(action.workspace_request.repo.source)
    : null;

  if (!repoSource) {
    return workspacePath;
  }

  const relativePath = path.relative(repoSource, requestedCwd);
  if (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
  ) {
    return path.join(workspacePath, relativePath);
  }

  return workspacePath;
}

function extractThreadId(result: unknown): string {
  if (!isObject(result) || !isObject(result.thread) || typeof result.thread.id !== 'string') {
    throw new Error('Codex app-server returned an invalid thread response.');
  }

  return result.thread.id;
}

function extractTurnId(result: unknown): string {
  if (!isObject(result) || !isObject(result.turn) || typeof result.turn.id !== 'string') {
    throw new Error('Codex app-server returned an invalid turn response.');
  }

  return result.turn.id;
}

async function buildDetail(detailId: string): Promise<ChangeUnitDetail | null> {
  const bundles = await readBundles();
  const bundleRecord = getChangeUnitDetail(bundles, detailId);
  if (!bundleRecord) {
    return null;
  }

  const executionState = await executionStateStore.read(detailId);
  const sessionViews = await buildLinkedSessionViews({
    bundleRecord,
    ensureAppServerStarted,
    appServerRequest: (method, params) => appServer.request(method, params),
  });

  let liveSessionId: string | null = null;
  if (executionState.status === 'launched') {
    const liveSessionView = await buildLiveSessionView({
      execution: executionState,
      approvals: liveApprovalStore.list(executionState.thread_id),
      ensureAppServerStarted,
      appServerRequest: (method, params) => appServer.request(method, params),
    });
    sessionViews.push(liveSessionView);
    liveSessionId = liveSessionView.id;
  }

  return {
    ...bundleRecord.bundle,
    execution_state: executionState,
    session_views: sessionViews,
    live_session_id: liveSessionId,
  };
}

async function executeNext(detailId: string): Promise<ExecuteNextActionResult> {
  const detail = await buildDetail(detailId);
  if (!detail) {
    throw new Error('Change unit not found.');
  }

  const action = detail.change_unit.next_action;
  if (!action) {
    throw new Error('This change unit does not define a real next action.');
  }

  if (detail.execution_state.status === 'launching') {
    throw new Error('The next chunk is already launching for this checkpoint.');
  }

  if (detail.execution_state.status === 'launched') {
    throw new Error('The next chunk has already been launched for this checkpoint.');
  }

  const actionLabel = action.label ?? 'Execute Next Prompt';
  const startedAt = new Date().toISOString();
  await executionStateStore.write(detailId, {
    status: 'launching',
    action_label: actionLabel,
    started_at: startedAt,
    message: 'Launching the next chunk from the reviewed checkpoint.',
  });

  await ensureAppServerStarted();

  let threadId = '';
  let threadSource: ExecuteNextActionResult['thread_source'] = 'resumed';
  let launchedWorkspace: ChangeUnitExecutionLaunched['workspace'] = null;

  try {
    if (action.workspace_request) {
      const workspaceResult = await workspaceService.resolveWorkspaceRequest({
        ...action.workspace_request,
        tags: [...(action.workspace_request.tags ?? []), 'execute-next'],
        metadata: {
          ...action.workspace_request.metadata,
          change_unit_id: detail.change_unit.id,
          action_kind: action.kind,
        },
      });
      launchedWorkspace = workspaceResult.workspace;
    }

    if (action.kind === 'codex_fork_path') {
      const forkResult = await appServer.request('thread/fork', {
        threadId: '',
        path: resolveActionPath(action.path),
        persistExtendedHistory: true,
      });
      threadId = extractThreadId(forkResult);
      threadSource = 'forked';
    } else {
      const resumeResult = await appServer.request('thread/resume', {
        threadId: action.thread_id,
        persistExtendedHistory: true,
      });
      threadId = extractThreadId(resumeResult);
    }

    liveApprovalStore.clearThread(threadId);

    const turnResult = await appServer.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: action.prompt, textElements: [] }],
      cwd: resolveWorkspaceCwd({
        action,
        workspacePath: launchedWorkspace?.path ?? null,
      }),
      approvalPolicy: config.approvalPolicy,
      sandboxPolicy: buildSandboxPolicy(),
      model: config.model,
    });

    const launchedState: ChangeUnitExecutionLaunched = {
      status: 'launched',
      thread_id: threadId,
      turn_id: extractTurnId(turnResult),
      action_label: actionLabel,
      thread_source: threadSource,
      started_at: startedAt,
      workspace: launchedWorkspace,
      message:
        threadSource === 'forked'
          ? launchedWorkspace
            ? `Started a forked Codex thread in workspace ${launchedWorkspace.path}.`
            : 'Started a forked Codex thread for the next chunk.'
          : launchedWorkspace
            ? `Resumed the configured Codex thread in workspace ${launchedWorkspace.path}.`
            : 'Resumed the configured Codex thread for the next chunk.',
    };
    await executionStateStore.write(detailId, launchedState);
    return launchedState;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to execute next action.';
    await executionStateStore.write(detailId, {
      status: 'failed',
      action_label: actionLabel,
      started_at: startedAt,
      error_message: message,
      message: 'Launching the next chunk failed.',
    });
    throw error;
  }
}

async function listRepositories(): Promise<ListRepositoriesResponse> {
  return {
    repositories: await workspaceService.listRepositories(),
  };
}

async function listWorkspaces(): Promise<ListWorkspacesResponse> {
  return {
    workspaces: await workspaceService.listWorkspaces(),
  };
}

async function ensureRepository(request: EnsureRepositoryRequest) {
  return await workspaceService.ensureRepository(request);
}

async function createWorkspace(request: CreateWorkspaceRequest) {
  return await workspaceService.createWorkspace(request);
}

async function listWorkflowDefinitions(): Promise<ListWorkflowDefinitionsResponse> {
  return {
    workflows: workflowDefinitionService.listDefinitions(),
  };
}

async function createWorkflowRun(request: CreateWorkflowRunRequest) {
  return await workflowRunService.createRun(request);
}

async function listWorkflowRuns(): Promise<ListWorkflowRunsResponse> {
  return {
    runs: await workflowRunService.listRuns(),
  };
}

async function readWorkflowRun(runId: string) {
  return await workflowRunService.readRunDetail(runId);
}

async function answerWorkflowGate(args: {
  runId: string;
  gateId: string;
  optionId: string;
  message?: string;
}) {
  return await workflowRunService.answerGate(args);
}

async function respondToApproval(args: {
  threadId: string;
  requestId: number;
  decision: 'accept' | 'decline';
}): Promise<RespondApprovalResult> {
  await ensureAppServerStarted();
  const approval = await liveApprovalStore.answer({
    threadId: args.threadId,
    requestId: args.requestId,
    decision: args.decision,
    responder: async (decision) => {
      if (args.requestId < 0) {
        return;
      }

      await appServer.respond(args.requestId, { decision });
    },
  });

  broadcastLiveSessionMessage(args.threadId, 'serverRequest/resolved', {
    threadId: args.threadId,
    requestId: args.requestId,
    decision: args.decision,
  });

  return { approval };
}

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/change-units', async (_req, res) => {
  try {
    const state = await readBundleState();
    const items = listChangeUnits(state.bundles);
    res.json({
      items,
      default_change_id: items[0]?.id ?? null,
      empty_message: items.length === 0 ? buildEmptyMessage(state) : null,
    });
  } catch (error) {
    res.status(500).json({ error: 'bundle_load_failed', message: formatBundleLoadError(error) });
  }
});

app.get('/api/change-units/:id', async (req, res) => {
  try {
    const detail = await buildDetail(req.params.id);
    if (!detail) {
      res.status(404).json({
        error: 'not_found',
        message: `Change unit "${req.params.id}" was not found in the current queue.`,
      });
      return;
    }
    res.json({ detail });
  } catch (error) {
    res.status(500).json({ error: 'bundle_load_failed', message: formatBundleLoadError(error) });
  }
});

app.post('/api/import-bundle', async (req, res) => {
  const bundlePath = typeof req.body?.path === 'string' ? req.body.path : null;
  if (!bundlePath) {
    res.status(400).json({ error: 'missing_path' });
    return;
  }

  try {
    const resolvedPath = path.resolve(process.cwd(), bundlePath);
    const { bundle, targetPath } = await persistImportedBundle(resolvedPath, config.importedRoot);
    res.json({ imported: bundle.change_unit.id, path: targetPath });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to import bundle.';
    res.status(400).json({ error: 'import_failed', message });
  }
});

app.get('/api/repos', async (_req, res) => {
  try {
    res.json(await listRepositories());
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list repositories.';
    res.status(500).json({ error: 'repository_list_failed', message });
  }
});

app.post('/api/repos/ensure', async (req, res) => {
  const source = readString(req.body?.source);
  if (!source) {
    res.status(400).json({ error: 'invalid_source', message: 'Repository source is required.' });
    return;
  }

  try {
    const result = await ensureRepository({
      provider: req.body?.provider === 'shared-store-worktree' ? req.body.provider : undefined,
      id: readString(req.body?.id) ?? undefined,
      source,
      tags: readStringArray(req.body?.tags),
      metadata: readStringMap(req.body?.metadata),
    });
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to ensure repository.';
    res.status(400).json({ error: 'repository_ensure_failed', message });
  }
});

app.get('/api/workspaces', async (_req, res) => {
  try {
    res.json(await listWorkspaces());
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list workspaces.';
    res.status(500).json({ error: 'workspace_list_failed', message });
  }
});

app.post('/api/workspaces', async (req, res) => {
  const provider = req.body?.provider === 'shared-store-worktree' ? req.body.provider : undefined;
  const nameHint = readString(req.body?.name_hint) ?? undefined;
  const tags = readStringArray(req.body?.tags);
  const metadata = readStringMap(req.body?.metadata);

  if (readString(req.body?.source_workspace_id)) {
    try {
      const result = await createWorkspace({
        provider,
        source_workspace_id: readString(req.body?.source_workspace_id)!,
        name_hint: nameHint,
        tags,
        metadata,
      });
      res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create workspace.';
      res.status(400).json({ error: 'workspace_create_failed', message });
    }
    return;
  }

  const repoId = readString(req.body?.repo_id);
  if (!repoId) {
    res.status(400).json({
      error: 'invalid_workspace_source',
      message: 'Workspace creation requires repo_id or source_workspace_id.',
    });
    return;
  }

  const fromInput = req.body?.from;
  const parsedFrom = fromInput ? revisionRefSchema.safeParse(fromInput) : null;
  if (parsedFrom && !parsedFrom.success) {
    res.status(400).json({ error: 'invalid_revision', message: 'Workspace revision is invalid.' });
    return;
  }

  try {
    const result = await createWorkspace({
      provider,
      repo_id: repoId,
      from: parsedFrom?.success ? parsedFrom.data : undefined,
      name_hint: nameHint,
      tags,
      metadata,
    });
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create workspace.';
    res.status(400).json({ error: 'workspace_create_failed', message });
  }
});

app.get('/api/workflows', async (_req, res) => {
  try {
    res.json(await listWorkflowDefinitions());
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list workflows.';
    res.status(500).json({ error: 'workflow_list_failed', message });
  }
});

app.get('/api/workflows/:id', async (req, res) => {
  try {
    const workflow = workflowDefinitionService.readDefinition(req.params.id);
    if (!workflow) {
      res.status(404).json({
        error: 'not_found',
        message: `Workflow "${req.params.id}" was not found.`,
      });
      return;
    }

    res.json({ workflow });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to read workflow.';
    res.status(500).json({ error: 'workflow_read_failed', message });
  }
});

app.post('/api/workflow-runs', async (req, res) => {
  const workflowId = readString(req.body?.workflow_id);
  const goalPrompt = readString(req.body?.goal_prompt);
  const repoId = readString(req.body?.repo_id) ?? undefined;
  const repoPathInput = readString(req.body?.repo_path);
  const repoPath = repoPathInput ? resolveActionPath(repoPathInput) : undefined;

  if (!workflowId) {
    res.status(400).json({ error: 'invalid_workflow_id', message: 'workflow_id is required.' });
    return;
  }

  if (!goalPrompt) {
    res.status(400).json({ error: 'invalid_goal_prompt', message: 'goal_prompt is required.' });
    return;
  }

  if (!repoId && !repoPath) {
    res.status(400).json({
      error: 'invalid_repo_input',
      message: 'repo_id or repo_path is required.',
    });
    return;
  }

  try {
    const result = await createWorkflowRun({
      workflow_id: workflowId,
      repo_id: repoId,
      repo_path: repoPath,
      goal_prompt: goalPrompt,
      tags: readStringArray(req.body?.tags),
      metadata: readStringMap(req.body?.metadata),
    });
    res.status(201).json({ detail: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create workflow run.';
    const status = /not found/i.test(message) ? 404 : /invalid/i.test(message) ? 400 : 400;
    res.status(status).json({ error: 'workflow_run_create_failed', message });
  }
});

app.get('/api/workflow-runs', async (_req, res) => {
  try {
    res.json(await listWorkflowRuns());
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to list workflow runs.';
    res.status(500).json({ error: 'workflow_run_list_failed', message });
  }
});

app.get('/api/workflow-runs/:id', async (req, res) => {
  try {
    const detail = await readWorkflowRun(req.params.id);
    if (!detail) {
      res.status(404).json({
        error: 'not_found',
        message: `Workflow run "${req.params.id}" was not found.`,
      });
      return;
    }

    res.json({ detail });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to read workflow run.';
    res.status(500).json({ error: 'workflow_run_read_failed', message });
  }
});

app.post('/api/workflow-runs/:id/gates/:gateId/answer', async (req, res) => {
  const optionId = readString(req.body?.option_id);
  const message = readString(req.body?.message) ?? undefined;

  if (!optionId) {
    res.status(400).json({ error: 'invalid_option_id', message: 'option_id is required.' });
    return;
  }

  try {
    const detail = await answerWorkflowGate({
      runId: req.params.id,
      gateId: req.params.gateId,
      optionId,
      message,
    });
    res.json({ detail });
  } catch (error) {
    const messageText = error instanceof Error ? error.message : 'Failed to answer workflow gate.';
    const status =
      /not found/i.test(messageText)
        ? 404
        : /not open|waiting on gate|requires|missing|does not define option|is in/i.test(messageText)
          ? 409
          : 400;
    res.status(status).json({ error: 'workflow_gate_answer_failed', message: messageText });
  }
});

app.get('/api/workflow-runs/:id/events', async (req, res) => {
  try {
    const detail = await readWorkflowRun(req.params.id);
    if (!detail) {
      res.status(404).json({
        error: 'not_found',
        message: `Workflow run "${req.params.id}" was not found.`,
      });
      return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to read workflow run.';
    res.status(500).json({ error: 'workflow_run_read_failed', message });
    return;
  }

  const { id: runId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const subscribers = workflowRunSubscribers.get(runId) ?? new Set<express.Response>();
  subscribers.add(res);
  workflowRunSubscribers.set(runId, subscribers);

  res.write(
    `data: ${JSON.stringify({
      method: 'workflow-run/connected',
      params: { runId },
    } satisfies WorkflowRunStreamEvent)}\n\n`,
  );

  const keepAlive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 15_000);

  req.on('close', () => {
    clearInterval(keepAlive);
    const currentSubscribers = workflowRunSubscribers.get(runId);
    currentSubscribers?.delete(res);
    if (!currentSubscribers || currentSubscribers.size === 0) {
      workflowRunSubscribers.delete(runId);
    }
    res.end();
  });
});

app.post('/api/workflow-runs/:id/planning-message', async (req, res) => {
  const message = readString(req.body?.message);
  if (!message) {
    res.status(400).json({ error: 'invalid_message', message: 'message is required.' });
    return;
  }

  try {
    const detail = await workflowRunService.sendPlanningMessage({
      runId: req.params.id,
      message,
    });
    res.json({ detail });
  } catch (error) {
    const messageText =
      error instanceof Error ? error.message : 'Failed to send planning message.';
    const status =
      /not found/i.test(messageText)
        ? 404
        : /only allowed|missing|requires/i.test(messageText)
          ? 409
          : 400;
    res.status(status).json({ error: 'workflow_planning_message_failed', message: messageText });
  }
});

app.get('/api/live-sessions/:threadId/events', async (req, res) => {
  try {
    await ensureAppServerStarted();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to start Codex app-server.';
    res.status(500).json({ error: 'live_session_unavailable', message });
    return;
  }

  const { threadId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const subscribers = liveSessionSubscribers.get(threadId) ?? new Set<express.Response>();
  subscribers.add(res);
  liveSessionSubscribers.set(threadId, subscribers);

  res.write(`data: ${JSON.stringify({ method: 'live/connected', params: { threadId } })}\n\n`);

  const keepAlive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 15_000);

  req.on('close', () => {
    clearInterval(keepAlive);
    const currentSubscribers = liveSessionSubscribers.get(threadId);
    currentSubscribers?.delete(res);
    if (!currentSubscribers || currentSubscribers.size === 0) {
      liveSessionSubscribers.delete(threadId);
    }
    res.end();
  });
});

app.post('/api/live-sessions/:threadId/approvals/:requestId/respond', async (req, res) => {
  const requestId = Number(req.params.requestId);
  const decision = req.body?.decision;

  if (!Number.isFinite(requestId)) {
    res.status(400).json({ error: 'invalid_request_id', message: 'Approval request id is invalid.' });
    return;
  }

  if (decision !== 'accept' && decision !== 'decline') {
    res.status(400).json({
      error: 'invalid_decision',
      message: 'Approval decision must be accept or decline.',
    });
    return;
  }

  try {
    const result = await respondToApproval({
      threadId: req.params.threadId,
      requestId,
      decision,
    });
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to answer approval request.';
    const status =
      /not found/i.test(message)
        ? 404
        : /already been answered/i.test(message)
          ? 409
          : 400;
    res.status(status).json({ error: 'approval_response_failed', message });
  }
});

app.post('/api/dev/reseed', async (_req, res) => {
  await clearImportedBundles(config.importedRoot);
  await executionStateStore.clear();
  const bundlePaths = await discoverBundleFiles(config.seedRoot);
  res.json({ imported: bundlePaths.length, reset_to_seed: true });
});

app.post('/api/dev/live-sessions/:threadId/approvals/inject', async (req, res) => {
  const approval = liveApprovalStore.injectSynthetic({
    threadId: req.params.threadId,
    kind: req.body?.kind === 'fileChange' ? 'fileChange' : 'commandExecution',
  });

  broadcastLiveSessionMessage(req.params.threadId, 'codex/serverRequest', {
    id: approval.request_id,
    method: approval.request_method,
    params: {
      threadId: approval.thread_id,
      turnId: approval.turn_id,
      itemId: approval.item_id,
      reason: approval.reason,
      command: approval.command,
      cwd: approval.cwd,
      commandActions: approval.command_actions,
      availableDecisions: approval.available_decisions,
      changes: approval.changes,
    },
  });

  res.json({ approval });
});

app.post('/api/dev/live-sessions/:threadId/approvals/:requestId/clear', async (req, res) => {
  const requestId = Number(req.params.requestId);
  if (!Number.isFinite(requestId)) {
    res.status(400).json({ error: 'invalid_request_id', message: 'Approval request id is invalid.' });
    return;
  }

  const approval = liveApprovalStore.resolve(req.params.threadId, requestId);
  if (!approval) {
    res.status(404).json({ error: 'not_found', message: 'Approval request not found.' });
    return;
  }

  broadcastLiveSessionMessage(req.params.threadId, 'serverRequest/resolved', {
    threadId: req.params.threadId,
    requestId,
  });

  res.json({ approval });
});

app.post('/api/change-units/:id/execute-next', async (req, res) => {
  try {
    const execution = await executeNext(req.params.id);
    res.json({ execution });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to execute next action.';
    const status =
      /not found/i.test(message)
        ? 404
        : /already launching|already been launched/i.test(message)
          ? 409
          : 400;
    res.status(status).json({ error: 'execute_failed', message });
  }
});

if (config.staticDir) {
  app.use(express.static(config.staticDir));
  app.get(/.*/, async (req, res, next) => {
    if (req.path.startsWith('/api') || req.path === '/health') {
      next();
      return;
    }

    try {
      const htmlPath = path.join(config.staticDir!, 'index.html');
      await fs.access(htmlPath);
      res.sendFile(htmlPath);
    } catch {
      res.status(404).send('missing static bundle');
    }
  });
}

app.listen(config.port, '127.0.0.1', () => {
  console.log(`Inbox server listening on http://127.0.0.1:${config.port}`);
});
