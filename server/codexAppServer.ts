import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

function safeJsonParse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export class CodexAppServer extends EventEmitter {
  #codexBin: string;
  #child: ReturnType<typeof spawn> | null = null;
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();

  constructor(codexBin = 'codex') {
    super();
    this.#codexBin = codexBin;
  }

  async start() {
    if (this.#child) return;
    this.#child = spawn(this.#codexBin, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    await new Promise<void>((resolve, reject) => {
      this.#child!.once('spawn', () => resolve());
      this.#child!.once('error', reject);
    });

    createInterface({ input: this.#child.stdout! }).on('line', (line) => this.#handleLine(line));
    createInterface({ input: this.#child.stderr! }).on('line', (line) => {
      const message = line.trim();
      if (message) this.emit('stderr', message);
    });

    await this.request('initialize', {
      clientInfo: {
        name: 'inbox',
        title: 'Inbox',
        version: '0.1.0',
      },
    });
    this.notify('initialized', null);
  }

  async stop() {
    if (!this.#child) return;
    this.#child.kill('SIGTERM');
    this.#child = null;
  }

  notify(method: string, params: unknown) {
    this.#send({ method, params });
  }

  request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    const id = this.#nextId++;
    this.#send({ id, method, params });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Timeout waiting for ${method}`));
      }, timeoutMs);

      this.#pending.set(id, {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });
  }

  async readThread(threadId: string): Promise<any> {
    await this.start();
    const response = (await this.request('thread/read', {
      threadId,
      includeTurns: true,
    })) as { thread?: unknown };
    if (!isObject(response) || !isObject(response.thread)) {
      throw new Error('Invalid thread/read response from Codex app-server.');
    }
    return response.thread;
  }

  #send(message: Record<string, unknown>) {
    const child = this.#child;
    if (!child?.stdin) throw new Error('Codex app-server is not running.');
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line: string) {
    const parsed = safeJsonParse(line.trim());
    if (!isObject(parsed)) return;
    const id = typeof parsed.id === 'number' ? parsed.id : null;

    if (id !== null && ('result' in parsed || 'error' in parsed)) {
      const pending = this.#pending.get(id);
      if (!pending) return;
      this.#pending.delete(id);
      if (isObject(parsed.error)) {
        pending.reject(new Error(String(parsed.error.message ?? 'Codex app-server request failed.')));
      } else {
        pending.resolve(parsed.result);
      }
    }
  }
}

function formatTimestamp(value: unknown): string {
  if (typeof value === 'number') {
    return new Date(value * 1000).toISOString();
  }
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return new Date().toISOString();
}

function joinUserContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .map((item) => (isObject(item) && typeof item.text === 'string' ? item.text : null))
    .filter((item): item is string => Boolean(item));
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function stringifyUnknownItem(item: Record<string, unknown>): string | undefined {
  const clone = { ...item };
  delete clone.id;
  delete clone.type;
  return Object.keys(clone).length > 0 ? JSON.stringify(clone, null, 2) : undefined;
}

function mapItem(item: Record<string, unknown>) {
  const type = typeof item.type === 'string' ? item.type : 'unknown';
  const timestamp = formatTimestamp(item.createdAt ?? item.timestamp);

  if (type === 'userMessage') {
    return {
      id: String(item.id ?? `${type}-${timestamp}`),
      type: 'user' as const,
      title: 'User',
      text: joinUserContent(item.content) ?? String(item.text ?? ''),
      timestamp,
    };
  }

  if (type === 'agentMessage') {
    return {
      id: String(item.id ?? `${type}-${timestamp}`),
      type: 'assistant' as const,
      title: 'Codex',
      text: typeof item.text === 'string' ? item.text : stringifyUnknownItem(item),
      timestamp,
    };
  }

  if (type === 'commandExecution') {
    const output = [item.stdout, item.stderr]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join('\n');
    return {
      id: String(item.id ?? `${type}-${timestamp}`),
      type: 'tool' as const,
      title: typeof item.status === 'string' ? `Command ${item.status}` : 'Command',
      command: Array.isArray(item.command) ? item.command.map(String).join(' ') : undefined,
      output: output || stringifyUnknownItem(item),
      status: typeof item.status === 'string' ? item.status : undefined,
      exit_code: typeof item.exitCode === 'number' ? item.exitCode : undefined,
      duration_ms: typeof item.durationMs === 'number' ? item.durationMs : undefined,
      timestamp,
    };
  }

  return {
    id: String(item.id ?? `${type}-${timestamp}`),
    type: 'system' as const,
    title: type,
    text: stringifyUnknownItem(item) ?? type,
    timestamp,
  };
}

export function mapCodexThreadToSessionUpdate(thread: any) {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const transcriptTurns = turns.map((turn: any) => {
    const items = Array.isArray(turn.items)
      ? turn.items
          .filter((item: unknown) => isObject(item))
          .map((item: Record<string, unknown>) => mapItem(item))
          .filter((item: { type: string; text?: string; command?: string; output?: string }) => {
            if (item.type === 'user' || item.type === 'assistant' || item.type === 'system') {
              return Boolean(item.text);
            }
            return Boolean(item.command || item.output);
          })
      : [];

    return {
      id: String(turn.id ?? crypto.randomUUID()),
      label: typeof turn.label === 'string' ? turn.label : 'Codex turn',
      timestamp: formatTimestamp(turn.createdAt ?? turn.updatedAt),
      status: typeof turn.status === 'string' ? turn.status : 'completed',
      items,
    };
  });

  const lastAssistant = transcriptTurns
    .flatMap((turn: { items: Array<{ type: string; text?: string }> }) => turn.items)
    .reverse()
    .find((item: { type: string; text?: string }) => item.type === 'assistant' && typeof item.text === 'string');
  const sourceThreadStatus = typeof thread.status?.type === 'string' ? thread.status.type : 'synced';

  return {
    status: sourceThreadStatus,
    summary: typeof lastAssistant?.text === 'string' ? lastAssistant.text : 'Synced from Codex thread.',
    transcript: {
      summary: typeof thread.preview === 'string' && thread.preview.length > 0 ? thread.preview : undefined,
      turns: transcriptTurns,
    },
    source_thread_status: sourceThreadStatus,
    imported_turn_count: transcriptTurns.length,
    imported_item_count: transcriptTurns.reduce(
      (count: number, turn: { items: Array<unknown> }) => count + turn.items.length,
      0,
    ),
    updated_at: new Date().toISOString(),
  };
}
