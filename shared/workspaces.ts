import { z } from 'zod';

export const workspaceProviderKinds = ['shared-store-worktree'] as const;
export const revisionRefKinds = ['branch', 'ref', 'commit', 'workspace'] as const;

const timestampSchema = z.string().min(1);
const metadataSchema = z.record(z.string(), z.string()).default({});
const tagsSchema = z.array(z.string().min(1)).default([]);

export const revisionRefSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('branch'),
    branch: z.string().min(1),
  }),
  z.object({
    kind: z.literal('ref'),
    ref: z.string().min(1),
  }),
  z.object({
    kind: z.literal('commit'),
    commit: z.string().min(1),
  }),
  z.object({
    kind: z.literal('workspace'),
    workspace_id: z.string().min(1),
  }),
]);

export const repositorySchema = z.object({
  id: z.string().min(1),
  provider: z.enum(workspaceProviderKinds),
  source: z.string().min(1),
  backing_store_path: z.string().min(1),
  visible_root_path: z.string().min(1),
  visible_trunk_path: z.string().min(1),
  trunk_workspace_id: z.string().min(1),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  tags: tagsSchema,
  metadata: metadataSchema,
});

export const workspaceSchema = z.object({
  id: z.string().min(1),
  repo_id: z.string().min(1),
  provider: z.enum(workspaceProviderKinds),
  strategy: z.enum(workspaceProviderKinds),
  name: z.string().min(1),
  path: z.string().min(1),
  source_ref: revisionRefSchema,
  current_head: z.string().min(1).nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  tags: tagsSchema,
  metadata: metadataSchema,
  disposed_at: timestampSchema.nullable().optional(),
});

export const repositoryLocatorSchema = z
  .object({
    id: z.string().min(1).optional(),
    source: z.string().min(1).optional(),
  })
  .refine((value) => Boolean(value.id || value.source), {
    message: 'Repository locator requires an id or source.',
  });

export const workspaceRequestSchema = z.object({
  provider: z.enum(workspaceProviderKinds).default('shared-store-worktree'),
  strategy: z.enum(workspaceProviderKinds).default('shared-store-worktree'),
  repo: repositoryLocatorSchema,
  from: revisionRefSchema.optional(),
  name_hint: z.string().min(1).optional(),
  tags: tagsSchema,
  metadata: metadataSchema,
});

export type WorkspaceProviderKind = (typeof workspaceProviderKinds)[number];
export type RevisionRef = z.infer<typeof revisionRefSchema>;
export type RepositoryRecord = z.infer<typeof repositorySchema>;
export type WorkspaceRecord = z.infer<typeof workspaceSchema>;
export type RepositoryLocator = z.infer<typeof repositoryLocatorSchema>;
export type WorkspaceRequest = z.infer<typeof workspaceRequestSchema>;
