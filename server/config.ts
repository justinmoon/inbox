import path from 'node:path';

export type ServerConfig = {
  port: number;
  staticDir: string | null;
  seedRoot: string;
  importedRoot: string;
  runtimeRoot: string;
  codexBin: string;
  model: string | null;
  approvalPolicy: 'on-request' | 'on-failure' | 'never' | 'untrusted';
  sandboxMode: 'workspaceWrite' | 'readOnly' | 'dangerFullAccess';
  networkAccess: boolean;
};

export function readConfig(env: NodeJS.ProcessEnv): ServerConfig {
  return {
    port: Number(env.PORT ?? 8799),
    staticDir: env.INBOX_STATIC_DIR ? path.resolve(process.cwd(), env.INBOX_STATIC_DIR) : null,
    seedRoot: path.resolve(process.cwd(), env.INBOX_SEED_ROOT ?? 'seed/change-units'),
    importedRoot: path.resolve(process.cwd(), env.INBOX_IMPORTED_ROOT ?? 'data/imported-change-units'),
    runtimeRoot: path.resolve(process.cwd(), env.INBOX_RUNTIME_ROOT ?? 'data/runtime'),
    codexBin: env.INBOX_CODEX_BIN ?? 'codex',
    model: env.INBOX_CODEX_MODEL ?? null,
    approvalPolicy: (env.INBOX_CODEX_APPROVAL_POLICY ?? 'never') as ServerConfig['approvalPolicy'],
    sandboxMode: (env.INBOX_CODEX_SANDBOX_MODE ?? 'workspaceWrite') as ServerConfig['sandboxMode'],
    networkAccess: (env.INBOX_CODEX_NETWORK_ACCESS ?? 'true') === 'true',
  };
}
