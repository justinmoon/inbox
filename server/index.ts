import fs from 'node:fs/promises';
import path from 'node:path';

import express from 'express';

import { createLiveChangeUnitRequestSchema } from '../shared/liveChangeUnit.ts';
import { CodexAppServer, mapCodexThreadToSessionUpdate } from './codexAppServer.ts';
import { readConfig } from './config.ts';
import { discoverBundleFiles, loadBundleFromPath } from './importBundles.ts';
import { createLiveChangeUnitBundle } from './liveChangeUnits.ts';
import { InboxDatabase } from './storage.ts';

const config = readConfig(process.env);
const db = new InboxDatabase(config.dbPath);

async function seedIfEmpty() {
  if (db.hasChangeUnits()) return;
  const bundlePaths = await discoverBundleFiles(config.seedRoot);
  for (const bundlePath of bundlePaths) {
    db.importBundle(await loadBundleFromPath(bundlePath));
  }
}

await seedIfEmpty();

const app = express();
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/change-units', (_req, res) => {
  res.json({ items: db.listChangeUnits() });
});

app.get('/api/change-units/:id', (req, res) => {
  const detail = db.getChangeUnitDetail(req.params.id);
  if (!detail) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({ detail });
});

app.post('/api/import-bundle', async (req, res) => {
  const bundlePath = typeof req.body?.path === 'string' ? req.body.path : null;
  if (!bundlePath) {
    res.status(400).json({ error: 'missing_path' });
    return;
  }

  const resolvedPath = path.resolve(process.cwd(), bundlePath);
  try {
    const bundle = await loadBundleFromPath(resolvedPath);
    db.importBundle(bundle);
    res.json({ imported: bundle.change_unit.id, path: resolvedPath });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to import bundle';
    res.status(400).json({ error: 'import_failed', message });
  }
});

app.post('/api/live/change-units', async (req, res) => {
  try {
    const input = createLiveChangeUnitRequestSchema.parse(req.body);
    const created = await createLiveChangeUnitBundle(input, {
      generatedBundleRoot: config.generatedBundleRoot,
      codexSdkPath: config.codexSdkPath,
    });
    db.importBundle(created.bundle);
    res.json(created.response);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create live change unit.';
    res.status(400).json({ error: 'live_change_unit_failed', message });
  }
});

app.post('/api/dev/reseed', async (_req, res) => {
  const bundlePaths = await discoverBundleFiles(config.seedRoot);
  db.clearAll();
  for (const bundlePath of bundlePaths) {
    db.importBundle(await loadBundleFromPath(bundlePath));
  }
  res.json({ imported: bundlePaths.length });
});

app.post('/api/change-units/:id/sessions/:sessionId/refresh-codex', async (req, res) => {
  const detail = db.getChangeUnitDetail(req.params.id);
  if (!detail) {
    res.status(404).json({ error: 'change_unit_not_found' });
    return;
  }

  const session = detail.agent_sessions.find((candidate) => candidate.id === req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: 'session_not_found' });
    return;
  }

  if (!session.thread_id) {
    res.status(400).json({ error: 'missing_thread_id', message: 'Session has no linked Codex thread id.' });
    return;
  }

  const appServer = new CodexAppServer();
  try {
    const thread = await appServer.readThread(session.thread_id);
    const update = mapCodexThreadToSessionUpdate(thread);
    db.updateAgentSessionFromCodex(session.id, {
      ...update,
      codex_sync: {
        source: 'codex_refresh',
        source_thread_status: update.source_thread_status,
        imported_turn_count: update.imported_turn_count,
        imported_item_count: update.imported_item_count,
        last_attempted_at: update.updated_at,
        last_succeeded_at: update.updated_at,
      },
    });
    res.json({
      refreshed: session.id,
      thread_id: session.thread_id,
      codex_sync: {
        source: 'codex_refresh',
        source_thread_status: update.source_thread_status,
        imported_turn_count: update.imported_turn_count,
        imported_item_count: update.imported_item_count,
        last_attempted_at: update.updated_at,
        last_succeeded_at: update.updated_at,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to refresh from Codex.';
    db.recordAgentSessionCodexRefreshFailure(session.id, {
      codex_sync: {
        ...(session.codex_sync ?? { source: 'bundle_import' }),
        source: 'codex_refresh',
        last_attempted_at: new Date().toISOString(),
        last_error: message,
      },
      updated_at: new Date().toISOString(),
    });
    res.status(502).json({ error: 'codex_refresh_failed', message });
  } finally {
    await appServer.stop();
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
