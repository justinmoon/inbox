import fs from 'node:fs/promises';
import path from 'node:path';

import express from 'express';

import type {
  ChangeUnitDetail,
  ChangeUnitExecutionLaunched,
  ExecuteNextActionResult,
} from '../shared/api.ts';
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

const config = readConfig(process.env);
const appServer = new AppServerProcess({ codexBin: config.codexBin });
const executionStateStore = new ExecutionStateStore(config.runtimeRoot);

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
      void appServer.respondError(id, 'Interactive approvals are not supported by inbox.');
    });
  }

  try {
    await appServerReady;
  } finally {
    appServerReady = null;
  }
}

function resolveActionPath(rawPath: string) {
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);
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

  try {
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

    const turnResult = await appServer.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: action.prompt, textElements: [] }],
      cwd: action.cwd ? resolveActionPath(action.cwd) : null,
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
      message:
        threadSource === 'forked'
          ? 'Started a forked Codex thread for the next chunk.'
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

app.post('/api/dev/reseed', async (_req, res) => {
  await clearImportedBundles(config.importedRoot);
  await executionStateStore.clear();
  const bundlePaths = await discoverBundleFiles(config.seedRoot);
  res.json({ imported: bundlePaths.length, reset_to_seed: true });
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
