import type { CodexThread } from '../shared/api.ts';
import { AppServerProcess, type AppServerMessage } from './appServerProcess.ts';
import { normalizeCodexThread } from './codexSessions.ts';

type ClientInfo = {
  name: string;
  title: string;
  version: string;
};

type StartThreadInput = {
  cwd?: string | null;
  approvalPolicy?: 'on-request' | 'on-failure' | 'never' | 'untrusted';
  sandboxPolicy?: unknown;
  model?: string | null;
  persistExtendedHistory?: boolean;
  personality?: 'friendly' | 'pragmatic' | 'none';
};

type ResumeThreadInput = StartThreadInput & {
  threadId: string;
};

type StartTurnInput = {
  threadId: string;
  text: string;
  cwd?: string | null;
  approvalPolicy?: 'on-request' | 'on-failure' | 'never' | 'untrusted';
  sandboxPolicy?: unknown;
  model?: string | null;
};

type WaitForTurnCompletionInput = {
  threadId: string;
  turnId: string;
  timeoutMs?: number;
};

type ThreadNotificationListener = (message: AppServerMessage) => void;

export interface CodexClient {
  ensureStarted(): Promise<void>;
  startThread(input: StartThreadInput): Promise<{ threadId: string }>;
  resumeThread(input: ResumeThreadInput): Promise<{ threadId: string }>;
  startTurn(input: StartTurnInput): Promise<{ turnId: string }>;
  waitForTurnCompletion(input: WaitForTurnCompletionInput): Promise<{ turnId: string; status: string }>;
  readThread(input: { threadId: string; includeTurns?: boolean }): Promise<CodexThread>;
  onNotification(listener: ThreadNotificationListener): () => void;
  onServerRequest(listener: ThreadNotificationListener): () => void;
  respond(id: number, result: unknown): Promise<void>;
  respondError(id: number, message: string): Promise<void>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function extractTurnStatus(message: AppServerMessage) {
  const params = isObject(message.params) ? message.params : null;
  const turn = params && isObject(params.turn) ? params.turn : null;
  return {
    threadId:
      typeof params?.threadId === 'string'
        ? params.threadId
        : typeof turn?.threadId === 'string'
          ? turn.threadId
          : null,
    turnId: typeof turn?.id === 'string' ? turn.id : null,
    status: typeof turn?.status === 'string' ? turn.status : null,
  };
}

export class AppServerCodexClient implements CodexClient {
  #process: AppServerProcess;
  #clientInfo: ClientInfo;
  #ensureStarted: (() => Promise<void>) | null;

  constructor(args: {
    process: AppServerProcess;
    clientInfo: ClientInfo;
    ensureStarted?: () => Promise<void>;
  }) {
    this.#process = args.process;
    this.#clientInfo = args.clientInfo;
    this.#ensureStarted = args.ensureStarted ?? null;
  }

  async ensureStarted() {
    if (this.#ensureStarted) {
      await this.#ensureStarted();
      return;
    }

    await this.#process.start(this.#clientInfo);
  }

  async startThread(input: StartThreadInput) {
    await this.ensureStarted();
    const result = await this.#process.request('thread/start', {
      cwd: input.cwd ?? undefined,
      approvalPolicy: input.approvalPolicy ?? undefined,
      sandboxPolicy: input.sandboxPolicy ?? undefined,
      model: input.model ?? undefined,
      persistExtendedHistory: input.persistExtendedHistory ?? true,
      personality: input.personality ?? 'pragmatic',
    });

    return { threadId: extractThreadId(result) };
  }

  async resumeThread(input: ResumeThreadInput) {
    await this.ensureStarted();
    const result = await this.#process.request('thread/resume', {
      threadId: input.threadId,
      approvalPolicy: input.approvalPolicy ?? undefined,
      sandboxPolicy: input.sandboxPolicy ?? undefined,
      model: input.model ?? undefined,
      persistExtendedHistory: input.persistExtendedHistory ?? true,
      personality: input.personality ?? 'pragmatic',
    });

    return { threadId: extractThreadId(result) };
  }

  async startTurn(input: StartTurnInput) {
    await this.ensureStarted();
    const result = await this.#process.request('turn/start', {
      threadId: input.threadId,
      input: [{ type: 'text', text: input.text, textElements: [] }],
      cwd: input.cwd ?? undefined,
      approvalPolicy: input.approvalPolicy ?? undefined,
      sandboxPolicy: input.sandboxPolicy ?? undefined,
      model: input.model ?? undefined,
    });

    return { turnId: extractTurnId(result) };
  }

  async waitForTurnCompletion(input: WaitForTurnCompletionInput) {
    await this.ensureStarted();

    return await new Promise<{ turnId: string; status: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout waiting for turn ${input.turnId} to complete.`));
      }, input.timeoutMs ?? 60_000);

      const listener = (message: AppServerMessage) => {
        if (message.method !== 'turn/completed') {
          return;
        }

        const { threadId, turnId, status } = extractTurnStatus(message);
        if (threadId !== input.threadId || turnId !== input.turnId || !status) {
          return;
        }

        cleanup();
        resolve({ turnId, status });
      };

      const cleanup = () => {
        clearTimeout(timeout);
        this.#process.off('notification', listener);
      };

      this.#process.on('notification', listener);
    });
  }

  async readThread(input: { threadId: string; includeTurns?: boolean }) {
    await this.ensureStarted();
    const result = await this.#process.request('thread/read', {
      threadId: input.threadId,
      includeTurns: input.includeTurns ?? true,
    });

    return normalizeCodexThread(result);
  }

  onNotification(listener: ThreadNotificationListener) {
    this.#process.on('notification', listener);
    return () => {
      this.#process.off('notification', listener);
    };
  }

  onServerRequest(listener: ThreadNotificationListener) {
    this.#process.on('serverRequest', listener);
    return () => {
      this.#process.off('serverRequest', listener);
    };
  }

  async respond(id: number, result: unknown) {
    await this.#process.respond(id, result);
  }

  async respondError(id: number, message: string) {
    await this.#process.respondError(id, message);
  }
}
