import fs from 'node:fs/promises';
import path from 'node:path';

import {
  repositorySchema,
  type RepositoryRecord,
  workspaceSchema,
  type WorkspaceRecord,
} from '../shared/workspaces.ts';

const REPOSITORIES_FILE = 'repositories.json';
const WORKSPACES_FILE = 'workspaces.json';

async function readJsonMap<T>(
  filePath: string,
  parser: (input: unknown) => T,
): Promise<Record<string, T>> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    const next: Record<string, T> = {};
    for (const [key, value] of Object.entries(parsed)) {
      try {
        next[key] = parser(value);
      } catch {
        // Ignore invalid persisted records instead of taking the app down.
      }
    }
    return next;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

async function writeJsonMap<T>(filePath: string, records: Record<string, T>) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(records, null, 2), 'utf8');
  await fs.rename(tempPath, filePath);
}

export class WorkspaceStore {
  #repositoriesPath: string;
  #workspacesPath: string;

  constructor(rootDir: string) {
    this.#repositoriesPath = path.join(rootDir, REPOSITORIES_FILE);
    this.#workspacesPath = path.join(rootDir, WORKSPACES_FILE);
  }

  async listRepositories(): Promise<RepositoryRecord[]> {
    const repositories = await readJsonMap(this.#repositoriesPath, (value) =>
      repositorySchema.parse(value),
    );
    return Object.values(repositories).sort((a, b) => a.id.localeCompare(b.id));
  }

  async listWorkspaces(): Promise<WorkspaceRecord[]> {
    const workspaces = await readJsonMap(this.#workspacesPath, (value) =>
      workspaceSchema.parse(value),
    );
    return Object.values(workspaces)
      .filter((workspace) => !workspace.disposed_at)
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async getRepository(id: string): Promise<RepositoryRecord | null> {
    const repositories = await readJsonMap(this.#repositoriesPath, (value) =>
      repositorySchema.parse(value),
    );
    return repositories[id] ?? null;
  }

  async getWorkspace(id: string): Promise<WorkspaceRecord | null> {
    const workspaces = await readJsonMap(this.#workspacesPath, (value) =>
      workspaceSchema.parse(value),
    );
    const workspace = workspaces[id] ?? null;
    return workspace && !workspace.disposed_at ? workspace : null;
  }

  async saveRepository(repository: RepositoryRecord): Promise<RepositoryRecord> {
    const repositories = await readJsonMap(this.#repositoriesPath, (value) =>
      repositorySchema.parse(value),
    );
    repositories[repository.id] = repositorySchema.parse(repository);
    await writeJsonMap(this.#repositoriesPath, repositories);
    return repository;
  }

  async saveWorkspace(workspace: WorkspaceRecord): Promise<WorkspaceRecord> {
    const workspaces = await readJsonMap(this.#workspacesPath, (value) => workspaceSchema.parse(value));
    workspaces[workspace.id] = workspaceSchema.parse(workspace);
    await writeJsonMap(this.#workspacesPath, workspaces);
    return workspace;
  }
}
