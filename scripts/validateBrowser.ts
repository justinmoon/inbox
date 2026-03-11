import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const port = process.env.PORT ?? String(8800 + Math.floor(Math.random() * 200));
const baseUrl = `http://127.0.0.1:${port}`;
const validationRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'inbox-validate-'));
const importedRoot = path.join(validationRoot, 'imported-change-units');
const runtimeRoot = path.join(validationRoot, 'runtime');
const canonicalBundlePath = path.join(
  process.cwd(),
  'seed/change-units/validation-rollup-checkpoint/change-unit.json',
);

type BundleLike = Record<string, any>;

const workflowValidationNoteFile = 'workflow-runtime-validation-note.md';
const workflowValidationNoteBody = 'workflow runtime browser validation';

async function runCommandIn(
  cwd: string,
  command: string,
  args: string[],
  captureOutput = false,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: captureOutput ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      reject(new Error(stderr.trim() || `${command} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

async function runCommand(command: string, args: string[], captureOutput = false): Promise<string> {
  return await runCommandIn(process.cwd(), command, args, captureOutput);
}

async function runBrowser(args: string[], captureOutput = false): Promise<string> {
  return await runCommand('npx', ['agent-browser', ...args], captureOutput);
}

async function browserEval(source: string, captureOutput = false) {
  return await runBrowser(['eval', source], captureOutput);
}

function readEvalString(output: string) {
  const trimmed = output.trim();
  if (!trimmed) return '';

  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === 'string' ? parsed : String(parsed);
  } catch {
    return trimmed;
  }
}

async function waitForHealth(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Server still starting.
    }

    await delay(500);
  }

  throw new Error('Timed out waiting for the server health endpoint.');
}

function assertIncludes(haystack: string, needle: string, description: string) {
  if (!haystack.includes(needle)) {
    throw new Error(`Expected output to include "${needle}" (${description}).`);
  }
}

function detectPageErrors(output: string) {
  const normalized = output.trim();
  if (!normalized) return;
  if (/no page errors/i.test(normalized)) return;
  if (/page errors:\s*0/i.test(normalized)) return;
  throw new Error(`Browser reported page errors:\n${normalized}`);
}

async function waitForChildExit(child: ReturnType<typeof spawn>, timeoutMs: number) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for child process ${child.pid ?? 'unknown'} to exit.`));
    }, timeoutMs);

    const onExit = () => {
      cleanup();
      resolve();
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', onError);
    };

    child.on('exit', onExit);
    child.on('error', onError);
  });
}

async function stopServerProcess(server: ReturnType<typeof spawn>) {
  if (server.exitCode !== null || server.signalCode !== null) {
    return;
  }

  const signalProcessTree = (signal: NodeJS.Signals) => {
    if (server.pid == null) {
      server.kill(signal);
      return;
    }

    try {
      process.kill(-server.pid, signal);
    } catch {
      server.kill(signal);
    }
  };

  signalProcessTree('SIGTERM');
  try {
    await waitForChildExit(server, 5_000);
    return;
  } catch {
    // Escalate below.
  }

  if (server.exitCode === null && server.signalCode === null) {
    signalProcessTree('SIGKILL');
  }
  await waitForChildExit(server, 5_000).catch(() => undefined);
}

async function postJson<T>(pathname: string, body?: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    throw new Error(String(payload?.message ?? `Request failed with ${response.status}`));
  }

  return payload as T;
}

async function getJson<T>(pathname: string): Promise<T> {
  const response = await fetch(`${baseUrl}${pathname}`);
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    throw new Error(String(payload?.message ?? `Request failed with ${response.status}`));
  }
  return payload as T;
}

async function createWorkflowValidationRepo() {
  const repoPath = path.join(validationRoot, 'workflow-runtime-validation-repo');
  await fs.rm(repoPath, { recursive: true, force: true });
  await fs.mkdir(repoPath, { recursive: true });
  await fs.writeFile(
    path.join(repoPath, 'README.md'),
    [
      '# Workflow Runtime Validation Repo',
      '',
      'This tiny repository exists so browser validation can exercise the workflow runtime end to end.',
    ].join('\n'),
    'utf8',
  );
  await runCommandIn(repoPath, 'git', ['init', '-b', 'main']);
  await runCommandIn(repoPath, 'git', ['config', 'user.name', 'Inbox Validate']);
  await runCommandIn(repoPath, 'git', ['config', 'user.email', 'validate@inbox.local']);
  await runCommandIn(repoPath, 'git', ['add', 'README.md']);
  await runCommandIn(repoPath, 'git', ['commit', '-m', 'Initial validation repo']);
  return repoPath;
}

async function gitStatusShort(repoPath: string) {
  return await runCommandIn(repoPath, 'git', ['status', '--short'], true);
}

async function assertSurfaceLoaded(expectedTitle: string, expectedStepTitles: string[]) {
  await runBrowser(['wait', '--text', expectedTitle]);

  await browserEval(
    [
      `const expectedTitle = ${JSON.stringify(expectedTitle)};`,
      `const expectedSteps = ${JSON.stringify(expectedStepTitles)};`,
      "const cards = [...document.querySelectorAll('.simple-queue-card')];",
      "if (cards.length < 1) throw new Error('Expected a non-empty queue.');",
      "if (document.querySelector('.banner-error')) throw new Error('Recovery should not leave an error banner on screen.');",
      "const title = document.querySelector('.review-brief h2')?.textContent?.trim();",
      "if (title !== expectedTitle) throw new Error(`Expected review title ${expectedTitle}, saw ${title}.`);",
      "const stepTabs = [...document.querySelectorAll('.stepper-tab')];",
      "const stepTitles = stepTabs.map((node) => node.getAttribute('data-step-title') ?? node.textContent?.trim() ?? '');",
      "if (stepTitles.length !== expectedSteps.length) {",
      "  throw new Error(`Expected ${expectedSteps.length} tutorial steps, saw ${stepTitles.length}.`);",
      '}',
      "for (let index = 0; index < expectedSteps.length; index += 1) {",
      "  if (stepTitles[index] !== expectedSteps[index]) {",
      "    throw new Error(`Expected step ${index + 1} to be ${expectedSteps[index]}, saw ${stepTitles[index]}.`);",
      '  }',
      '}',
      "if (!document.querySelector('.tutorial-step-card')) throw new Error('Tutorial step card is missing.');",
      "if (!document.querySelector('.replay-panel')) throw new Error('Replay panel is missing.');",
      "if (document.querySelectorAll('.session-tab').length < 1) throw new Error('Expected at least one Codex session tab.');",
      "if (!document.querySelector('.codex-thread-viewer')) throw new Error('Codex thread viewer is missing.');",
      "if (!document.querySelector('[data-thread-viewer-model=\"codex-native\"]')) throw new Error('Expected Codex-native thread viewer model marker.');",
      "if (!document.body.textContent?.includes('Diff')) throw new Error('Diff section is missing.');",
    ].join(' '),
  );
}

async function assertSelectedStep(title: string, index: number) {
  await browserEval(
    [
      '(async () => {',
      `  const target = document.querySelectorAll('.stepper-tab')[${index}];`,
      "  if (!(target instanceof HTMLElement)) throw new Error('Missing target step tab.');",
      "  target.dispatchEvent(new MouseEvent('click', { bubbles: true }));",
      '  await new Promise((resolve) => window.setTimeout(resolve, 100));',
      `  const expectedTitle = ${JSON.stringify(title)};`,
      "  const heading = document.querySelector('.tutorial-step-card h4')?.textContent?.trim();",
      "  if (heading !== expectedTitle) {",
      "    throw new Error(`Expected tutorial heading ${expectedTitle}, saw ${heading}.`);",
      '  }',
      '})()',
    ].join(' '),
  );
}

async function pressKey(key: string, options?: { shiftKey?: boolean }) {
  await browserEval(
    [
      '(async () => {',
      `  const key = ${JSON.stringify(key)};`,
      `  const shiftKey = ${JSON.stringify(Boolean(options?.shiftKey))};`,
      "  window.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }));",
      '  await new Promise((resolve) => window.setTimeout(resolve, 180));',
      '})()',
    ].join(' '),
  );
}

async function assertReplayWorkspaceControls() {
  await browserEval(
    [
      '(async () => {',
      "  const rightColumn = document.querySelector('.right-column');",
      "  const shell = document.querySelector('.app-shell');",
      "  if (!(rightColumn instanceof HTMLElement) || !(shell instanceof HTMLElement)) {",
      "    throw new Error('Missing app shell or replay column for workspace validation.');",
      '  }',
      '  const initialWidth = Math.round(rightColumn.getBoundingClientRect().width);',
      '  if (initialWidth < 280) throw new Error(`Replay pane is unexpectedly narrow: ${initialWidth}px.`);',
      "  window.__inboxInitialReplayWidth = initialWidth;",
      '})()',
    ].join(' '),
  );

  await pressKey('L', { shiftKey: true });
  await browserEval(
    [
      '(async () => {',
      "  const rightColumn = document.querySelector('.right-column');",
      "  const shell = document.querySelector('.app-shell');",
      "  const initialWidth = Number(window.__inboxInitialReplayWidth ?? 0);",
      "  if (!(rightColumn instanceof HTMLElement) || !(shell instanceof HTMLElement)) {",
      "    throw new Error('Replay pane width controls are missing.');",
      '  }',
      '  const deadline = Date.now() + 4000;',
      '  while (Date.now() < deadline) {',
      '    const nextWidth = Math.round(rightColumn.getBoundingClientRect().width);',
      "    const storedWidth = window.localStorage.getItem('inbox.replayPaneWidth');",
      "    if (nextWidth > initialWidth && storedWidth === shell.getAttribute('data-replay-pane-width')) {",
      '      window.__inboxGrownReplayWidth = nextWidth;',
      '      return;',
      '    }',
      '    await new Promise((resolve) => window.setTimeout(resolve, 120));',
      '  }',
      "  throw new Error('Replay pane did not grow after Shift+L.');",
      '})()',
    ].join(' '),
  );

  await pressKey('H', { shiftKey: true });
  await browserEval(
    [
      '(async () => {',
      "  const rightColumn = document.querySelector('.right-column');",
      "  const shell = document.querySelector('.app-shell');",
      "  const grownWidth = Number(window.__inboxGrownReplayWidth ?? 0);",
      "  if (!(rightColumn instanceof HTMLElement) || !(shell instanceof HTMLElement)) {",
      "    throw new Error('Replay pane width controls are missing after shrink.');",
      '  }',
      '  const deadline = Date.now() + 4000;',
      '  while (Date.now() < deadline) {',
      '    const nextWidth = Math.round(rightColumn.getBoundingClientRect().width);',
      "    if (nextWidth < grownWidth && window.localStorage.getItem('inbox.replayPaneWidth') === shell.getAttribute('data-replay-pane-width')) {",
      '      return;',
      '    }',
      '    await new Promise((resolve) => window.setTimeout(resolve, 120));',
      '  }',
      "  throw new Error('Replay pane did not shrink after Shift+H.');",
      '})()',
    ].join(' '),
  );

  await pressKey(']');
  await browserEval(
    [
      '(async () => {',
      '  const deadline = Date.now() + 3000;',
      '  while (Date.now() < deadline) {',
      "    const activeRole = document.querySelector('.replay-panel')?.getAttribute('data-active-session-role');",
      "    if (activeRole === 'implementer') return;",
      '    await new Promise((resolve) => window.setTimeout(resolve, 120));',
      '  }',
      "  throw new Error('Next-session hotkey did not switch to the implementer session.');",
      '})()',
    ].join(' '),
  );

  await pressKey('[');
  await browserEval(
    [
      '(async () => {',
      '  const deadline = Date.now() + 3000;',
      '  while (Date.now() < deadline) {',
      "    const activeRole = document.querySelector('.replay-panel')?.getAttribute('data-active-session-role');",
      "    if (activeRole === 'planner') return;",
      '    await new Promise((resolve) => window.setTimeout(resolve, 120));',
      '  }',
      "  throw new Error('Previous-session hotkey did not return to the planner session.');",
      '})()',
    ].join(' '),
  );
}

async function assertThemeControls() {
  await browserEval(
    [
      '(async () => {',
      "  const root = document.documentElement;",
      "  if (root.dataset.theme !== 'tokyo-night') {",
      "    throw new Error(`Expected default theme to be tokyo-night, saw ${root.dataset.theme}.`);",
      '  }',
      "  const toggle = document.querySelector('[data-theme-toggle=\"true\"]');",
      "  if (!(toggle instanceof HTMLElement)) throw new Error('Theme toggle is missing.');",
      '  toggle.click();',
      '  await new Promise((resolve) => window.setTimeout(resolve, 120));',
      "  const nordOption = document.querySelector('[data-theme-option=\"nord\"]');",
      "  if (!(nordOption instanceof HTMLElement)) throw new Error('Nord theme option is missing.');",
      '  nordOption.click();',
      '  await new Promise((resolve) => window.setTimeout(resolve, 120));',
      "  if (root.dataset.theme !== 'nord') throw new Error(`Expected theme to switch to nord, saw ${root.dataset.theme}.`);",
      "  if (window.localStorage.getItem('inbox.theme') !== 'nord') throw new Error('Theme selection did not persist to localStorage.');",
      '})()',
    ].join(' '),
  );

  await runBrowser(['open', baseUrl]);
  await browserEval(
    [
      "const root = document.documentElement;",
      "if (root.dataset.theme !== 'nord') throw new Error(`Expected persisted theme to stay nord after reload, saw ${root.dataset.theme}.`);",
    ].join(' '),
  );
}

async function assertReplayWidthPersists(expectedChangeId: string) {
  await runBrowser(['open', `${baseUrl}/?change=${expectedChangeId}`]);
  await browserEval(
    [
      '(async () => {',
      "  const shell = document.querySelector('.app-shell');",
      "  if (!(shell instanceof HTMLElement)) throw new Error('Missing app shell after reload.');",
      "  const storedWidth = window.localStorage.getItem('inbox.replayPaneWidth');",
      "  if (!storedWidth) throw new Error('Expected stored replay width before reload.');",
      '  const deadline = Date.now() + 4000;',
      '  while (Date.now() < deadline) {',
      "    if (shell.getAttribute('data-replay-pane-width') === storedWidth) return;",
      '    await new Promise((resolve) => window.setTimeout(resolve, 120));',
      '  }',
      "  throw new Error(`Replay pane width did not persist after reload. Expected ${storedWidth}, saw ${shell.getAttribute('data-replay-pane-width')}.`);",
      '})()',
    ].join(' '),
  );
}

async function assertSessionWallMode(expectedRoles: string[]) {
  await pressKey('r');
  await browserEval(
    [
      '(async () => {',
      `  const expectedRoles = ${JSON.stringify(expectedRoles)};`,
      '  const deadline = Date.now() + 4000;',
      '  while (Date.now() < deadline) {',
      "    const wall = document.querySelector('.session-wall');",
      "    const columns = [...document.querySelectorAll('[data-wall-session-role]')];",
      "    const review = document.querySelector('.review-surface');",
      "    const queue = document.querySelector('.inbox-rail');",
      "    if (wall && !review && !queue && columns.length >= expectedRoles.length) {",
      "      const roles = columns.map((node) => node.getAttribute('data-wall-session-role'));",
      '      for (const role of expectedRoles) {',
      "        if (!roles.includes(role)) throw new Error(`Missing wall column for ${role}.`);",
      '      }',
      '      return;',
      '    }',
      '    await new Promise((resolve) => window.setTimeout(resolve, 120));',
      '  }',
      "  throw new Error('Session wall mode did not replace the normal review cockpit.');",
      '})()',
    ].join(' '),
  );

  await browserEval(
    [
      '(async () => {',
      "  const preferred = document.querySelector('[data-wall-session-role=\"implementer\"]');",
      "  if (preferred instanceof HTMLElement) preferred.click();",
      '  await new Promise((resolve) => window.setTimeout(resolve, 120));',
      "  const active = document.querySelector('[data-wall-column-active=\"true\"]');",
      "  if (!active) throw new Error('Expected an active wall column.');",
      "  window.__wallInitialRole = active.getAttribute('data-wall-session-role');",
      "  const scrollTarget = active.querySelector('.session-wall-column-scroll');",
      "  if (!(scrollTarget instanceof HTMLElement)) throw new Error('Missing wall scroll target.');",
      '  scrollTarget.scrollTo({ top: 160 });',
      '  await new Promise((resolve) => window.setTimeout(resolve, 120));',
      "  window.__wallScrolledBefore = scrollTarget.scrollTop;",
      '})()',
    ].join(' '),
  );

  await pressKey('l');
  await browserEval(
    [
      '(async () => {',
      '  const deadline = Date.now() + 3000;',
      '  while (Date.now() < deadline) {',
      "    const active = document.querySelector('[data-wall-column-active=\"true\"]');",
      "    const role = active?.getAttribute('data-wall-session-role');",
      "    if (role && role !== window.__wallInitialRole) {",
      '      window.__wallNextRole = role;',
      '      return;',
      '    }',
      '    await new Promise((resolve) => window.setTimeout(resolve, 120));',
      '  }',
      "  throw new Error('Wall next-column hotkey did not move the active column.');",
      '})()',
    ].join(' '),
  );

  await pressKey('h');
  await browserEval(
    [
      '(async () => {',
      '  const deadline = Date.now() + 3000;',
      '  while (Date.now() < deadline) {',
      "    const active = document.querySelector('[data-wall-column-active=\"true\"]');",
      "    const role = active?.getAttribute('data-wall-session-role');",
      "    if (role === window.__wallInitialRole) return;",
      '    await new Promise((resolve) => window.setTimeout(resolve, 120));',
      '  }',
      "  throw new Error('Wall previous-column hotkey did not restore the prior active column.');",
      '})()',
    ].join(' '),
  );

  await pressKey('j');
  await browserEval(
    [
      '(async () => {',
      '  const deadline = Date.now() + 4000;',
      '  while (Date.now() < deadline) {',
      "    const active = document.querySelector('[data-wall-column-active=\"true\"] .session-wall-column-scroll');",
      "    if (active instanceof HTMLElement && active.scrollTop > Number(window.__wallScrolledBefore ?? 0)) return;",
      '    await new Promise((resolve) => window.setTimeout(resolve, 120));',
      '  }',
      "  throw new Error('Wall down-scroll hotkey did not move the active column.');",
      '})()',
    ].join(' '),
  );

  await pressKey('g');
  await browserEval(
    [
      '(async () => {',
      '  const deadline = Date.now() + 4000;',
      '  while (Date.now() < deadline) {',
      "    const active = document.querySelector('[data-wall-column-active=\"true\"] .session-wall-column-scroll');",
      "    if (active instanceof HTMLElement && active.scrollTop <= 2) return;",
      '    await new Promise((resolve) => window.setTimeout(resolve, 120));',
      '  }',
      "  throw new Error('Wall top-jump hotkey did not reset scroll.');",
      '})()',
    ].join(' '),
  );

  await pressKey('G', { shiftKey: true });
  await browserEval(
    [
      '(async () => {',
      '  const deadline = Date.now() + 4000;',
      '  while (Date.now() < deadline) {',
      "    const active = document.querySelector('[data-wall-column-active=\"true\"] .session-wall-column-scroll');",
      "    if (active instanceof HTMLElement && active.scrollTop + active.clientHeight >= active.scrollHeight - 6) return;",
      '    await new Promise((resolve) => window.setTimeout(resolve, 120));',
      '  }',
      "  throw new Error('Wall bottom-jump hotkey did not reach the end of the active column.');",
      '})()',
    ].join(' '),
  );

  await pressKey('Escape');
  await browserEval(
    [
      '(async () => {',
      '  const deadline = Date.now() + 4000;',
      '  while (Date.now() < deadline) {',
      "    if (document.querySelector('.app-shell') && document.querySelector('.review-surface') && !document.querySelector('.session-wall')) return;",
      '    await new Promise((resolve) => window.setTimeout(resolve, 120));',
      '  }',
      "  throw new Error('Esc should exit session wall mode back to the review cockpit.');",
      '})()',
    ].join(' '),
  );
}

async function assertExecutionLaunched() {
  await runBrowser(['wait', '--text', 'Next chunk started']);
  await browserEval(
    [
      "const actionState = document.querySelector('[data-execution-state=\"launched\"]');",
      "if (!actionState) throw new Error('Expected launched execution state.');",
      "const openButton = document.querySelector('[data-open-live-session=\"true\"]');",
      "if (!(openButton instanceof HTMLElement)) throw new Error('Open Live Session CTA is missing.');",
      "const executionCodes = [...document.querySelectorAll('.execution-record .execution-metadata code')].map((node) => node.textContent?.trim() ?? '');",
      "if (!executionCodes[0]) throw new Error('Expected launched thread id in the action area.');",
      "if (!executionCodes.some((value) => value.includes('/workspaces/'))) {",
      "  throw new Error('Expected launched workspace path in the action area.');",
      '}',
      "const strategyText = document.querySelector('.execution-record')?.textContent ?? '';",
      "if (!strategyText.includes('shared-store-worktree')) throw new Error('Expected launched workspace strategy in the action area.');",
      "openButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));",
    ].join(' '),
  );

  await runBrowser(['wait', '--text', 'Live Session']);
  await browserEval(
    [
      '(async () => {',
      "const liveTab = document.querySelector('[data-session-source=\"live\"]');",
      "if (!(liveTab instanceof HTMLElement)) throw new Error('Expected a live session tab after launch.');",
      "const activeView = document.querySelector('[data-session-view=\"live\"]');",
      "if (!activeView) throw new Error('Expected the live session view to be active.');",
      "const liveMetadata = [...document.querySelectorAll('.live-session-metadata code')].map((node) => node.textContent?.trim() ?? '');",
      "if (liveMetadata.length < 1 || !liveMetadata[0]) {",
      "  throw new Error('Expected launched turn metadata in the live session panel.');",
      '}',
      "if (!liveMetadata.some((value) => value.includes('/workspaces/'))) {",
      "  throw new Error('Expected launched workspace metadata in the live session panel.');",
      '}',
      "if (!document.querySelector('[data-thread-viewer-model=\"codex-native\"]')) throw new Error('Expected the live session to render through the Codex-native thread viewer.');",
      '  const deadline = Date.now() + 10000;',
      '  while (Date.now() < deadline) {',
      "    const liveUpdate = document.querySelector('[data-live-update-mode]');",
      "    const mode = liveUpdate?.getAttribute('data-live-update-mode');",
      "    const count = Number(liveUpdate?.getAttribute('data-live-update-count') ?? '0');",
      "    const lastMethod = document.querySelector('.live-session-metadata')?.textContent ?? '';",
      "    if (mode === 'events' || mode === 'polling' || count > 0 || lastMethod.includes('item/') || lastMethod.includes('turn/')) return;",
      '    await new Promise((resolve) => window.setTimeout(resolve, 200));',
      '  }',
      "  throw new Error('Expected live session auto-update transport to become active after execution started.');",
      '})()',
    ].join(' '),
  );
}

async function assertExecutionFailed() {
  await runBrowser(['wait', '--text', 'Next chunk failed']);
  await browserEval(
    [
      "const failedState = document.querySelector('[data-execution-state=\"failed\"]');",
      "if (!failedState) throw new Error('Expected failed execution state.');",
      "const retryButton = [...document.querySelectorAll('button')].find((node) => node.textContent?.includes('Retry Execute Next Prompt'));",
      "if (!retryButton) throw new Error('Retry action is missing after failed launch.');",
      "const errorCopy = document.querySelector('.execution-error')?.textContent?.trim();",
      "if (!errorCopy) throw new Error('Expected a real execute-next failure message.');",
    ].join(' '),
  );
}

async function injectApproval(kind: 'commandExecution' | 'fileChange') {
  const threadId = readEvalString(
    await browserEval(
      "document.querySelector('.thread-metadata code')?.textContent?.trim() ?? '';",
      true,
    ),
  );
  if (!threadId) {
    throw new Error('Expected a live thread id before injecting an approval fixture.');
  }

  const payload = await postJson<{ approval: { request_id: number; thread_id: string } }>(
    `/api/dev/live-sessions/${encodeURIComponent(threadId)}/approvals/inject`,
    { kind },
  );

  return payload.approval;
}

async function clearApproval(requestId: number, threadId: string) {
  await postJson(`/api/dev/live-sessions/${encodeURIComponent(threadId)}/approvals/${requestId}/clear`);
}

async function assertApprovalCard(
  kind: 'commandExecution' | 'fileChange',
  status: 'pending' | 'answered' | 'cleared',
  requestId: number,
) {
  await browserEval(
    [
      '(async () => {',
      `  const kind = ${JSON.stringify(kind)};`,
      `  const status = ${JSON.stringify(status)};`,
      `  const requestId = ${JSON.stringify(String(requestId))};`,
      '  const deadline = Date.now() + 10000;',
      '  let card = null;',
      '  while (Date.now() < deadline) {',
      "    card = document.querySelector(`[data-approval-kind=\"${kind}\"][data-approval-status=\"${status}\"][data-approval-request-id=\"${requestId}\"]`);",
      '    if (card) break;',
      '    await new Promise((resolve) => window.setTimeout(resolve, 200));',
      '  }',
      "  if (!card) throw new Error(`Missing approval card for ${kind} with status ${status} and request ${requestId}.`);",
      "  if (!card.textContent?.includes('Thread')) throw new Error('Approval card should show thread details.');",
      "  if (!card.textContent?.includes('Turn')) throw new Error('Approval card should show turn details.');",
      "  if (!card.textContent?.includes('Item')) throw new Error('Approval card should show item details.');",
      "  if (kind === 'commandExecution' && !card.textContent?.includes('npm test -- --runInBand')) {",
      "    throw new Error('Command approval should show the proposed command.');",
      '  }',
      "  if (kind === 'fileChange' && !card.textContent?.includes('src/validation.js')) {",
      "    throw new Error('File change approval should show the proposed file path.');",
      '  }',
      "  if (status === 'cleared' && card.textContent?.includes('Declined')) {",
      "    throw new Error('Cleared approval should not render as declined.');",
      '  }',
      '})()',
    ].join(' '),
  );
}

async function answerApproval(
  kind: 'commandExecution' | 'fileChange',
  requestId: number,
  decision: 'accept' | 'decline',
) {
  await browserEval(
    [
      '(async () => {',
      `  const kind = ${JSON.stringify(kind)};`,
      `  const requestId = ${JSON.stringify(String(requestId))};`,
      `  const decision = ${JSON.stringify(decision)};`,
      "  const selector = `[data-approval-kind=\"${kind}\"][data-approval-status=\"pending\"][data-approval-request-id=\"${requestId}\"]`;",
      '  const deadline = Date.now() + 10000;',
      '  let card = null;',
      '  while (Date.now() < deadline) {',
      '    card = document.querySelector(selector);',
      '    if (card) break;',
      '    await new Promise((resolve) => window.setTimeout(resolve, 200));',
      '  }',
      "  if (!card) throw new Error(`Missing pending approval for ${kind} request ${requestId}.`);",
      "  const button = [...card.querySelectorAll('button')].find((node) => node.textContent?.trim() === (decision === 'accept' ? 'Accept' : 'Decline'));",
      "  if (!(button instanceof HTMLElement)) throw new Error(`Missing ${decision} button for ${kind}.`);",
      "  button.click();",
      '  await new Promise((resolve) => window.setTimeout(resolve, 300));',
      '})()',
    ].join(' '),
  );

  await browserEval(
    [
      '(async () => {',
      `  const kind = ${JSON.stringify(kind)};`,
      `  const requestId = ${JSON.stringify(String(requestId))};`,
      `  const expected = ${JSON.stringify(decision === 'accept' ? 'Accepted' : 'Declined')};`,
      '  const deadline = Date.now() + 10000;',
      '  while (Date.now() < deadline) {',
      "    const card = document.querySelector(`[data-approval-kind=\"${kind}\"][data-approval-status=\"answered\"][data-approval-request-id=\"${requestId}\"]`);",
      "    if (card && card.textContent?.includes(expected)) return;",
      '    await new Promise((resolve) => window.setTimeout(resolve, 200));',
      '  }',
      "  throw new Error(`Approval ${kind} request ${requestId} did not transition to answered state.`);",
      '})()',
    ].join(' '),
  );
}

async function assertCodexReplayKinds(role: string, expectedKinds: string[]) {
  await browserEval(
    [
      '(async () => {',
      `  const role = ${JSON.stringify(role)};`,
      `  const expectedKinds = ${JSON.stringify(expectedKinds)};`,
      "  const tab = document.querySelector(`[data-session-role=\"${role}\"]`);",
      "  if (!(tab instanceof HTMLElement)) throw new Error(`Missing session tab for ${role}.`);",
      "  tab.dispatchEvent(new MouseEvent('click', { bubbles: true }));",
      '  await new Promise((resolve) => window.setTimeout(resolve, 150));',
      "  if (!document.querySelector('.codex-thread-viewer')) throw new Error('Missing Codex thread viewer after selecting session.');",
      "  const seenKinds = new Set([...document.querySelectorAll('[data-item-type]')].map((node) => node.getAttribute('data-item-type')));",
      '  for (const kind of expectedKinds) {',
      "    if (!seenKinds.has(kind)) throw new Error(`Expected replay surface to render ${kind} for ${role}.`);",
      '  }',
      "  if (expectedKinds.includes('fileChange')) {",
      "    if (!document.querySelector('.thread-file-change-entry')) {",
      "      throw new Error('Expected readable file change entries instead of a raw blob.');",
      '    }',
      "    if (!document.querySelector('.thread-patch-block')) {",
      "      throw new Error('Expected file change patch text to render.');",
      '    }',
      "    const fileChangeText = document.querySelector('[data-item-type=\"fileChange\"]')?.textContent ?? '';",
      "    if (fileChangeText.includes('\\\\\"path\\\\\"') || fileChangeText.includes('{\"path\"')) {",
      "      throw new Error('File change item still looks like escaped JSON.');",
      '    }',
      '  }',
      "  if (!document.querySelector('[data-thread-viewer-model=\"codex-native\"]')) {",
      "    throw new Error('Expected shared Codex-native viewer model.');",
      '  }',
      '})()',
    ].join(' '),
  );
}

async function assertWorkspaceSubsystem() {
  const ensured = await postJson<{
    repository: {
      id: string;
      source: string;
      backing_store_path: string;
      visible_root_path: string;
      visible_trunk_path: string;
      trunk_workspace_id: string;
    };
    trunk_workspace: {
      id: string;
      path: string;
      strategy: string;
    };
  }>('/api/repos/ensure', {
    id: 'validation-rollup-example',
    source: '.',
    metadata: { validation: 'true' },
  });

  const repo = ensured.repository;
  const trunkWorkspace = ensured.trunk_workspace;
  if (!repo.visible_trunk_path.includes('/workspaces/')) {
    throw new Error(`Expected visible trunk workspace path under /workspaces/, saw ${repo.visible_trunk_path}.`);
  }
  if (repo.visible_trunk_path.startsWith(repo.backing_store_path)) {
    throw new Error('Visible trunk workspace should not live inside the hidden backing store.');
  }
  if (trunkWorkspace.path !== repo.visible_trunk_path) {
    throw new Error('Trunk workspace path should match the repository visible trunk path.');
  }

  const created = await postJson<{
    repository: { id: string; backing_store_path: string };
    workspace: { id: string; path: string; repo_id: string; strategy: string };
  }>('/api/workspaces', {
    repo_id: repo.id,
    name_hint: 'manual-peer',
    tags: ['validate'],
    metadata: { purpose: 'validation' },
  });

  if (created.workspace.repo_id !== repo.id) {
    throw new Error('Created workspace should belong to the ensured repository.');
  }
  if (created.workspace.strategy !== 'shared-store-worktree') {
    throw new Error(`Expected shared-store-worktree workspace strategy, saw ${created.workspace.strategy}.`);
  }
  if (path.dirname(created.workspace.path) !== path.dirname(repo.visible_trunk_path)) {
    throw new Error('Created workspace should be a visible peer of the trunk workspace.');
  }
  if (created.workspace.path.startsWith(repo.backing_store_path)) {
    throw new Error('Created workspace should not be nested inside the hidden backing store.');
  }

  const repositories = await getJson<{ repositories: Array<{ id: string }> }>('/api/repos');
  if (!repositories.repositories.some((repository) => repository.id === repo.id)) {
    throw new Error('Expected ensured repository to persist in the repository list.');
  }

  const workspaces = await getJson<{ workspaces: Array<{ id: string; path: string }> }>('/api/workspaces');
  if (!workspaces.workspaces.some((workspace) => workspace.id === trunkWorkspace.id)) {
    throw new Error('Expected trunk workspace to persist in the workspace list.');
  }
  if (!workspaces.workspaces.some((workspace) => workspace.id === created.workspace.id)) {
    throw new Error('Expected created peer workspace to persist in the workspace list.');
  }
}

async function assertExecutionWorkspacePersistence() {
  const detail = await getJson<{
    detail: {
      execution_state: {
        status: string;
        workspace?: { path: string; strategy: string } | null;
      };
    };
  }>('/api/change-units/cu_validation_rollup_checkpoint');

  const execution = detail.detail.execution_state;
  if (execution.status !== 'launched') {
    throw new Error(`Expected canonical checkpoint to stay launched after reload, saw ${execution.status}.`);
  }
  if (!execution.workspace?.path) {
    throw new Error('Expected launched execution to persist workspace metadata.');
  }
  if (!execution.workspace.path.includes('/workspaces/')) {
    throw new Error(`Expected launched workspace to be a visible peer workspace, saw ${execution.workspace.path}.`);
  }
  if (execution.workspace.strategy !== 'shared-store-worktree') {
    throw new Error(`Expected launched workspace strategy to persist, saw ${execution.workspace.strategy}.`);
  }
}

async function waitForWorkflowRunDetail(
  runId: string,
  predicate: (detail: Record<string, any>) => boolean,
  description: string,
  timeoutMs = 120_000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastDetail: Record<string, any> | null = null;

  while (Date.now() < deadline) {
    const response = await getJson<{ detail: Record<string, any> }>(
      `/api/workflow-runs/${encodeURIComponent(runId)}`,
    );
    lastDetail = response.detail;
    if (predicate(response.detail)) {
      return response.detail;
    }
    await delay(750);
  }

  throw new Error(
    `Timed out waiting for workflow run ${runId} to ${description}. Last state: ${JSON.stringify(
      {
        current_state_id: lastDetail?.run?.current_state_id ?? null,
        current_state_family: lastDetail?.run?.current_state_family ?? null,
        swarm_top_level_state: lastDetail?.swarm?.top_level_state ?? null,
        open_gate_ids:
          lastDetail?.open_gates?.map((gate: Record<string, any>) => gate.id) ?? [],
      },
      null,
      2,
    )}`,
  );
}

async function waitForWorkflowRunPath() {
  const output = await browserEval(
    [
      '(async () => {',
      '  const deadline = Date.now() + 20000;',
      '  while (Date.now() < deadline) {',
      "    const pathname = window.location.pathname;",
      "    const runId = document.querySelector('[data-workflow-run-id]')?.getAttribute('data-workflow-run-id') ?? '';",
      "    if (pathname.startsWith('/workflow-runs/') && runId) return runId;",
      '    await new Promise((resolve) => window.setTimeout(resolve, 120));',
      '  }',
      "  throw new Error('Timed out waiting for workflow run detail route.');",
      '})()',
    ].join(' '),
    true,
  );

  return readEvalString(output);
}

async function waitForWorkflowLiveUpdates() {
  await browserEval(
    [
      '(async () => {',
      '  const deadline = Date.now() + 20000;',
      '  while (Date.now() < deadline) {',
      "    const mode = document.querySelector('[data-workflow-live-update-mode]')?.getAttribute('data-workflow-live-update-mode');",
      "    if (mode === 'events' || mode === 'polling') return;",
      '    await new Promise((resolve) => window.setTimeout(resolve, 120));',
      '  }',
      "  throw new Error('Workflow run detail did not enable live updates.');",
      '})()',
    ].join(' '),
  );
}

async function createWorkflowRunFromBrowser(args: { repoPath: string; goalPrompt: string }) {
  await runBrowser(['open', `${baseUrl}/workflow-runs`]);
  await runBrowser(['wait', '--text', 'Workflow Runtime']);
  await browserEval(
    [
      '(async () => {',
      "  if (!document.querySelector('[data-workflow-runtime-route=\"true\"]')) {",
      "    throw new Error('Workflow runtime route shell did not render.');",
      '  }',
      `  const repoPath = ${JSON.stringify(args.repoPath)};`,
      `  const goalPrompt = ${JSON.stringify(args.goalPrompt)};`,
      "  const form = document.querySelector('[data-workflow-create-form=\"true\"]');",
      "  const workflow = document.querySelector('[data-workflow-field=\"workflow-id\"]');",
      "  const repo = document.querySelector('[data-workflow-field=\"repo-path\"]');",
      "  const goal = document.querySelector('[data-workflow-field=\"goal-prompt\"]');",
      "  const button = document.querySelector('[data-workflow-submit=\"create-run\"]');",
      "  if (!(form instanceof HTMLFormElement) || !(workflow instanceof HTMLSelectElement) || !(repo instanceof HTMLInputElement) || !(goal instanceof HTMLTextAreaElement) || !(button instanceof HTMLButtonElement)) {",
      "    throw new Error('Workflow run creation controls are missing.');",
      '  }',
      '  const setValue = (element, value) => {',
      '    const prototype = element instanceof HTMLTextAreaElement',
      '      ? HTMLTextAreaElement.prototype',
      '      : element instanceof HTMLSelectElement',
      '        ? HTMLSelectElement.prototype',
      '        : HTMLInputElement.prototype;',
      "    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');",
      '    descriptor?.set?.call(element, value);',
      "    element.dispatchEvent(new Event('input', { bubbles: true }));",
      "    element.dispatchEvent(new Event('change', { bubbles: true }));",
      '  };',
      "  setValue(workflow, 'plan-implement-review');",
      '  setValue(repo, repoPath);',
      '  setValue(goal, goalPrompt);',
      '  await new Promise((resolve) => window.setTimeout(resolve, 50));',
      "  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));",
      '})()',
    ].join(' '),
  );

  return await waitForWorkflowRunPath();
}

async function sendWorkflowPlanningMessageFromBrowser(message: string) {
  const output = await browserEval(
    [
      '(async () => {',
      `  const message = ${JSON.stringify(message)};`,
      "  if (document.querySelector('[data-workflow-primary-surface=\"approval_gate\"]')) {",
      "    return 'already_at_gate';",
      '  }',
      "  const form = document.querySelector('[data-workflow-planning-form=\"true\"]');",
      "  const input = document.querySelector('[data-workflow-planning-input=\"true\"]');",
      "  const button = document.querySelector('[data-workflow-planning-send=\"true\"]');",
      "  if (!(form instanceof HTMLFormElement) || !(input instanceof HTMLTextAreaElement) || !(button instanceof HTMLButtonElement)) {",
      "    throw new Error('Planning conversation controls are missing on the workflow route.');",
      '  }',
      "  const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');",
      '  descriptor?.set?.call(input, message);',
      "  input.dispatchEvent(new Event('input', { bubbles: true }));",
      "  input.dispatchEvent(new Event('change', { bubbles: true }));",
      '  await new Promise((resolve) => window.setTimeout(resolve, 50));',
      "  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));",
      "  return 'sent';",
      '})()',
    ].join(' '),
    true,
  );

  return readEvalString(output);
}

async function waitForWorkflowPlanningStallSurface(runId: string) {
  await waitForWorkflowRunDetail(
    runId,
    (detail) =>
      detail.run?.current_state_id === 'planning_conversation' &&
      detail.run?.status === 'active' &&
      Array.isArray(detail.sessions) &&
      detail.sessions.some(
        (sessionDetail: Record<string, any>) =>
          sessionDetail.session?.kind === 'planning_conversation' &&
          sessionDetail.session?.activity_status === 'stalled' &&
          sessionDetail.session?.stall_reason === 'timeout',
      ) &&
      Array.isArray(detail.events) &&
      detail.events.some((event: Record<string, any>) => event.type === 'planner_turn_timed_out'),
    'enter a recoverable stalled planning state',
  );

  await browserEval(
    [
      '(async () => {',
      '  const deadline = Date.now() + 30000;',
      '  while (Date.now() < deadline) {',
      "    const surface = document.querySelector('[data-workflow-primary-surface=\"planning_conversation\"]');",
      "    const plannerStatus = surface?.getAttribute('data-workflow-planner-status');",
      "    const stall = document.querySelector('[data-workflow-planning-stalled=\"true\"]');",
      "    const retry = document.querySelector('[data-workflow-planning-retry=\"true\"]');",
      "    const activeAgent = document.querySelector('[data-workflow-active-agent]')?.getAttribute('data-workflow-active-agent');",
      "    const workspace = document.querySelector('[data-workflow-active-workspace]')?.getAttribute('data-workflow-active-workspace') ?? '';",
      "    const progress = document.querySelector('[data-workflow-progress-status]')?.getAttribute('data-workflow-progress-status');",
      "    const lastEventType = document.querySelector('[data-workflow-last-event-type]')?.getAttribute('data-workflow-last-event-type');",
      "    if (surface && plannerStatus === 'stalled' && stall && retry && activeAgent === 'Planner' && workspace.includes('/workspaces/') && progress === 'stalled' && lastEventType === 'planner_turn_timed_out') {",
      '      return;',
      '    }',
      '    await new Promise((resolve) => window.setTimeout(resolve, 150));',
      '  }',
      "  throw new Error('Workflow route did not surface the recoverable planner timeout honestly.');",
      '})()',
    ].join(' '),
  );
}

async function retryWorkflowPlanningFromBrowser() {
  await browserEval(
    [
      '(async () => {',
      "  const button = document.querySelector('[data-workflow-planning-retry=\"true\"]');",
      "  if (!(button instanceof HTMLButtonElement)) throw new Error('Planning retry button is missing.');",
      '  button.click();',
      '})()',
    ].join(' '),
  );
}

async function waitForWorkflowPlanningRecovery(runId: string) {
  await waitForWorkflowRunDetail(
    runId,
    (detail) =>
      detail.run?.current_state_id === 'planning_conversation' &&
      Array.isArray(detail.sessions) &&
      detail.sessions.some(
        (sessionDetail: Record<string, any>) =>
          sessionDetail.session?.kind === 'planning_conversation' &&
          sessionDetail.session?.activity_status === 'running',
      ) &&
      Array.isArray(detail.events) &&
      detail.events.some(
        (event: Record<string, any>) =>
          event.type === 'planner_turn_retried' ||
          (event.type === 'planner_turn_started' && typeof event.summary === 'string' && event.summary.includes('retry')),
      ),
    'resume planning after retry',
  );

  await browserEval(
    [
      '(async () => {',
      '  const deadline = Date.now() + 30000;',
      '  while (Date.now() < deadline) {',
      "    const surface = document.querySelector('[data-workflow-primary-surface=\"planning_conversation\"]');",
      "    const plannerStatus = surface?.getAttribute('data-workflow-planner-status');",
      "    const progress = document.querySelector('[data-workflow-progress-status]')?.getAttribute('data-workflow-progress-status');",
      "    const lastEventType = document.querySelector('[data-workflow-last-event-type]')?.getAttribute('data-workflow-last-event-type');",
      "    if (surface && plannerStatus === 'running' && progress === 'making_progress' && (lastEventType === 'planner_turn_retried' || lastEventType === 'planner_turn_started' || lastEventType === 'planner_turn_steered')) {",
      '      return;',
      '    }',
      '    await new Promise((resolve) => window.setTimeout(resolve, 150));',
      '  }',
      "  throw new Error('Workflow route did not reflect planning recovery after retry.');",
      '})()',
    ].join(' '),
  );
}

async function waitForWorkflowApprovalSurface(runId: string) {
  await waitForWorkflowRunDetail(
    runId,
    (detail) =>
      detail.run?.current_state_id === 'first_prompt_approval' &&
      detail.swarm?.top_level_state === 'needs_user_input' &&
      Array.isArray(detail.open_gates) &&
      detail.open_gates.length > 0,
    'reach the first prompt approval gate',
  );

  await browserEval(
    [
      '(async () => {',
      '  const deadline = Date.now() + 30000;',
      '  while (Date.now() < deadline) {',
      "    const surface = document.querySelector('[data-workflow-primary-surface=\"approval_gate\"]');",
      "    const topLevel = document.querySelector('[data-swarm-top-level-state]')?.getAttribute('data-swarm-top-level-state');",
      "    const gate = document.querySelector('[data-swarm-current-gate]');",
      "    const artifact = document.querySelector('[data-workflow-gate-artifact=\"true\"] code')?.textContent?.trim() ?? '';",
      "    const routeId = gate?.getAttribute('data-swarm-unlocks-route-id');",
      "    const targetAgentId = gate?.getAttribute('data-swarm-unlocks-target-agent-id');",
      "    if (surface && topLevel === 'needs_user_input' && artifact && routeId === 'planner_to_implementer' && targetAgentId === 'implementer') {",
      '      return;',
      '    }',
      '    await new Promise((resolve) => window.setTimeout(resolve, 150));',
      '  }',
      "  throw new Error('Workflow route did not reflect the approval gate state.');",
      '})()',
    ].join(' '),
  );
}

async function approveWorkflowGateFromBrowser() {
  await browserEval(
    [
      '(async () => {',
      "  const button = document.querySelector('[data-workflow-gate-action=\"approve\"]');",
      "  if (!(button instanceof HTMLButtonElement)) throw new Error('Approve gate button is missing.');",
      '  button.click();',
      '})()',
    ].join(' '),
  );
}

async function assertWorkflowImplementingSurface(runId: string) {
  await waitForWorkflowRunDetail(
    runId,
    (detail) =>
      detail.run?.current_state_id === 'implementing' &&
      detail.swarm?.top_level_state === 'working' &&
      Array.isArray(detail.sessions) &&
      detail.sessions.some(
        (sessionDetail: Record<string, any>) =>
          sessionDetail.session?.kind === 'implementing' &&
          sessionDetail.session?.thread_id &&
          sessionDetail.session?.active_turn_id,
      ),
    'enter implementing with an active implementer session',
  );

  await browserEval(
    [
      '(async () => {',
      '  const deadline = Date.now() + 30000;',
      '  while (Date.now() < deadline) {',
      "    const surface = document.querySelector('[data-workflow-primary-surface=\"background\"]');",
      "    const priority = surface?.getAttribute('data-workflow-panel-priority');",
      "    const subphase = surface?.getAttribute('data-workflow-subphase');",
      "    const freshness = surface?.getAttribute('data-workflow-progress-freshness');",
      "    const topLevel = document.querySelector('[data-swarm-top-level-state]')?.getAttribute('data-swarm-top-level-state');",
      "    const currentState = document.querySelector('[data-workflow-current-state]')?.getAttribute('data-workflow-current-state');",
      "    const implementer = document.querySelector('[data-swarm-agent-id=\"implementer\"]')?.getAttribute('data-swarm-agent-status');",
      "    const implementerSession = document.querySelector('[data-workflow-session-kind=\"implementing\"]');",
      "    const activeAgent = document.querySelector('[data-workflow-active-agent]')?.getAttribute('data-workflow-active-agent');",
      "    const activeWorkspace = document.querySelector('[data-workflow-active-workspace]')?.getAttribute('data-workflow-active-workspace');",
      "    const progress = document.querySelector('[data-workflow-progress-status]')?.getAttribute('data-workflow-progress-status');",
      "    const lastMeaningful = document.querySelector('[data-workflow-last-meaningful-type]')?.getAttribute('data-workflow-last-meaningful-type');",
      "    const timelineTitles = [...document.querySelectorAll('[data-workflow-timeline-entry]')].map((node) => node.getAttribute('data-workflow-timeline-entry'));",
      "    if (surface && priority === 'primary' && subphase === 'implementing' && (freshness === 'making_progress' || freshness === 'quiet_but_active') && topLevel === 'working' && currentState === 'implementing' && implementer === 'working' && implementerSession && activeAgent === 'Implementer' && activeWorkspace?.includes('/workspaces/') && (progress === 'making_progress' || progress === 'quiet_but_active') && lastMeaningful === 'implementer_turn_started' && timelineTitles.includes('Gate answered') && timelineTitles.includes('Implementer turn started')) {",
      '      return;',
      '    }',
      '    await new Promise((resolve) => window.setTimeout(resolve, 150));',
      '  }',
      "  throw new Error('Workflow route did not reflect implementer execution honestly.');",
      '})()',
    ].join(' '),
  );
}

async function waitForWorkflowStepApprovalSurface(runId: string) {
  const detail = await waitForWorkflowRunDetail(
    runId,
    (nextDetail) =>
      nextDetail.run?.current_state_id === 'step_approval' &&
      nextDetail.swarm?.top_level_state === 'needs_user_input' &&
      Array.isArray(nextDetail.open_gates) &&
      nextDetail.open_gates.length > 0 &&
      Array.isArray(nextDetail.artifacts) &&
      nextDetail.artifacts.some(
        (artifact: Record<string, any>) =>
          artifact.kind === 'tutorial_artifact' && artifact.status === 'ready' && artifact.content,
      ) &&
      nextDetail.artifacts.some(
        (artifact: Record<string, any>) =>
          artifact.kind === 'next_prompt_artifact' && artifact.status === 'ready' && artifact.content,
      ) &&
      Array.isArray(nextDetail.events) &&
      nextDetail.events.some((event: Record<string, any>) => event.type === 'implementer_turn_completed') &&
      nextDetail.events.some((event: Record<string, any>) => event.type === 'review_turn_started') &&
      nextDetail.events.some((event: Record<string, any>) => event.type === 'review_turn_completed') &&
      nextDetail.events.some((event: Record<string, any>) => event.type === 'review_result_detected') &&
      nextDetail.events.some((event: Record<string, any>) => event.type === 'tutorial_artifact_persisted') &&
      nextDetail.events.some((event: Record<string, any>) => event.type === 'next_prompt_artifact_persisted'),
    'reach the step approval gate',
    300_000,
  );

  const implementerSession = detail.sessions?.find(
    (sessionDetail: Record<string, any>) => sessionDetail.session?.kind === 'implementing',
  );
  const workspacePath = implementerSession?.session?.cwd;
  if (typeof workspacePath !== 'string' || !workspacePath) {
    throw new Error('Accepted workflow run is missing the implementer workspace path.');
  }

  const validationNotePath = path.join(workspacePath, workflowValidationNoteFile);
  const noteBody = await fs.readFile(validationNotePath, 'utf8').catch(() => null);
  if (noteBody?.trim() !== workflowValidationNoteBody) {
    throw new Error(
      `Expected workflow validation note at ${validationNotePath} with exact body "${workflowValidationNoteBody}".`,
    );
  }

  await browserEval(
    [
      '(async () => {',
      '  const deadline = Date.now() + 30000;',
      '  while (Date.now() < deadline) {',
      "    const surface = document.querySelector('[data-workflow-primary-surface=\"step_approval\"]');",
      "    const surfacePriority = surface?.getAttribute('data-workflow-panel-priority');",
      "    const topLevel = document.querySelector('[data-swarm-top-level-state]')?.getAttribute('data-swarm-top-level-state');",
      "    const currentState = document.querySelector('[data-workflow-current-state]')?.getAttribute('data-workflow-current-state');",
      "    const gate = document.querySelector('[data-swarm-current-gate]');",
      "    const activeAgent = document.querySelector('[data-workflow-active-agent]')?.getAttribute('data-workflow-active-agent');",
      "    const activeWorkspace = document.querySelector('[data-workflow-active-workspace]')?.getAttribute('data-workflow-active-workspace');",
      "    const lastEvent = document.querySelector('[data-workflow-last-event-type]')?.getAttribute('data-workflow-last-event-type');",
      "    const progress = document.querySelector('[data-workflow-progress-status]')?.getAttribute('data-workflow-progress-status');",
      "    const liveUpdateMode = document.querySelector('[data-workflow-live-update-mode]')?.getAttribute('data-workflow-live-update-mode');",
      "    const liveUpdateCount = Number(document.querySelector('[data-workflow-live-update-mode]')?.getAttribute('data-workflow-live-update-count') ?? '0');",
      "    const swarmPriority = document.querySelector('[data-workflow-swarm-overview=\"true\"]')?.getAttribute('data-workflow-panel-priority');",
      "    const timelinePriority = document.querySelector('[data-workflow-timeline=\"true\"]')?.getAttribute('data-workflow-panel-priority');",
      "    const sessionsPriority = document.querySelector('[data-workflow-sessions-panel=\"true\"]')?.getAttribute('data-workflow-panel-priority');",
      "    const tutorial = document.querySelector('[data-workflow-step-tutorial=\"true\"] code')?.textContent?.trim() ?? '';",
      "    const nextPrompt = document.querySelector('[data-workflow-step-next-prompt=\"true\"] code')?.textContent?.trim() ?? '';",
      "    const timelineTitles = [...document.querySelectorAll('[data-workflow-timeline-entry]')].map((node) => node.getAttribute('data-workflow-timeline-entry'));",
      "    if (surface && surfacePriority === 'dominant' && topLevel === 'needs_user_input' && currentState === 'step_approval' && gate && activeAgent === 'User' && activeWorkspace?.includes('/workspaces/') && progress === 'waiting_on_user' && lastEvent === 'gate_opened' && tutorial && nextPrompt && liveUpdateMode === 'events' && liveUpdateCount > 0 && swarmPriority === 'secondary' && timelinePriority === 'secondary' && sessionsPriority === 'secondary' && timelineTitles.includes('Review result detected') && timelineTitles.includes('Tutorial worker turn started') && timelineTitles.includes('Tutorial artifact persisted') && timelineTitles.includes('Next prompt worker turn started') && timelineTitles.includes('Next prompt artifact persisted') && timelineTitles.includes('Gate opened')) {",
      '      return;',
      '    }',
      '    await new Promise((resolve) => window.setTimeout(resolve, 150));',
      '  }',
      "  throw new Error('Workflow route did not reflect the step approval packet honestly.');",
      '})()',
    ].join(' '),
  );

  return detail;
}

async function assertWorkflowRuntimeRoute(repoPath: string) {
  const goalPrompt = [
    'Prove the hub-and-spoke workflow runtime on a tiny validation repository.',
    'Do not inspect files or run commands yet; wait for one clarifying user message before drafting the first prompt candidate.',
    'The first worker step should be a trivial, immediately reviewable repo-root change.',
  ].join(' ');
  const runId = await createWorkflowRunFromBrowser({
    repoPath,
    goalPrompt,
  });

  await waitForWorkflowLiveUpdates();
  await browserEval(
    [
      "if (!document.querySelector('[data-workflow-session-kind=\"planning_conversation\"]')) {",
      "  throw new Error('Planner session card is missing on the workflow run page.');",
      '}',
      "if (!document.querySelector('[data-workflow-primary-surface=\"planning_conversation\"]')) {",
      "  throw new Error('Expected the workflow route to start in the planning conversation.');",
      '}',
    ].join(' '),
  );

  await waitForWorkflowPlanningStallSurface(runId);
  await retryWorkflowPlanningFromBrowser();
  await waitForWorkflowPlanningRecovery(runId);

  await sendWorkflowPlanningMessageFromBrowser(
    [
      'Do not inspect files or run commands for this planning step.',
      'Emit exactly one <first_prompt_candidate>...</first_prompt_candidate> marker whose body is only this implementer task:',
      `Create a file named ${workflowValidationNoteFile} at the repository root.`,
      `Write exactly this single line into the file: ${workflowValidationNoteBody}`,
      'Do not modify any other files.',
      'Do not run tests or commands beyond the minimum needed to create the file.',
      'When finished, the implementer should report that the file was created exactly as requested.',
    ].join(' '),
  );

  await waitForWorkflowApprovalSurface(runId);
  await browserEval(
    [
      "const gateText = document.querySelector('[data-workflow-gate-artifact=\"true\"] code')?.textContent ?? '';",
      "if (!gateText.trim()) {",
      "  throw new Error('Expected the approval gate artifact to contain a prompt candidate.');",
      '}',
    ].join(' '),
  );

  await approveWorkflowGateFromBrowser();
  await assertWorkflowImplementingSurface(runId);
  const detail = await waitForWorkflowStepApprovalSurface(runId);
  const implementerSession = detail.sessions?.find(
    (sessionDetail: Record<string, any>) => sessionDetail.session?.kind === 'implementing',
  );
  const workspacePath = implementerSession?.session?.cwd;
  if (typeof workspacePath !== 'string' || !workspacePath.includes('/workspaces/')) {
    throw new Error(`Expected surfaced implementer workspace path under /workspaces/, saw ${workspacePath ?? 'missing'}.`);
  }

  const sourceStatus = await gitStatusShort(repoPath);
  if (sourceStatus.trim()) {
    throw new Error(`Source repo should stay clean while worker execution uses a peer workspace. Saw:\n${sourceStatus}`);
  }

  const workspaceStatus = await gitStatusShort(workspacePath);
  if (!workspaceStatus.includes(workflowValidationNoteFile)) {
    throw new Error(
      `Expected surfaced workspace ${workspacePath} to contain the runtime validation change. Saw:\n${workspaceStatus || '(clean)'}`,
    );
  }

  const sourceNotePath = path.join(repoPath, workflowValidationNoteFile);
  const sourceNoteExists = await fs
    .access(sourceNotePath)
    .then(() => true)
    .catch(() => false);
  if (sourceNoteExists) {
    throw new Error(`Source repo unexpectedly contains ${workflowValidationNoteFile}; the change should live only in the surfaced workspace.`);
  }
}

await fs.mkdir(importedRoot, { recursive: true });
await fs.mkdir(runtimeRoot, { recursive: true });
const workflowValidationRepoPath = await createWorkflowValidationRepo();
await runCommand('npx', ['agent-browser', 'install']);

const canonicalBundle = JSON.parse(await fs.readFile(canonicalBundlePath, 'utf8')) as BundleLike;
const canonicalStepTitles = canonicalBundle.change_unit.tutorial.steps.map(
  (step: { title: string }) => step.title,
);

const dynamicFixture = structuredClone(canonicalBundle) as BundleLike;
const canonicalBundleDir = path.dirname(canonicalBundlePath);

dynamicFixture.change_unit.id = 'cu_dynamic_tutorial_fixture';
dynamicFixture.change_unit.title = 'Exercise dynamic tutorial navigation';
dynamicFixture.change_unit.status = 'needs_revision';
dynamicFixture.change_unit.tutorial.steps = [
  { id: 'dynamic-1', title: 'Scope the packet' },
  { id: 'dynamic-2', title: 'Trace the validator' },
  { id: 'dynamic-3', title: 'Inspect the replay path' },
  { id: 'dynamic-4', title: 'Check the runtime state' },
  { id: 'dynamic-5', title: 'Review the launch error' },
  { id: 'dynamic-6', title: 'Decide the retry plan' },
].map((step, index) => ({
  ...step,
  intent: `Review fixture step ${index + 1}.`,
  affected_files: ['src/components/ChangeUnitSurface.tsx'],
  evidence_snippets: [],
  body_markdown: `Validation fixture step ${index + 1}.`,
}));
dynamicFixture.change_unit.next_action = {
  kind: 'codex_fork_path',
  path: 'seed/change-units/validation-rollup-checkpoint/rollouts/does-not-exist.jsonl',
  prompt: 'Retry the dynamic tutorial fixture.',
  label: 'Execute Next Prompt',
};
dynamicFixture.agent_sessions = dynamicFixture.agent_sessions.map((session: BundleLike) => ({
  ...session,
  thread_capture:
    session.thread_capture?.kind === 'rollout_path'
      ? {
          ...session.thread_capture,
          path: path.join(canonicalBundleDir, session.thread_capture.path),
        }
      : session.thread_capture,
}));

const dynamicFixturePath = path.join(validationRoot, 'dynamic-tutorial-fixture.json');
await fs.writeFile(dynamicFixturePath, JSON.stringify(dynamicFixture, null, 2), 'utf8');
const dynamicStepTitles = dynamicFixture.change_unit.tutorial.steps.map(
  (step: { title: string }) => step.title,
);

const server = spawn('npm', ['run', 'start'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: port,
    INBOX_IMPORTED_ROOT: importedRoot,
    INBOX_RUNTIME_ROOT: runtimeRoot,
    INBOX_WORKFLOW_PLANNER_TIMEOUT_ONCE_MS: '1',
  },
  detached: true,
  stdio: 'inherit',
});

try {
  await waitForHealth();
  await runBrowser(['close']).catch(() => undefined);
  await assertWorkspaceSubsystem();

  await runBrowser(['open', baseUrl]);
  await assertSurfaceLoaded(canonicalBundle.change_unit.title, canonicalStepTitles);
  await assertThemeControls();
  await assertSurfaceLoaded(canonicalBundle.change_unit.title, canonicalStepTitles);
  await assertReplayWorkspaceControls();
  await assertCodexReplayKinds('planner', ['agentMessage']);
  await assertCodexReplayKinds('implementer', ['reasoning', 'commandExecution', 'fileChange']);
  await assertCodexReplayKinds('reviewer_a', ['agentMessage']);
  const rootSearch = readEvalString(await browserEval('window.location.search;', true));
  if (rootSearch !== '') {
    throw new Error(`Opening / should not inject a stale change param. Saw ${rootSearch}.`);
  }

  await runBrowser(['open', `${baseUrl}/?change=cu_session_recovery`]);
  await assertSurfaceLoaded(canonicalBundle.change_unit.title, canonicalStepTitles);
  await assertCodexReplayKinds('implementer', ['reasoning', 'commandExecution', 'fileChange']);
  const recoveredSearch = readEvalString(await browserEval('window.location.search;', true));
  assertIncludes(
    recoveredSearch,
    'cu_validation_rollup_checkpoint',
    'stale deep link should recover to the canonical checkpoint URL',
  );
  if (recoveredSearch.includes('cu_session_recovery')) {
    throw new Error('Stale deep link was not cleared from the URL.');
  }

  await runBrowser(['open', `${baseUrl}/?change=cu_validation_rollup_checkpoint`]);
  await assertSurfaceLoaded(canonicalBundle.change_unit.title, canonicalStepTitles);
  await assertReplayWidthPersists('cu_validation_rollup_checkpoint');
  await assertCodexReplayKinds('implementer', ['reasoning', 'commandExecution', 'fileChange']);
  const canonicalSearch = readEvalString(await browserEval('window.location.search;', true));
  assertIncludes(
    canonicalSearch,
    'cu_validation_rollup_checkpoint',
    'canonical deep link should stay on the canonical checkpoint',
  );

  await assertSelectedStep(canonicalStepTitles.at(-1) ?? canonicalStepTitles[0], canonicalStepTitles.length - 1);

  await browserEval(
    [
      "const button = document.querySelector('[data-execute-next=\"true\"]');",
      "if (!(button instanceof HTMLElement)) throw new Error('Execute Next Prompt button is missing.');",
      "button.dispatchEvent(new MouseEvent('click', { bubbles: true }));",
    ].join(' '),
  );
  await assertExecutionLaunched();
  await assertSessionWallMode([
    'planner',
    'implementer',
    'reviewer_a',
    'reviewer_b',
    'live_session',
  ]);
  const commandApproval = await injectApproval('commandExecution');
  await assertApprovalCard('commandExecution', 'pending', commandApproval.request_id);
  await answerApproval('commandExecution', commandApproval.request_id, 'accept');
  await assertApprovalCard('commandExecution', 'answered', commandApproval.request_id);
  const clearedApproval = await injectApproval('fileChange');
  await assertApprovalCard('fileChange', 'pending', clearedApproval.request_id);
  await clearApproval(clearedApproval.request_id, clearedApproval.thread_id);
  await assertApprovalCard('fileChange', 'cleared', clearedApproval.request_id);
  const declinedApproval = await injectApproval('fileChange');
  await assertApprovalCard('fileChange', 'pending', declinedApproval.request_id);
  await answerApproval('fileChange', declinedApproval.request_id, 'decline');
  await assertApprovalCard('fileChange', 'answered', declinedApproval.request_id);

  await runBrowser(['open', `${baseUrl}/?change=cu_validation_rollup_checkpoint`]);
  await assertSurfaceLoaded(canonicalBundle.change_unit.title, canonicalStepTitles);
  await assertExecutionLaunched();
  await assertExecutionWorkspacePersistence();
  await browserEval(
    [
      '(async () => {',
      "  const linkedTab = document.querySelector('[data-session-role=\"planner\"]');",
      "  if (!(linkedTab instanceof HTMLElement)) throw new Error('Expected planner session tab.');",
      "  linkedTab.dispatchEvent(new MouseEvent('click', { bubbles: true }));",
      '  await new Promise((resolve) => window.setTimeout(resolve, 150));',
      "  const linkedView = document.querySelector('[data-session-view=\"linked\"]');",
      "  if (!linkedView) throw new Error('Expected to return to a linked checkpoint session view.');",
      '})()',
    ].join(' '),
  );

  await postJson('/api/import-bundle', { path: dynamicFixturePath });
  await runBrowser(['open', `${baseUrl}/?change=cu_dynamic_tutorial_fixture`]);
  await assertSurfaceLoaded(dynamicFixture.change_unit.title, dynamicStepTitles);
  await assertSelectedStep(dynamicStepTitles[4], 4);

  await browserEval(
    [
      "const button = document.querySelector('[data-execute-next=\"true\"]');",
      "if (!(button instanceof HTMLElement)) throw new Error('Fixture execute button is missing.');",
      "button.dispatchEvent(new MouseEvent('click', { bubbles: true }));",
    ].join(' '),
  );
  await assertExecutionFailed();

  await runBrowser(['open', `${baseUrl}/?change=cu_dynamic_tutorial_fixture`]);
  await assertSurfaceLoaded(dynamicFixture.change_unit.title, dynamicStepTitles);
  await assertExecutionFailed();

  const apiResponse = await browserEval(
    "fetch('/api/change-units').then((response) => response.json()).then((body) => JSON.stringify(body));",
    true,
  );
  assertIncludes(apiResponse, 'cu_validation_rollup_checkpoint', 'canonical packet id should come from API');
  assertIncludes(apiResponse, 'cu_dynamic_tutorial_fixture', 'fixture packet id should come from API');
  await assertWorkflowRuntimeRoute(workflowValidationRepoPath);

  detectPageErrors(await runBrowser(['errors'], true));
} finally {
  await runBrowser(['close']).catch(() => undefined);
  await stopServerProcess(server);
  await fs.rm(validationRoot, { recursive: true, force: true });
}
