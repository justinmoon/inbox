import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

import type { ChangeUnitDetail, ChangeUnitListItem } from '../shared/api.ts';

const port = process.env.PORT ?? '8787';
const baseUrl = `http://127.0.0.1:${port}`;
const changeId = process.env.INBOX_VALIDATE_CHANGE_ID ?? 'cu_session_recovery';
const primaryTitle =
  process.env.INBOX_VALIDATE_PRIMARY_TITLE ?? 'Recover interrupted Codex sessions into one review packet';
const secondaryTitle =
  process.env.INBOX_VALIDATE_SECONDARY_TITLE ?? 'Stabilize bundle imports when repeated seeds collide';
const requireRefreshButton = process.env.INBOX_VALIDATE_REQUIRE_REFRESH === '1';
const createRepoPath = process.env.INBOX_VALIDATE_CREATE_REPO_PATH ?? null;
const createProjectName = process.env.INBOX_VALIDATE_CREATE_PROJECT_NAME ?? null;
const createGithubRepo = process.env.INBOX_VALIDATE_CREATE_GITHUB_REPO ?? null;
const createBranchName = process.env.INBOX_VALIDATE_CREATE_BRANCH_NAME ?? null;
const createPlannerThreadId = process.env.INBOX_VALIDATE_CREATE_PLANNER_THREAD_ID ?? null;
const createImplementerThreadId = process.env.INBOX_VALIDATE_CREATE_IMPLEMENTER_THREAD_ID ?? null;
const createReviewerAThreadId = process.env.INBOX_VALIDATE_CREATE_REVIEWER_A_THREAD_ID ?? null;
const createReviewerBThreadId = process.env.INBOX_VALIDATE_CREATE_REVIEWER_B_THREAD_ID ?? null;
const appUrl = `${baseUrl}/?change=${encodeURIComponent(changeId)}`;
const validationDir = path.resolve(process.cwd(), 'artifacts/validation');
const screenshotPath = path.join(validationDir, 'inbox-prototype.png');
const tourDir = path.join(validationDir, 'tour');
const manifestPath = path.join(tourDir, 'manifest.json');

type TourShot = {
  name: string;
  kind: 'primary' | 'change-unit' | 'session' | 'mobile' | 'modal';
  mode: 'desktop' | 'mobile';
  path: string;
  change_unit_id: string;
  title: string;
  session_role?: string;
};

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

async function requestJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed for ${url} with ${response.status}`);
  }
  return (await response.json()) as T;
}

function assertIncludes(haystack: string, needle: string, description: string) {
  if (!haystack.includes(needle)) {
    throw new Error(`Expected page text to include "${needle}" (${description}).`);
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function roleLabel(role: string): string {
  return role.replaceAll('_', ' ');
}

function roleWeight(role: string): number {
  switch (role) {
    case 'planner':
      return 0;
    case 'implementer':
      return 1;
    case 'reviewer_a':
      return 2;
    case 'reviewer_b':
      return 3;
    default:
      return 9;
  }
}

async function setViewport(width: number, height: number) {
  await runBrowser(['set', 'viewport', String(width), String(height)]);
}

async function waitForText(text: string) {
  await runBrowser(['wait', '--text', text]);
}

async function browserEval(source: string) {
  await runBrowser(['eval', source]);
}

async function scrollToTop() {
  await browserEval('window.scrollTo(0, 0);');
}

async function clickQueueCard(title: string) {
  await browserEval(
    [
      `const title = ${JSON.stringify(title)};`,
      "const cards = [...document.querySelectorAll('.queue-card')];",
      "const card = cards.find((candidate) => candidate.querySelector('h2')?.textContent?.trim() === title);",
      "if (!card) throw new Error(`Missing queue card: ${title}`);",
      'card.click();',
    ].join(' '),
  );
}

async function clickSessionTab(label: string) {
  await browserEval(
    [
      `const label = ${JSON.stringify(label)};`,
      "const tabs = [...document.querySelectorAll('.session-tab')];",
      "const tab = tabs.find((candidate) => candidate.querySelector('span')?.textContent?.trim() === label);",
      "if (!tab) throw new Error(`Missing session tab: ${label}`);",
      'tab.click();',
    ].join(' '),
  );
}

async function fillField(label: string, value: string) {
  await runBrowser(['find', 'label', label, 'fill', value]);
}

async function captureFullScreenshot(targetPath: string) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await runBrowser(['screenshot', '--full', targetPath]);
}

async function captureViewportScreenshot(targetPath: string) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await runBrowser(['screenshot', targetPath]);
}

function buildShotPath(prefix: string, title: string): string {
  return path.join(tourDir, `${prefix}-${slugify(title)}.png`);
}

async function fetchItems() {
  const response = await requestJson<{ items: ChangeUnitListItem[] }>(`${baseUrl}/api/change-units`);
  return response.items;
}

async function fetchDetail(id: string) {
  const response = await requestJson<{ detail: ChangeUnitDetail }>(`${baseUrl}/api/change-units/${id}`);
  return response.detail;
}

function detectPageErrors(output: string) {
  const normalized = output.trim();
  if (!normalized) return;
  if (/no page errors/i.test(normalized)) return;
  if (/page errors:\s*0/i.test(normalized)) return;
  throw new Error(`Browser reported page errors:\n${normalized}`);
}

async function waitForNewChangeUnit(previousIds: Set<string>, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const items = await fetchItems();
    const created = items.find((item) => !previousIds.has(item.id));
    if (created) return created;
    await delay(1_000);
  }
  throw new Error('Timed out waiting for the create-live-packet flow to import a new change unit.');
}

await fs.mkdir(validationDir, { recursive: true });
await fs.mkdir(tourDir, { recursive: true });
await runCommand('npx', ['agent-browser', 'install']);

const server = spawn('npm', ['run', 'start'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: port,
  },
  stdio: 'inherit',
});

const shots: TourShot[] = [];
let createdItemFromUi: ChangeUnitListItem | null = null;

try {
  await waitForHealth();
  await runBrowser(['close']).catch(() => undefined);
  await runBrowser(['open', appUrl]);
  await setViewport(1600, 1100);
  await waitForText(primaryTitle);
  await runBrowser(['errors', '--clear']).catch(() => undefined);

  if (secondaryTitle) {
    await clickQueueCard(secondaryTitle);
    await waitForText(secondaryTitle);
    await clickQueueCard(primaryTitle);
    await waitForText(primaryTitle);
  }

  await waitForText('Linked sessions');
  if (requireRefreshButton) {
    await runBrowser(['find', 'text', 'Refresh from Codex', 'click']);
    await waitForText('Linked sessions');
  }

  const pageText = await runBrowser(['get', 'text', 'body'], true);
  assertIncludes(pageText, 'Inbox Control Room', 'inbox rail renders');
  assertIncludes(pageText, 'What changed and how to review it', 'tutorial section renders');
  assertIncludes(pageText, 'Code changes', 'diff section renders');
  assertIncludes(pageText, 'Linked sessions', 'replay panel renders');

  await scrollToTop();
  await captureFullScreenshot(screenshotPath);

  let items = await fetchItems();
  let details = await Promise.all(items.map(async (item) => [item.id, await fetchDetail(item.id)] as const));
  let detailById = new Map(details);
  let liveItem = items.find((item) => item.tags.includes('live-codex')) ?? items[0];
  let liveDetail = detailById.get(liveItem.id);

  shots.push({
    name: 'primary',
    kind: 'primary',
    mode: 'desktop',
    path: screenshotPath,
    change_unit_id: changeId,
    title: primaryTitle,
  });

  await runBrowser(['open', baseUrl]);
  await setViewport(1600, 1100);
  await waitForText('Inbox Control Room');
  await runBrowser(['find', 'text', 'Create Live Packet', 'click']);
  await waitForText('Create change unit from repo + Codex threads');
  const modalPath = buildShotPath('desktop-modal', 'create-live-packet');
  await captureViewportScreenshot(modalPath);
  shots.push({
    name: path.basename(modalPath),
    kind: 'modal',
    mode: 'desktop',
    path: modalPath,
    change_unit_id: 'modal',
    title: 'Create live packet modal',
  });

  if (createRepoPath && createImplementerThreadId) {
    const beforeIds = new Set(items.map((item) => item.id));
    await fillField('Repo path', createRepoPath);
    if (createProjectName) await fillField('Project label', createProjectName);
    if (createGithubRepo) await fillField('GitHub repo', createGithubRepo);
    if (createBranchName) await fillField('Branch name', createBranchName);
    if (createPlannerThreadId) await fillField('Planner thread', createPlannerThreadId);
    await fillField('Implementer thread', createImplementerThreadId);
    if (createReviewerAThreadId) await fillField('Reviewer A thread', createReviewerAThreadId);
    if (createReviewerBThreadId) await fillField('Reviewer B thread', createReviewerBThreadId);

    await browserEval(
      [
        "const submit = document.querySelector('.modal-shell button[type=\"submit\"]');",
        "if (!submit) throw new Error('Missing modal submit button');",
        'submit.click();',
      ].join(' '),
    );
    createdItemFromUi = await waitForNewChangeUnit(beforeIds);
    const createdItem = createdItemFromUi;
    await waitForText(createdItem.title);
    await scrollToTop();
    await captureFullScreenshot(screenshotPath);
    const createdPath = buildShotPath('desktop-created', createdItem.title);
    await captureFullScreenshot(createdPath);
    shots.push({
      name: path.basename(createdPath),
      kind: 'change-unit',
      mode: 'desktop',
      path: createdPath,
      change_unit_id: createdItem.id,
      title: createdItem.title,
    });

    items = await fetchItems();
    details = await Promise.all(items.map(async (item) => [item.id, await fetchDetail(item.id)] as const));
    detailById = new Map(details);
    liveItem =
      items.find((item) => item.id === createdItem.id) ??
      items.find((item) => item.tags.includes('live-codex')) ??
      items[0];
    liveDetail = detailById.get(liveItem.id);
  } else {
    await browserEval(
      [
        "const closeButton = [...document.querySelectorAll('.modal-shell button')].find((candidate) => candidate.textContent?.trim() === 'Close');",
        "if (!closeButton) throw new Error('Missing modal close button');",
        'closeButton.click();',
      ].join(' '),
    );
  }

  if (createdItemFromUi && shots[0]) {
    shots[0] = {
      ...shots[0],
      change_unit_id: createdItemFromUi.id,
      title: createdItemFromUi.title,
    };
  }

  for (const item of items) {
    const detail = detailById.get(item.id);
    if (!detail) continue;
    await runBrowser(['open', `${baseUrl}/?change=${encodeURIComponent(item.id)}`]);
    await setViewport(1600, 1100);
    await waitForText(item.title);
    await waitForText('What changed and how to review it');
    await scrollToTop();
    const targetPath = buildShotPath(`desktop-${String(shots.length).padStart(2, '0')}`, item.title);
    await captureFullScreenshot(targetPath);
    shots.push({
      name: path.basename(targetPath),
      kind: 'change-unit',
      mode: 'desktop',
      path: targetPath,
      change_unit_id: item.id,
      title: item.title,
    });
  }

  if (liveItem && liveDetail) {
    await runBrowser(['open', `${baseUrl}/?change=${encodeURIComponent(liveItem.id)}`]);
    await setViewport(1600, 1100);
    await waitForText(liveItem.title);

    const orderedSessions = [...liveDetail.agent_sessions].sort((a, b) => roleWeight(a.role) - roleWeight(b.role));
    for (const session of orderedSessions) {
      const label = roleLabel(session.role);
      await clickSessionTab(label);
      await delay(250);
      await scrollToTop();
      const targetPath = buildShotPath(`desktop-session-${slugify(label)}`, liveItem.title);
      await captureFullScreenshot(targetPath);
      shots.push({
        name: path.basename(targetPath),
        kind: 'session',
        mode: 'desktop',
        path: targetPath,
        change_unit_id: liveItem.id,
        title: liveItem.title,
        session_role: session.role,
      });
    }
  }

  for (const item of items) {
    await runBrowser(['open', `${baseUrl}/?change=${encodeURIComponent(item.id)}`]);
    await setViewport(430, 932);
    await waitForText(item.title);
    await waitForText('What changed and how to review it');
    await scrollToTop();
    const targetPath = buildShotPath(`mobile-${String(shots.length).padStart(2, '0')}`, item.title);
    await captureViewportScreenshot(targetPath);
    shots.push({
      name: path.basename(targetPath),
      kind: 'mobile',
      mode: 'mobile',
      path: targetPath,
      change_unit_id: item.id,
      title: item.title,
    });
  }

  const browserErrors = await runBrowser(['errors'], true).catch(() => '');
  detectPageErrors(browserErrors);

  await fs.writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        base_url: baseUrl,
        primary_change_id: changeId,
        created_change_id: createdItemFromUi?.id ?? null,
        created_change_title: createdItemFromUi?.title ?? null,
        live_change_id: liveItem?.id ?? null,
        screenshots: shots,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  await runBrowser(['close']);
  console.log(`Browser validation passed. Screenshot: ${screenshotPath}`);
  console.log(`UX tour manifest: ${manifestPath}`);
} finally {
  server.kill('SIGTERM');
}
