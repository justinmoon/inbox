import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  ChangeUnitExecutionLaunched,
  CodexFileChangeEntry,
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

type PendingToolItem = {
  turnId: string;
  itemId: string;
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

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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

function pushUniqueItem(turn: MutableTurn, item: CodexThreadItem) {
  const previous = turn.items.at(-1);
  if (
    previous?.type === item.type &&
    previous.type === 'agentMessage' &&
    item.type === 'agentMessage' &&
    previous.text === item.text
  ) {
    return;
  }

  turn.items.push(item);
}

function parseFunctionArguments(rawArguments: unknown): Record<string, unknown> {
  if (typeof rawArguments !== 'string') {
    return isObject(rawArguments) ? rawArguments : {};
  }

  try {
    const parsed = JSON.parse(rawArguments);
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseJsonString(rawValue: unknown): unknown {
  if (typeof rawValue !== 'string') return rawValue;

  try {
    return JSON.parse(rawValue);
  } catch {
    return rawValue;
  }
}

function parseCustomToolOutput(rawOutput: unknown): Record<string, unknown> | null {
  const parsed = parseJsonString(rawOutput);
  return isObject(parsed) ? parsed : null;
}

function readResponseMessageText(payload: Record<string, unknown>): string | null {
  const content = payload.content;
  if (!Array.isArray(content)) return null;

  const textParts = content.flatMap((entry) => {
    if (!isObject(entry)) return [];
    const text =
      readString(entry.text) ??
      readString(entry.output_text) ??
      readString(entry.input_text) ??
      readString(entry.value);
    return text ? [text] : [];
  });

  return textParts.length > 0 ? textParts.join('\n\n') : null;
}

function normalizeCapturedStatus(status: string | null | undefined) {
  switch (status) {
    case 'completed':
    case 'failed':
    case 'declined':
      return status;
    case 'inProgress':
    case 'in_progress':
      return 'in_progress';
    default:
      return status ?? 'completed';
  }
}

function createCapturedFallbackItem(args: {
  id: string;
  source: 'event_msg' | 'response_item';
  rawType: string;
  payload: Record<string, unknown>;
  note: string;
}): CodexThreadItem {
  return {
    type: 'capturedRecord',
    id: args.id,
    source: args.source,
    rawType: args.rawType,
    note: args.note,
    payload: args.payload,
  };
}

function parseApplyPatchEntries(rawPatch: string): CodexFileChangeEntry[] {
  const lines = rawPatch.split('\n');
  const entries: CodexFileChangeEntry[] = [];
  let current: CodexFileChangeEntry | null = null;
  let diffLines: string[] = [];

  function flushCurrent() {
    if (!current) return;
    const diff = diffLines.join('\n').trim();
    entries.push({
      ...current,
      diff: diff || current.diff || null,
      note: current.note ?? null,
    });
    current = null;
    diffLines = [];
  }

  for (const line of lines) {
    const addMatch = line.match(/^\*\*\* Add File: (.+)$/);
    if (addMatch) {
      flushCurrent();
      current = { path: addMatch[1], kind: 'add' };
      continue;
    }

    const updateMatch = line.match(/^\*\*\* Update File: (.+)$/);
    if (updateMatch) {
      flushCurrent();
      current = { path: updateMatch[1], kind: 'update' };
      continue;
    }

    const deleteMatch = line.match(/^\*\*\* Delete File: (.+)$/);
    if (deleteMatch) {
      flushCurrent();
      current = { path: deleteMatch[1], kind: 'delete', note: 'Deleted file.' };
      continue;
    }

    const moveMatch = line.match(/^\*\*\* Move to: (.+)$/);
    if (moveMatch) {
      if (!current) {
        current = { kind: 'move', note: `Moved to ${moveMatch[1]}.` };
      } else {
        current.note = current.note ? `${current.note} Moved to ${moveMatch[1]}.` : `Moved to ${moveMatch[1]}.`;
        current.kind = current.kind ?? 'move';
      }
      continue;
    }

    if (line === '*** Begin Patch' || line === '*** End Patch') {
      continue;
    }

    if (!current) {
      diffLines.push(line);
      continue;
    }

    diffLines.push(line);
  }

  flushCurrent();

  if (entries.length === 0 && rawPatch.trim()) {
    return [{ kind: 'patch', diff: rawPatch.trim(), note: 'Captured apply_patch payload.' }];
  }

  return entries;
}

function buildToolItem(args: {
  activeTurnId: string;
  index: number;
  name: string;
  argumentsObject: Record<string, unknown>;
  rawPayload: Record<string, unknown>;
}): CodexThreadItem {
  const { activeTurnId, index, name, argumentsObject, rawPayload } = args;

  if (name === 'exec_command') {
    return {
      type: 'commandExecution',
      id: `${activeTurnId}-command-${index}`,
      command: readString(argumentsObject.cmd) ?? JSON.stringify(argumentsObject),
      cwd: readString(argumentsObject.workdir) ?? '',
      processId: null,
      status: 'in_progress',
      commandActions: Array.isArray(argumentsObject.commandActions)
        ? argumentsObject.commandActions
        : [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    };
  }

  if (name === 'view_image') {
    return {
      type: 'imageView',
      id: `${activeTurnId}-image-${index}`,
      path: readString(argumentsObject.path) ?? readString(argumentsObject.image_path) ?? 'unknown',
    };
  }

  if (name === 'web_search' || name === 'search_query' || name === 'image_query') {
    return {
      type: 'webSearch',
      id: `${activeTurnId}-search-${index}`,
      query:
        readString(argumentsObject.q) ??
        readString(argumentsObject.query) ??
        readString(argumentsObject.search) ??
        name,
      action: rawPayload,
    };
  }

  if (name.startsWith('mcp__')) {
    const [, server = 'mcp', tool = name] = name.split('__');
    return {
      type: 'mcpToolCall',
      id: `${activeTurnId}-mcp-${index}`,
      server,
      tool,
      status: 'in_progress',
      arguments: argumentsObject,
      result: null,
      error: null,
      durationMs: null,
    };
  }

  if (
    name === 'spawn_agent' ||
    name === 'send_input' ||
    name === 'resume_agent' ||
    name === 'close_agent' ||
    name === 'wait'
  ) {
    const receiverThreadIds = Array.isArray(argumentsObject.ids)
      ? argumentsObject.ids.filter((entry): entry is string => typeof entry === 'string')
      : readString(argumentsObject.id)
        ? [readString(argumentsObject.id)!]
        : [];

    return {
      type: 'collabAgentToolCall',
      id: `${activeTurnId}-collab-${index}`,
      tool: name,
      status: 'in_progress',
      senderThreadId: readString(argumentsObject.sender_thread_id) ?? '',
      receiverThreadIds,
      prompt: readString(argumentsObject.message) ?? readString(argumentsObject.prompt),
      agentsStates: {},
    };
  }

  if (name === 'apply_patch') {
    const rawPatch = readString(argumentsObject.input) ?? readString(rawPayload.input) ?? '';
    return {
      type: 'fileChange',
      id: `${activeTurnId}-file-${index}`,
      changes: parseApplyPatchEntries(rawPatch),
      status: 'in_progress',
      rawOutput: null,
    };
  }

  return {
    type: 'dynamicToolCall',
    id: `${activeTurnId}-tool-${index}`,
    tool: name,
    arguments: argumentsObject,
    status: 'in_progress',
    contentItems: null,
    success: null,
    durationMs: null,
  };
}

function updatePendingToolItem(args: {
  pendingItem: CodexThreadItem;
  payload: Record<string, unknown>;
  rawOutputText: string | null;
  parsedOutput: unknown;
}) {
  const { pendingItem, payload, rawOutputText, parsedOutput } = args;

  if (pendingItem.type === 'commandExecution') {
    const details = parseCommandOutput(rawOutputText ?? '');
    pendingItem.status = details.exitCode === 0 ? 'completed' : 'failed';
    pendingItem.aggregatedOutput = details.aggregatedOutput || null;
    pendingItem.exitCode = details.exitCode;
    pendingItem.durationMs = details.durationMs;
    return;
  }

  if (pendingItem.type === 'fileChange') {
    pendingItem.status = normalizeCapturedStatus(readString(payload.status));
    pendingItem.rawOutput = rawOutputText ?? pendingItem.rawOutput ?? null;
    return;
  }

  if (pendingItem.type === 'mcpToolCall') {
    pendingItem.status = normalizeCapturedStatus(readString(payload.status));
    pendingItem.result = parsedOutput ?? rawOutputText;
    pendingItem.error =
      pendingItem.status === 'failed'
        ? (isObject(parsedOutput) ? parsedOutput : rawOutputText)
        : pendingItem.error;
    pendingItem.durationMs = readNumber(payload.duration_ms) ?? pendingItem.durationMs ?? null;
    return;
  }

  if (pendingItem.type === 'collabAgentToolCall') {
    pendingItem.status = normalizeCapturedStatus(readString(payload.status));
    if (isObject(parsedOutput)) {
      pendingItem.agentsStates = parsedOutput;
    }
    return;
  }

  if (pendingItem.type === 'dynamicToolCall') {
    pendingItem.status = normalizeCapturedStatus(readString(payload.status));
    pendingItem.success =
      pendingItem.status === 'completed'
        ? true
        : pendingItem.status === 'failed'
          ? false
          : pendingItem.success;
    pendingItem.contentItems =
      Array.isArray(parsedOutput) ? parsedOutput : parsedOutput ? [parsedOutput] : rawOutputText ? [{ type: 'text', text: rawOutputText }] : null;
    pendingItem.durationMs = readNumber(payload.duration_ms) ?? pendingItem.durationMs ?? null;
    return;
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
  const pendingToolItems = new Map<string, PendingToolItem>();
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
      if (!eventType) continue;

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
        pushUniqueItem(turn, {
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
        pushUniqueItem(turn, {
          type: 'agentMessage',
          id: `${activeTurnId}-agent-${turn.items.length + 1}`,
          text: message,
          phase: readString(payload.phase),
        });
        continue;
      }

      if (eventType === 'token_count') {
        continue;
      }

      pushUniqueItem(turn, createCapturedFallbackItem({
        id: `${activeTurnId}-event-${turn.items.length + 1}`,
        source: 'event_msg',
        rawType: eventType,
        payload,
        note: `Captured rollout event "${eventType}" could not be reconstructed as a first-class Codex item.`,
      }));
      continue;
    }

    if (record.type !== 'response_item' || !activeTurnId) {
      continue;
    }

    const turn = ensureTurn(turnsById, turnOrder, activeTurnId);
    const itemType = readString(payload.type);
    if (!itemType) continue;

    if (itemType === 'reasoning') {
      pushUniqueItem(turn, {
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

    if (itemType === 'message') {
      const messageText = readResponseMessageText(payload);
      const role = readString(payload.role);
      if (!messageText) continue;

      if (role === 'assistant') {
        pushUniqueItem(turn, {
          type: 'agentMessage',
          id: `${activeTurnId}-assistant-${turn.items.length + 1}`,
          text: messageText,
          phase: readString(payload.phase),
        });
      } else if (role === 'user') {
        pushUniqueItem(turn, {
          type: 'userMessage',
          id: `${activeTurnId}-user-${turn.items.length + 1}`,
          content: [{ type: 'text', text: messageText }],
        });
      } else {
        pushUniqueItem(turn, createCapturedFallbackItem({
          id: `${activeTurnId}-message-${turn.items.length + 1}`,
          source: 'response_item',
          rawType: itemType,
          payload,
          note: `Captured rollout message with role "${role ?? 'unknown'}" was preserved as raw data.`,
        }));
      }
      continue;
    }

    if (itemType === 'function_call') {
      const callId = readString(payload.call_id) ?? `${activeTurnId}-tool-${turn.items.length + 1}`;
      const name = readString(payload.name) ?? 'tool';
      const argumentsObject = parseFunctionArguments(payload.arguments);
      const item = buildToolItem({
        activeTurnId,
        index: turn.items.length + 1,
        name,
        argumentsObject,
        rawPayload: payload,
      });
      pushUniqueItem(turn, item);
      pendingToolItems.set(callId, { turnId: activeTurnId, itemId: item.id });
      continue;
    }

    if (itemType === 'function_call_output') {
      const callId = readString(payload.call_id);
      if (!callId) continue;

      const pending = pendingToolItems.get(callId);
      if (!pending) {
        pushUniqueItem(turn, createCapturedFallbackItem({
          id: `${activeTurnId}-orphan-output-${turn.items.length + 1}`,
          source: 'response_item',
          rawType: itemType,
          payload,
          note: 'Captured rollout tool output did not match a started tool item and was preserved as raw data.',
        }));
        continue;
      }

      const pendingTurn = turnsById.get(pending.turnId);
      const pendingItem = pendingTurn?.items.find((item) => item.id === pending.itemId);
      if (!pendingItem) continue;

      const rawOutputText = readString(payload.output);
      const parsedOutput = parseJsonString(payload.output);
      updatePendingToolItem({ pendingItem, payload, rawOutputText, parsedOutput });
      pendingToolItems.delete(callId);
      continue;
    }

    if (itemType === 'custom_tool_call') {
      const callId = readString(payload.call_id) ?? `${activeTurnId}-custom-${turn.items.length + 1}`;
      const toolName = readString(payload.name) ?? 'custom_tool';
      const rawInput = readString(payload.input) ?? '';
      const item =
        toolName === 'apply_patch'
          ? ({
              type: 'fileChange',
              id: `${activeTurnId}-file-${turn.items.length + 1}`,
              changes: parseApplyPatchEntries(rawInput),
              status: normalizeCapturedStatus(readString(payload.status)),
              rawOutput: null,
            } satisfies CodexThreadItem)
          : buildToolItem({
              activeTurnId,
              index: turn.items.length + 1,
              name: toolName,
              argumentsObject: parseFunctionArguments(rawInput),
              rawPayload: payload,
            });

      pushUniqueItem(turn, item);
      pendingToolItems.set(callId, { turnId: activeTurnId, itemId: item.id });
      continue;
    }

    if (itemType === 'custom_tool_call_output') {
      const callId = readString(payload.call_id);
      if (!callId) continue;

      const pending = pendingToolItems.get(callId);
      if (!pending) {
        pushUniqueItem(turn, createCapturedFallbackItem({
          id: `${activeTurnId}-orphan-custom-output-${turn.items.length + 1}`,
          source: 'response_item',
          rawType: itemType,
          payload,
          note: 'Captured custom tool output did not match a started tool item and was preserved as raw data.',
        }));
        continue;
      }

      const pendingTurn = turnsById.get(pending.turnId);
      const pendingItem = pendingTurn?.items.find((item) => item.id === pending.itemId);
      if (!pendingItem) continue;

      const parsedOutputRecord = parseCustomToolOutput(payload.output);
      const rawOutputText =
        (parsedOutputRecord && readString(parsedOutputRecord.output)) ?? readString(payload.output);
      updatePendingToolItem({
        pendingItem,
        payload,
        rawOutputText,
        parsedOutput: parsedOutputRecord ?? parseJsonString(payload.output),
      });
      pendingToolItems.delete(callId);
      continue;
    }

    pushUniqueItem(turn, createCapturedFallbackItem({
      id: `${activeTurnId}-raw-${turn.items.length + 1}`,
      source: 'response_item',
      rawType: itemType,
      payload,
      note: `Captured rollout item "${itemType}" is not fully reconstructable from JSONL, so raw payload is shown instead.`,
    }));
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
    turns: turnOrder
      .map((turnId) => turnsById.get(turnId))
      .filter((turn): turn is MutableTurn => Boolean(turn)),
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
          approvals: [],
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
          approvals: [],
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
          approvals: [],
        };
      }
    }),
  );
}

export async function buildLiveSessionView(args: {
  execution: ChangeUnitExecutionLaunched;
  approvals: CodexSessionView['approvals'];
  ensureAppServerStarted: () => Promise<void>;
  appServerRequest: (method: string, params: unknown) => Promise<unknown>;
}): Promise<CodexSessionView> {
  const { execution, approvals, ensureAppServerStarted, appServerRequest } = args;

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
        workspace_path: execution.workspace?.path ?? null,
        workspace_strategy: execution.workspace?.strategy ?? null,
      },
      thread: normalizeCodexThread(readResult),
      load_error: null,
      approvals,
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
        workspace_path: execution.workspace?.path ?? null,
        workspace_strategy: execution.workspace?.strategy ?? null,
      },
      thread: null,
      load_error: error instanceof Error ? error.message : 'Failed to load launched thread.',
      approvals,
    };
  }
}
