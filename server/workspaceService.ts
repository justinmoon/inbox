import path from 'node:path';
import { spawn } from 'node:child_process';

import type {
  CreateWorkspaceRequest,
  EnsureRepositoryRequest,
  EnsureRepositoryResult,
  ResolveWorkspaceRequest,
} from '../shared/api.ts';
import type {
  RepositoryRecord,
  RevisionRef,
  WorkspaceProviderKind,
  WorkspaceRecord,
  WorkspaceRequest,
} from '../shared/workspaces.ts';
import { SharedStoreWorktreeProvider } from './sharedStoreWorktreeProvider.ts';
import { WorkspaceStore } from './workspaceStore.ts';

type CreateWorkspaceOptions = {
  repo_id: string;
  from?: RevisionRef;
  name_hint?: string;
  tags?: string[];
  metadata?: Record<string, string>;
};

type WorkspaceProvider = {
  ensureRepository(options: {
    id?: string;
    source: string;
    tags?: string[];
    metadata?: Record<string, string>;
  }): Promise<{
    repository: RepositoryRecord;
    trunkWorkspace: WorkspaceRecord;
    defaultRef: RevisionRef;
  }>;
  createWorkspace(options: {
    repository: RepositoryRecord;
    sourceRef: RevisionRef;
    resolvedRevision: string;
    nameHint?: string;
    tags?: string[];
    metadata?: Record<string, string>;
  }): Promise<WorkspaceRecord>;
};

function mergeTags(...tagLists: Array<string[] | undefined>) {
  return [...new Set(tagLists.flatMap((list) => list ?? []))];
}

function mergeMetadata(...metadataList: Array<Record<string, string> | undefined>) {
  return Object.assign({}, ...metadataList);
}

function timestamp() {
  return new Date().toISOString();
}

function normalizeRepositorySource(source: string) {
  return /^(https?:\/\/|ssh:\/\/|git@|file:\/\/)/.test(source)
    ? source
    : path.resolve(process.cwd(), source);
}

async function git(args: string[], cwd: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(stderr.trim() || `git ${args.join(' ')} exited with code ${code}`));
    });
  });
}

async function resolveWorkspaceHead(workspacePath: string) {
  return await git(['rev-parse', 'HEAD'], workspacePath);
}

async function resolveRevisionInRepository(repository: RepositoryRecord, revision: RevisionRef) {
  switch (revision.kind) {
    case 'branch':
      return await git(['rev-parse', `${revision.branch}^{commit}`], repository.backing_store_path);
    case 'ref':
      return await git(['rev-parse', `${revision.ref}^{commit}`], repository.backing_store_path);
    case 'commit':
      return await git(['rev-parse', `${revision.commit}^{commit}`], repository.backing_store_path);
    case 'workspace':
      throw new Error('Workspace revisions must be resolved through the workspace service.');
  }
}

export class WorkspaceService {
  #store: WorkspaceStore;
  #providers: Record<WorkspaceProviderKind, WorkspaceProvider>;

  constructor(runtimeRoot: string) {
    this.#store = new WorkspaceStore(runtimeRoot);
    this.#providers = {
      'shared-store-worktree': new SharedStoreWorktreeProvider(runtimeRoot),
    };
  }

  async listRepositories() {
    return await this.#store.listRepositories();
  }

  async listWorkspaces() {
    return await this.#store.listWorkspaces();
  }

  async getRepository(id: string) {
    return await this.#store.getRepository(id);
  }

  async getWorkspace(id: string) {
    return await this.#store.getWorkspace(id);
  }

  async ensureRepository(request: EnsureRepositoryRequest): Promise<EnsureRepositoryResult> {
    const providerKind = request.provider ?? 'shared-store-worktree';
    const provider = this.#providers[providerKind];
    const normalizedSource = normalizeRepositorySource(request.source);
    const existingRepositories = await this.#store.listRepositories();
    const existing =
      (request.id ? existingRepositories.find((repository) => repository.id === request.id) : null) ??
      existingRepositories.find((repository) => repository.source === normalizedSource) ??
      null;
    const ensured = await provider.ensureRepository({
      id: existing?.id ?? request.id,
      source: normalizedSource,
      tags: mergeTags(existing?.tags, request.tags),
      metadata: mergeMetadata(existing?.metadata, request.metadata),
    });

    const now = timestamp();
    const repository: RepositoryRecord = {
      ...ensured.repository,
      created_at: existing?.created_at ?? ensured.repository.created_at,
      updated_at: now,
      tags: mergeTags(existing?.tags, ensured.repository.tags, request.tags),
      metadata: mergeMetadata(existing?.metadata, ensured.repository.metadata, request.metadata),
    };

    const existingTrunk = await this.#store.getWorkspace(repository.trunk_workspace_id);
    const trunkWorkspace: WorkspaceRecord = {
      ...ensured.trunkWorkspace,
      created_at: existingTrunk?.created_at ?? ensured.trunkWorkspace.created_at,
      updated_at: now,
      tags: mergeTags(existingTrunk?.tags, ensured.trunkWorkspace.tags),
      metadata: mergeMetadata(existingTrunk?.metadata, ensured.trunkWorkspace.metadata),
    };

    await Promise.all([
      this.#store.saveRepository(repository),
      this.#store.saveWorkspace(trunkWorkspace),
    ]);

    return { repository, trunk_workspace: trunkWorkspace };
  }

  async createWorkspace(request: CreateWorkspaceRequest) {
    if ('source_workspace_id' in request) {
      const sourceWorkspace = await this.#store.getWorkspace(request.source_workspace_id);
      if (!sourceWorkspace) {
        throw new Error(`Workspace ${request.source_workspace_id} is not registered.`);
      }

      return await this.#createWorkspaceFromResolvedSource({
        repo_id: sourceWorkspace.repo_id,
        from: { kind: 'workspace', workspace_id: sourceWorkspace.id },
        name_hint: request.name_hint,
        tags: request.tags,
        metadata: request.metadata,
      });
    }

    return await this.#createWorkspaceFromResolvedSource(request);
  }

  async resolveWorkspaceRequest(request: WorkspaceRequest | ResolveWorkspaceRequest['workspace_request']) {
    let repository: RepositoryRecord | null = null;

    if (request.repo.id) {
      repository = await this.#store.getRepository(request.repo.id);
    }

    if (!repository) {
      if (!request.repo.source) {
        throw new Error('Workspace request needs a repository source when the repo is not registered.');
      }

      const ensured = await this.ensureRepository({
        provider: request.provider,
        id: request.repo.id,
        source: request.repo.source,
        tags: request.tags,
        metadata: request.metadata,
      });
      repository = ensured.repository;
    }

    return await this.#createWorkspaceFromResolvedSource({
      repo_id: repository.id,
      from: request.from,
      name_hint: request.name_hint,
      tags: request.tags,
      metadata: request.metadata,
    });
  }

  async #createWorkspaceFromResolvedSource(request: CreateWorkspaceOptions) {
    const repository = await this.#store.getRepository(request.repo_id);
    if (!repository) {
      throw new Error(`Repository ${request.repo_id} is not registered.`);
    }

    const provider = this.#providers[repository.provider];
    const trunkWorkspace = await this.#store.getWorkspace(repository.trunk_workspace_id);
    const sourceRef = request.from ?? trunkWorkspace?.source_ref ?? { kind: 'commit', commit: await resolveWorkspaceHead(repository.visible_trunk_path) };

    let resolvedRevision: string;
    if (sourceRef.kind === 'workspace') {
      const sourceWorkspace = await this.#store.getWorkspace(sourceRef.workspace_id);
      if (!sourceWorkspace) {
        throw new Error(`Workspace ${sourceRef.workspace_id} is not registered.`);
      }
      resolvedRevision = sourceWorkspace.current_head ?? (await resolveWorkspaceHead(sourceWorkspace.path));
    } else {
      resolvedRevision = await resolveRevisionInRepository(repository, sourceRef);
    }

    const workspace = await provider.createWorkspace({
      repository,
      sourceRef,
      resolvedRevision,
      nameHint: request.name_hint,
      tags: request.tags,
      metadata: request.metadata,
    });

    await this.#store.saveWorkspace(workspace);
    return { repository, workspace };
  }
}
