import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';

import { isObject, safeJsonParse } from './jsonl.ts';

type JsonRpcId = number;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

export type AppServerMessage = Record<string, unknown>;

export class AppServerProcess extends EventEmitter {
  #codexBin: string;
  #child: ReturnType<typeof spawn> | null = null;
  #nextId: JsonRpcId = 1;
  #pending = new Map<JsonRpcId, Pending>();

  constructor(opts: { codexBin: string }) {
    super();
    this.#codexBin = opts.codexBin;
  }

  get running() {
    return this.#child !== null;
  }

  async start(clientInfo: { name: string; title: string; version: string }) {
    if (this.#child) return;

    const child = spawn(this.#codexBin, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    this.#child = child;

    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', (error) => reject(error));
    });

    child.on('exit', (code, signal) => {
      this.#child = null;
      const error = new Error(`codex app-server exited (${code ?? 'null'} ${signal ?? ''})`);
      for (const pending of this.#pending.values()) {
        pending.reject(error);
      }
      this.#pending.clear();
      this.emit('exit', { code, signal });
    });

    createInterface({ input: child.stdout }).on('line', (line) => this.#handleLine(line));
    createInterface({ input: child.stderr }).on('line', (line) => {
      const message = line.trim();
      if (message) this.emit('stderr', message);
    });

    const response = await this.request('initialize', {
      clientInfo,
      capabilities: {
        experimentalApi: true,
      },
    });
    if (!isObject(response)) {
      throw new Error('Invalid initialize response from app-server');
    }
    await this.notify('initialized', {});
  }

  async stop(args: { gracePeriodMs?: number } = {}) {
    const child = this.#child;
    if (!child) return;
    const gracePeriodMs = args.gracePeriodMs ?? 2_000;
    const alreadyExited = child.exitCode !== null || child.signalCode !== null;
    if (alreadyExited) {
      return;
    }

    const exitPromise = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
    });

    child.kill('SIGTERM');
    const forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }, gracePeriodMs);
    forceTimer.unref?.();

    await exitPromise;
    clearTimeout(forceTimer);
  }

  async notify(method: string, params: unknown) {
    this.#send({ method, params });
  }

  async respond(id: number, result: unknown) {
    this.#send({ id, result });
  }

  async respondError(id: number, message: string) {
    this.#send({ id, error: { message } });
  }

  async request(method: string, params: unknown, timeoutMs = 60_000): Promise<unknown> {
    const id = this.#nextId++;
    this.#send({ id, method, params });

    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Timeout waiting for ${method}`));
      }, timeoutMs);

      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });
  }

  #send(message: Record<string, unknown>) {
    const child = this.#child;
    if (!child || !child.stdin) {
      throw new Error('app-server not running');
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;

    const parsed = safeJsonParse(trimmed);
    if (!isObject(parsed)) {
      this.emit('parseError', { raw: trimmed });
      return;
    }

    const id = typeof parsed.id === 'number' ? parsed.id : null;
    const hasResultOrError = 'result' in parsed || 'error' in parsed;
    const hasMethod = typeof parsed.method === 'string';

    if (id !== null) {
      if (hasResultOrError) {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);

        if (parsed.error && isObject(parsed.error)) {
          const message =
            typeof parsed.error.message === 'string' ? parsed.error.message : 'error';
          pending.reject(new Error(message));
        } else {
          pending.resolve(parsed.result);
        }
        return;
      }

      if (hasMethod) {
        this.emit('serverRequest', parsed as AppServerMessage);
        return;
      }
    }

    if (hasMethod) {
      this.emit('notification', parsed as AppServerMessage);
    }
  }
}
