import path from 'node:path';

export type ServerConfig = {
  port: number;
  dbPath: string;
  staticDir: string | null;
  seedRoot: string;
  generatedBundleRoot: string;
  codexSdkPath: string;
};

export function readConfig(env: NodeJS.ProcessEnv): ServerConfig {
  return {
    port: Number(env.PORT ?? 8787),
    dbPath: path.resolve(process.cwd(), env.INBOX_DB_PATH ?? 'data/inbox.sqlite'),
    staticDir: env.INBOX_STATIC_DIR ? path.resolve(process.cwd(), env.INBOX_STATIC_DIR) : null,
    seedRoot: path.resolve(process.cwd(), env.INBOX_SEED_ROOT ?? 'seed/change-units'),
    generatedBundleRoot: path.resolve(process.cwd(), env.INBOX_GENERATED_BUNDLE_ROOT ?? 'data/generated-change-units'),
    codexSdkPath: env.INBOX_CODEX_SDK_PATH ?? '/Users/justin/code/codex/sdk/typescript/src/index.ts',
  };
}
