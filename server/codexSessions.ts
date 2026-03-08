import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  ChangeUnitExecutionLaunched,
  CodexSessionView,
  CodexThread,
  CodexThreadItem,
  CodexTurn,
} from '../shared/api.ts';
import type { LoadedBundle } from './importBundles.ts';

type MutableTurn = CodexTurn & {
  items: CodexThreadItem[];
};

type RawRecord = {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function normalizeCodexThread(result: unknown): CodexThread {
  if (!isObject(result) || !isObject(result.thread)) {
    throw new Error('Codex app-server returned an invalid thread response.');
  }

  const thread = result.thread;
  if (typeof thread.id !== 'string') {
    throw new Error('Codex app-server returned a thread without an id.');
  }

  return {
    id: thread.id,
    preview: readString(thread.preview) ?? '',
    ephemeral: thread.ephemeral === true,
    modelProvider: readString(thread.modelProvider) ?? 'unknown',
    createdAt: typeof thread.createdAt === 'number' ? thread.createdAt : 0,
    updatedAt: typeof thread.updatedAt === 'number' ? thread.updatedAt : 0,
    status: thread.status ?? null,
    path: readString(thread.path),
    cwd: readString(thread.cwd) ?? '',
    cliVersion: readString(thread.cliVersion) ?? '',
    source: thread.source ?? null,
    agentNickname: readString(thread.agentNickname),
    agentRole: readString(thread.agentRole),
    name: readString(thread.name),
    turns: Array.isArray(thread.turns) ? (thread.turns as CodexThread['turns']) : [],
  };
}

function resolveBundleRelativePath(bundlePath: string, candidatePath: string) {
  return path.isAbsolute(candidatePath)
    ? candidatePath
    : path.resolve(path.dirname(bundlePath), candidatePath);
}

function parseCommandOutput(output: string) {
  const exitCodeMatch = output.match(/Process exited with code (\d+)/);
  const wallTimeMatch = output.match(/Wall time: ([\d.]+) seconds/);
  const bodyStart = output.indexOf('Output:\n');

  return {
    exitCode: exitCodeMatch ? Number(exitCodeMatch[1]) : null,
    durationMs: wallTimeMatch ? Math.round(Number(wallTimeMatch[1]) * 1000) : null,
    aggregatedOutput: bodyStart >= 0 ? output.slice(bodyStart + 'Output:\n'.length).trim() : output.trim(),
  };
}

function ensureTurn(turnsById: Map<string, MutableTurn>, turnOrder: string[], turnId: string) {
  const existing = turnsById.get(turnId);
  if (existing) {
    return existing;
  }

  const turn: MutableTurn = {
    id: turnId,
    items: [],
    status: 'completed',
    error: null,
  };
  turnsById.set(turnId, turn);
  turnOrder.push(turnId);
  return turn;
}

function parseFunctionArguments(rawArguments: unknown): Record<string, unknown> {
  if (typeof rawArguments !== 'string') return {};

  try {
    const parsed = JSON.parse(rawArguments);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseCustomToolOutput(rawOutput: unknown): Record<string, unknown> | null {
  if (typeof rawOutput !== 'string') return null;

  try {
    const parsed = JSON.parse(rawOutput);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function loadCapturedThread(bundleRecord: LoadedBundle, relativePath: string): Promise<CodexThread> {
  const rolloutPath = resolveBundleRelativePath(bundleRecord.bundlePath, relativePath);
  const content = await fs.readFile(rolloutPath, 'utf8');
  const records = content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RawRecord);

  const sessionMeta = records.find((record) => record.type === 'session_meta' && isObject(record.payload));
  const turnsById = new Map<string, MutableTurn>();
  const turnOrder: string[] = [];
  const pendingToolItems = new Map<string, { turnId: string; itemId: string }>();
  let activeTurnId: string | null = null;
  let preview = '';

  for (const record of records) {
    const payload = isObject(record.payload) ? record.payload : null;
    if (!payload) continue;

    if (record.type === 'turn_context') {
      const turnId = readString(payload.turn_id);
      if (turnId) {
        ensureTurn(turnsById, turnOrder, turnId);
      }
      continue;
    }

    if (record.type === 'event_msg') {
      const eventType = readString(payload.type);

      if (eventType === 'task_started') {
        const turnId = readString(payload.turn_id);
        if (turnId) {
          activeTurnId = turnId;
          ensureTurn(turnsById, turnOrder, turnId).status = 'in_progress';
        }
        continue;
      }

      if (eventType === 'task_complete') {
        const turnId = readString(payload.turn_id) ?? activeTurnId;
        if (turnId) {
          ensureTurn(turnsById, turnOrder, turnId).status = 'completed';
        }
        continue;
      }

      if (!activeTurnId) continue;
      const turn = ensureTurn(turnsById, turnOrder, activeTurnId);

      if (eventType === 'user_message') {
        const message = readString(payload.message);
        if (!message) continue;
        turn.items.push({
          type: 'userMessage',
          id: `${activeTurnId}-user-${turn.items.length + 1}`,
          content: [{ type: 'text', text: message }],
        });
        if (!preview) preview = message;
        continue;
      }

      if (eventType === 'agent_message') {
        const message = readString(payload.message);
        if (!message) continue;
        turn.items.push({
          type: 'agentMessage',
          id: `${activeTurnId}-agent-${turn.items.length + 1}`,
          text: message,
          phase: readString(payload.phase),
        });
        continue;
      }

      continue;
    }

    if (record.type !== 'response_item' || !activeTurnId) {
      continue;
    }

    const turn = ensureTurn(turnsById, turnOrder, activeTurnId);
    const itemType = readString(payload.type);
    if (!itemType) continue;

    if (itemType === 'reasoning') {
      turn.items.push({
        type: 'reasoning',
        id: `${activeTurnId}-reasoning-${turn.items.length + 1}`,
        summary: readStringArray(payload.summary),
        content:
          readStringArray(payload.content).length > 0
            ? readStringArray(payload.content)
            : readString(payload.encrypted_content)
              ? ['Encrypted reasoning content captured in rollout history.']
              : [],
      });
      continue;
    }

    if (itemType === 'function_call') {
      const callId = readString(payload.call_id) ?? `${activeTurnId}-tool-${turn.items.length + 1}`;
      const name = readString(payload.name) ?? 'tool';
      const argumentsObject = parseFunctionArguments(payload.arguments);

      if (name === 'exec_command') {
        const itemId = `${activeTurnId}-command-${turn.items.length + 1}`;
        turn.items.push({
          type: 'commandExecution',
          id: itemId,
          command: readString(argumentsObject.cmd) ?? '{}',
          cwd: readString(argumentsObject.workdir) ?? '',
          processId: null,
          status: 'in_progress',
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        });
        pendingToolItems.set(callId, { turnId: activeTurnId, itemId });
      } else {
        const itemId = `${activeTurnId}-tool-${turn.items.length + 1}`;
        turn.items.push({
          type: 'dynamicToolCall',
          id: itemId,
          tool: name,
          arguments: argumentsObject,
          status: 'in_progress',
          contentItems: null,
          success: null,
          durationMs: null,
        });
        pendingToolItems.set(callId, { turnId: activeTurnId, itemId });
      }
      continue;
    }

    if (itemType === 'function_call_output') {
      const callId = readString(payload.call_id);
      if (!callId) continue;

      const pending = pendingToolItems.get(callId);
      if (!pending) continue;

      const pendingTurn = turnsById.get(pending.turnId);
      const pendingItem = pendingTurn?.items.find((item) => item.id === pending.itemId);
      if (!pendingItem) continue;

      if (pendingItem.type === 'commandExecution') {
        const details = parseCommandOutput(readString(payload.output) ?? '');
        pendingItem.status = details.exitCode === 0 ? 'completed' : 'failed';
        pendingItem.aggregatedOutput = details.aggregatedOutput || null;
        pendingItem.exitCode = details.exitCode;
        pendingItem.durationMs = details.durationMs;
      } else if (pendingItem.type === 'dynamicToolCall') {
        const rawOutput = readString(payload.output);
        pendingItem.status = 'completed';
        pendingItem.success = true;
        pendingItem.contentItems = rawOutput ? [{ type: 'text', text: rawOutput }] : null;
      }

      pendingToolItems.delete(callId);
      continue;
    }

    if (itemType === 'custom_tool_call') {
      const callId = readString(payload.call_id) ?? `${activeTurnId}-file-${turn.items.length + 1}`;
      const toolName = readString(payload.name) ?? 'custom_tool';
      const itemId = `${activeTurnId}-${toolName}-${turn.items.length + 1}`;

      if (toolName === 'apply_patch') {
        turn.items.push({
          type: 'fileChange',
          id: itemId,
          changes: [readString(payload.input) ?? ''],
          status: readString(payload.status) ?? 'completed',
        });
      } else {
        turn.items.push({
          type: 'dynamicToolCall',
          id: itemId,
          tool: toolName,
          arguments: readString(payload.input) ?? '',
          status: readString(payload.status) ?? 'completed',
          contentItems: null,
          success: readString(payload.status) === 'completed',
          durationMs: null,
        });
      }

      pendingToolItems.set(callId, { turnId: activeTurnId, itemId });
      continue;
    }

    if (itemType === 'custom_tool_call_output') {
      const callId = readString(payload.call_id);
      if (!callId) continue;

      const pending = pendingToolItems.get(callId);
      if (!pending) continue;

      const pendingTurn = turnsById.get(pending.turnId);
      const pendingItem = pendingTurn?.items.find((item) => item.id === pending.itemId);
      if (!pendingItem) continue;

      const rawOutput = parseCustomToolOutput(payload.output);

      if (pendingItem.type === 'fileChange') {
        const fileChangeItem = pendingItem as Extract<CodexThreadItem, { type: 'fileChange' }>;
        fileChangeItem.status = fileChangeItem.status || 'completed';
        const outputText =
          rawOutput && typeof rawOutput.output === 'string' ? rawOutput.output : null;
        if (outputText) {
          fileChangeItem.changes = [...fileChangeItem.changes, outputText];
        }
      } else if (pendingItem.type === 'dynamicToolCall') {
        pendingItem.status = 'completed';
        pendingItem.success = true;
        pendingItem.contentItems = rawOutput ? [rawOutput] : null;
      }

      pendingToolItems.delete(callId);
    }
  }

  const metaPayload = isObject(sessionMeta?.payload) ? sessionMeta.payload : {};
  const threadId = readString(metaPayload.id) ?? path.basename(rolloutPath, path.extname(rolloutPath));
  const createdAtIso = readString(metaPayload.timestamp);
  const createdAt = createdAtIso ? Date.parse(createdAtIso) / 1000 : 0;
  const updatedAtIso = [...records].reverse().map((record) => readString(record.timestamp)).find(Boolean);
  const updatedAt = updatedAtIso ? Date.parse(updatedAtIso) / 1000 : createdAt;

  return {
    id: threadId,
    preview,
    ephemeral: false,
    modelProvider: readString(metaPayload.model_provider) ?? 'openai',
    createdAt,
    updatedAt,
    status: 'completed',
    path: rolloutPath,
    cwd: readString(metaPayload.cwd) ?? '',
    cliVersion: readString(metaPayload.cli_version) ?? '',
    source: readString(metaPayload.source) ?? 'captured_rollout',
    agentNickname: null,
    agentRole: null,
    name: null,
    turns: turnOrder.map((turnId) => turnsById.get(turnId)).filter((turn): turn is MutableTurn => Boolean(turn)),
  };
}

export async function buildLinkedSessionViews(args: {
  bundleRecord: LoadedBundle;
  ensureAppServerStarted: () => Promise<void>;
  appServerRequest: (method: string, params: unknown) => Promise<unknown>;
}): Promise<CodexSessionView[]> {
  const { bundleRecord } = args;

  return await Promise.all(
    bundleRecord.bundle.agent_sessions.map(async (session) => {
      if (session.thread_capture?.kind !== 'rollout_path') {
        return {
          id: session.id,
          role: session.role,
          runtime: session.runtime,
          status: session.status,
          source_kind: 'linked' as const,
          summary: session.summary ?? null,
          milestones: session.milestones,
          launched_from: null,
          thread: null,
          load_error: 'This session does not include a Codex-native rollout capture.',
        };
      }

      try {
        const thread = await loadCapturedThread(bundleRecord, session.thread_capture.path);

        return {
          id: session.id,
          role: session.role,
          runtime: session.runtime,
          status: session.status,
          source_kind: 'linked' as const,
          summary: session.summary ?? session.transcript?.summary ?? null,
          milestones: session.milestones,
          launched_from: null,
          thread,
          load_error: null,
        };
      } catch (error) {
        return {
          id: session.id,
          role: session.role,
          runtime: session.runtime,
          status: session.status,
          source_kind: 'linked' as const,
          summary: session.summary ?? session.transcript?.summary ?? null,
          milestones: session.milestones,
          launched_from: null,
          thread: null,
          load_error:
            error instanceof Error ? error.message : 'Failed to load captured Codex thread.',
        };
      }
    }),
  );
}

export async function buildLiveSessionView(args: {
  execution: ChangeUnitExecutionLaunched;
  ensureAppServerStarted: () => Promise<void>;
  appServerRequest: (method: string, params: unknown) => Promise<unknown>;
}): Promise<CodexSessionView> {
  const { execution, ensureAppServerStarted, appServerRequest } = args;

  await ensureAppServerStarted();

  try {
    const readResult = await appServerRequest('thread/read', {
      threadId: execution.thread_id,
      includeTurns: true,
    });

    return {
      id: `live:${execution.thread_id}`,
      role: 'live_session',
      runtime: 'codex',
      status: 'active',
      source_kind: 'live',
      summary: execution.message ?? null,
      milestones: [],
      launched_from: {
        action_label: execution.action_label,
        started_at: execution.started_at,
        thread_source: execution.thread_source,
        turn_id: execution.turn_id,
      },
      thread: normalizeCodexThread(readResult),
      load_error: null,
    };
  } catch (error) {
    return {
      id: `live:${execution.thread_id}`,
      role: 'live_session',
      runtime: 'codex',
      status: 'active',
      source_kind: 'live',
      summary: execution.message ?? null,
      milestones: [],
      launched_from: {
        action_label: execution.action_label,
        started_at: execution.started_at,
        thread_source: execution.thread_source,
        turn_id: execution.turn_id,
      },
      thread: null,
      load_error: error instanceof Error ? error.message : 'Failed to load launched thread.',
    };
  }
}
