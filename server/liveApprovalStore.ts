import type { AppServerMessage } from './appServerProcess.ts';
import type { CodexFileChangeEntry, CodexLiveApproval } from '../shared/api.ts';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function readFileChangeEntries(value: unknown): CodexFileChangeEntry[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (!isObject(entry)) return [];
    return [
      {
        path: readString(entry.path),
        kind: readString(entry.kind),
        diff: readString(entry.diff),
        note: readString(entry.note) ?? readString(entry.summary),
      },
    ];
  });
}

function inferApprovalKind(method: string) {
  if (method.endsWith('commandExecution/requestApproval')) {
    return 'commandExecution' as const;
  }

  if (method.endsWith('fileChange/requestApproval')) {
    return 'fileChange' as const;
  }

  return 'other' as const;
}

type ApprovalRecord = CodexLiveApproval & {
  responder?: (decision: 'accept' | 'decline') => Promise<void>;
};

export class LiveApprovalStore {
  #byThread = new Map<string, ApprovalRecord[]>();
  #nextSyntheticId = -1;

  list(threadId: string): CodexLiveApproval[] {
    return [...(this.#byThread.get(threadId) ?? [])].sort((a, b) =>
      a.requested_at < b.requested_at ? 1 : -1,
    );
  }

  captureServerRequest(message: AppServerMessage): CodexLiveApproval | null {
    const requestId = typeof message.id === 'number' ? message.id : null;
    const method = typeof message.method === 'string' ? message.method : null;
    const params = isObject(message.params) ? message.params : null;
    if (requestId === null || !method || !params) return null;
    if (!method.endsWith('/requestApproval')) return null;

    const threadId = readString(params.threadId);
    if (!threadId) return null;

    const record: ApprovalRecord = {
      request_id: requestId,
      thread_id: threadId,
      turn_id: readString(params.turnId),
      item_id: readString(params.itemId),
      request_method: method,
      approval_kind: inferApprovalKind(method),
      status: 'pending',
      requested_at: new Date().toISOString(),
      answered_at: null,
      cleared_at: null,
      decision: null,
      reason: readString(params.reason),
      command: readString(params.command),
      cwd: readString(params.cwd),
      command_actions: Array.isArray(params.commandActions) ? params.commandActions : [],
      available_decisions: readStringArray(params.availableDecisions),
      changes: readFileChangeEntries(params.changes),
      additional_permissions: params.additionalPermissions ?? null,
      network_approval_context: params.networkApprovalContext ?? null,
      raw_params: params,
      synthetic: false,
    };

    this.#upsert(record);
    return this.#sanitize(record);
  }

  injectSynthetic(args: {
    threadId: string;
    turnId?: string | null;
    itemId?: string | null;
    kind: 'commandExecution' | 'fileChange';
  }): CodexLiveApproval {
    const requestedAt = new Date().toISOString();
    const requestId = this.#nextSyntheticId--;
    const record: ApprovalRecord =
      args.kind === 'commandExecution'
        ? {
            request_id: requestId,
            thread_id: args.threadId,
            turn_id: args.turnId ?? 'turn-approval-fixture',
            item_id: args.itemId ?? 'item-command-approval-fixture',
            request_method: 'item/commandExecution/requestApproval',
            approval_kind: 'commandExecution',
            status: 'pending',
            requested_at: requestedAt,
            answered_at: null,
            cleared_at: null,
            decision: null,
            reason: 'Validation fixture: confirm the proposed command before the live turn proceeds.',
            command: 'npm test -- --runInBand',
            cwd: '/tmp/inbox-approval-fixture',
            command_actions: ['run tests', 'read project files'],
            available_decisions: ['accept', 'decline'],
            changes: [],
            additional_permissions: null,
            network_approval_context: null,
            raw_params: null,
            synthetic: true,
            responder: async () => {},
          }
        : {
            request_id: requestId,
            thread_id: args.threadId,
            turn_id: args.turnId ?? 'turn-approval-fixture',
            item_id: args.itemId ?? 'item-file-approval-fixture',
            request_method: 'item/fileChange/requestApproval',
            approval_kind: 'fileChange',
            status: 'pending',
            requested_at: requestedAt,
            answered_at: null,
            cleared_at: null,
            decision: null,
            reason: 'Validation fixture: confirm the proposed patch before the live turn proceeds.',
            command: null,
            cwd: null,
            command_actions: [],
            available_decisions: ['accept', 'decline'],
            changes: [
              {
                path: 'src/validation.js',
                kind: 'update',
                diff: '@@\\n- return oldValue;\\n+ return nextValue;\\n',
                note: 'Synthetic file-change approval fixture.',
              },
            ],
            additional_permissions: null,
            network_approval_context: null,
            raw_params: null,
            synthetic: true,
            responder: async () => {},
          };

    this.#upsert(record);
    return this.#sanitize(record);
  }

  async answer(args: {
    threadId: string;
    requestId: number;
    decision: 'accept' | 'decline';
    responder?: (decision: 'accept' | 'decline') => Promise<void>;
  }): Promise<CodexLiveApproval> {
    const record = this.#find(args.threadId, args.requestId);
    if (!record) {
      throw new Error('Approval request not found.');
    }

    if (record.status !== 'pending') {
      throw new Error('Approval request has already been answered.');
    }

    await (args.responder ?? record.responder ?? (async () => {}))(args.decision);

    record.status = 'answered';
    record.decision = args.decision;
    record.answered_at = new Date().toISOString();
    record.cleared_at = null;
    return this.#sanitize(record);
  }

  resolve(threadId: string, requestId: number) {
    const record = this.#find(threadId, requestId);
    if (!record) return null;

    if (record.status === 'pending') {
      record.status = 'cleared';
      record.cleared_at = new Date().toISOString();
    }

    return this.#sanitize(record);
  }

  clearThread(threadId: string) {
    this.#byThread.delete(threadId);
  }

  #sanitize(record: ApprovalRecord): CodexLiveApproval {
    const { responder: _responder, ...approval } = record;
    return approval;
  }

  #find(threadId: string, requestId: number) {
    return (this.#byThread.get(threadId) ?? []).find((entry) => entry.request_id === requestId) ?? null;
  }

  #upsert(record: ApprovalRecord) {
    const entries = this.#byThread.get(record.thread_id) ?? [];
    const existingIndex = entries.findIndex((entry) => entry.request_id === record.request_id);

    if (existingIndex >= 0) {
      entries.splice(existingIndex, 1, {
        ...entries[existingIndex],
        ...record,
      });
    } else {
      entries.unshift(record);
    }

    this.#byThread.set(record.thread_id, entries.slice(0, 20));
  }
}
