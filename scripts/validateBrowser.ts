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

async function runCommand(command: string, args: string[], captureOutput = false): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
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

async function assertExecutionLaunched() {
  await runBrowser(['wait', '--text', 'Next chunk started']);
  await browserEval(
    [
      "const actionState = document.querySelector('[data-execution-state=\"launched\"]');",
      "if (!actionState) throw new Error('Expected launched execution state.');",
      "const openButton = document.querySelector('[data-open-live-session=\"true\"]');",
      "if (!(openButton instanceof HTMLElement)) throw new Error('Open Live Session CTA is missing.');",
      "const threadCode = document.querySelector('.execution-metadata code')?.textContent?.trim();",
      "if (!threadCode) throw new Error('Expected launched thread id in the action area.');",
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
      "if (!document.querySelector('[data-thread-viewer-model=\"codex-native\"]')) throw new Error('Expected the live session to render through the Codex-native thread viewer.');",
      '  const deadline = Date.now() + 10000;',
      '  while (Date.now() < deadline) {',
      "    const liveUpdate = document.querySelector('[data-live-update-mode]');",
      "    const count = Number(liveUpdate?.getAttribute('data-live-update-count') ?? '0');",
      "    const lastMethod = document.querySelector('.live-session-metadata')?.textContent ?? '';",
      "    if (count > 0 || lastMethod.includes('item/') || lastMethod.includes('turn/')) return;",
      '    await new Promise((resolve) => window.setTimeout(resolve, 200));',
      '  }',
      "  throw new Error('Expected live session updates to appear after execution started.');",
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

  await postJson(`/api/dev/live-sessions/${encodeURIComponent(threadId)}/approvals/inject`, { kind });
}

async function assertApprovalCard(kind: 'commandExecution' | 'fileChange', status: 'pending' | 'answered') {
  await browserEval(
    [
      `const kind = ${JSON.stringify(kind)};`,
      `const status = ${JSON.stringify(status)};`,
      "const card = document.querySelector(`[data-approval-kind=\"${kind}\"][data-approval-status=\"${status}\"]`);",
      "if (!card) throw new Error(`Missing approval card for ${kind} with status ${status}.`);",
      "if (!card.textContent?.includes('Thread')) throw new Error('Approval card should show thread details.');",
      "if (!card.textContent?.includes('Turn')) throw new Error('Approval card should show turn details.');",
      "if (!card.textContent?.includes('Item')) throw new Error('Approval card should show item details.');",
      "if (kind === 'commandExecution' && !card.textContent?.includes('npm test -- --runInBand')) {",
      "  throw new Error('Command approval should show the proposed command.');",
      '}',
      "if (kind === 'fileChange' && !card.textContent?.includes('src/validation.js')) {",
      "  throw new Error('File change approval should show the proposed file path.');",
      '}',
    ].join(' '),
  );
}

async function answerApproval(kind: 'commandExecution' | 'fileChange', decision: 'accept' | 'decline') {
  await browserEval(
    [
      '(async () => {',
      `  const kind = ${JSON.stringify(kind)};`,
      `  const decision = ${JSON.stringify(decision)};`,
      "  const card = document.querySelector(`[data-approval-kind=\"${kind}\"][data-approval-status=\"pending\"]`);",
      "  if (!card) throw new Error(`Missing pending approval for ${kind}.`);",
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
      `  const expected = ${JSON.stringify(decision === 'accept' ? 'Accepted' : 'Declined')};`,
      '  const deadline = Date.now() + 8000;',
      '  while (Date.now() < deadline) {',
      "    const card = document.querySelector(`[data-approval-kind=\"${kind}\"][data-approval-status=\"answered\"]`);",
      "    if (card && card.textContent?.includes(expected)) return;",
      '    await new Promise((resolve) => window.setTimeout(resolve, 200));',
      '  }',
      "  throw new Error(`Approval ${kind} did not transition to answered state.`);",
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

await fs.mkdir(importedRoot, { recursive: true });
await fs.mkdir(runtimeRoot, { recursive: true });
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
  },
  stdio: 'inherit',
});

try {
  await waitForHealth();
  await runBrowser(['close']).catch(() => undefined);

  await runBrowser(['open', baseUrl]);
  await assertSurfaceLoaded(canonicalBundle.change_unit.title, canonicalStepTitles);
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
  await injectApproval('commandExecution');
  await assertApprovalCard('commandExecution', 'pending');
  await answerApproval('commandExecution', 'accept');
  await assertApprovalCard('commandExecution', 'answered');
  await injectApproval('fileChange');
  await assertApprovalCard('fileChange', 'pending');
  await answerApproval('fileChange', 'decline');
  await assertApprovalCard('fileChange', 'answered');

  await runBrowser(['open', `${baseUrl}/?change=cu_validation_rollup_checkpoint`]);
  await assertSurfaceLoaded(canonicalBundle.change_unit.title, canonicalStepTitles);
  await assertExecutionLaunched();
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

  detectPageErrors(await runBrowser(['errors'], true));
} finally {
  server.kill('SIGTERM');
  await new Promise((resolve) => server.once('exit', resolve));
  await fs.rm(validationRoot, { recursive: true, force: true });
}
