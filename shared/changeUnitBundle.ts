import { z } from 'zod';

export const changeUnitStatuses = [
  'in_progress',
  'awaiting_review',
  'needs_revision',
  'approved',
  'validating',
  'ready_to_land',
  'landed',
] as const;

export const validationStates = ['not_run', 'running', 'passed', 'failed', 'warning'] as const;
export const reviewVerdicts = ['approve', 'needs_revision', 'comment', 'blocked'] as const;
export const transcriptItemKinds = ['user', 'assistant', 'tool', 'system', 'note'] as const;
export const codexSyncSources = ['bundle_import', 'live_create', 'codex_refresh'] as const;

const timestampSchema = z.string().min(1);

const validationCheckSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  state: z.enum(validationStates),
  detail: z.string().min(1),
});

const validationSummarySchema = z.object({
  state: z.enum(validationStates),
  summary: z.string().min(1),
  checks: z.array(validationCheckSchema).default([]),
});

const pullRequestSchema = z.object({
  number: z.number().int().positive().nullable().default(null),
  status: z.string().min(1),
  url: z.string().min(1).nullable().default(null),
  branch_name: z.string().min(1).nullable().default(null),
});

const transcriptItemSchema = z.object({
  id: z.string().min(1),
  type: z.enum(transcriptItemKinds),
  title: z.string().min(1).optional(),
  text: z.string().min(1).optional(),
  command: z.string().min(1).optional(),
  output: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  exit_code: z.number().int().optional(),
  duration_ms: z.number().int().nonnegative().optional(),
  timestamp: timestampSchema.optional(),
});

const transcriptTurnSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).optional(),
  timestamp: timestampSchema,
  status: z.string().min(1).optional(),
  items: z.array(transcriptItemSchema).min(1),
});

const milestoneSchema = z.object({
  id: z.string().min(1),
  timestamp: timestampSchema,
  label: z.string().min(1),
  description: z.string().min(1).optional(),
});

const codexSyncSchema = z.object({
  source: z.enum(codexSyncSources).default('bundle_import'),
  source_thread_status: z.string().min(1).optional(),
  imported_turn_count: z.number().int().nonnegative().optional(),
  imported_item_count: z.number().int().nonnegative().optional(),
  last_attempted_at: timestampSchema.optional(),
  last_succeeded_at: timestampSchema.optional(),
  last_error: z.string().min(1).optional(),
});

const agentSessionSchema = z.object({
  id: z.string().min(1),
  change_unit_id: z.string().min(1),
  role: z.string().min(1),
  runtime: z.string().min(1),
  thread_id: z.string().min(1).nullable().default(null),
  status: z.string().min(1),
  summary: z.string().min(1).optional(),
  milestones: z.array(milestoneSchema).default([]),
  transcript: z.object({
    summary: z.string().min(1).optional(),
    turns: z.array(transcriptTurnSchema).min(1),
  }),
  codex_sync: codexSyncSchema.default({
    source: 'bundle_import',
  }),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});

const artifactSchema = z.object({
  id: z.string().min(1),
  change_unit_id: z.string().min(1),
  kind: z.string().min(1),
  label: z.string().min(1),
  path_or_blob_ref: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).default({}),
  created_at: timestampSchema,
});

const reviewVerdictSchema = z.object({
  id: z.string().min(1),
  change_unit_id: z.string().min(1),
  reviewer_role: z.string().min(1),
  verdict: z.enum(reviewVerdicts),
  summary: z.string().min(1),
  details_markdown: z.string().min(1).optional(),
  created_at: timestampSchema,
});

const projectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  worktree_path: z.string().min(1),
  repo_path: z.string().min(1),
  created_at: timestampSchema,
});

const changeUnitSchema = z.object({
  id: z.string().min(1),
  project_id: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(changeUnitStatuses),
  attention_score: z.number().int().min(0).max(100).default(50),
  tags: z.array(z.string().min(1)).default([]),
  executive_summary: z.string().min(1),
  tutorial_markdown: z.string().min(1),
  next_prompt: z.string().min(1),
  diff_text: z.string().min(1),
  pr: pullRequestSchema,
  validation: validationSummarySchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
});

export const changeUnitBundleSchema = z.object({
  bundle_version: z.literal(1),
  project: projectSchema,
  change_unit: changeUnitSchema,
  agent_sessions: z.array(agentSessionSchema).min(1),
  artifacts: z.array(artifactSchema).default([]),
  review_verdicts: z.array(reviewVerdictSchema).default([]),
});

export type ChangeUnitBundle = z.infer<typeof changeUnitBundleSchema>;
export type ChangeUnitStatus = (typeof changeUnitStatuses)[number];
export type ValidationState = (typeof validationStates)[number];
export type ReviewVerdict = (typeof reviewVerdicts)[number];
export type CodexSyncSource = (typeof codexSyncSources)[number];

export function parseChangeUnitBundle(input: unknown): ChangeUnitBundle {
  return changeUnitBundleSchema.parse(input);
}
