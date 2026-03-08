import { z } from 'zod';

export const changeUnitStatuses = [
  'in_progress',
  'awaiting_review',
  'needs_revision',
  'approved',
  'ready_to_land',
  'landed',
] as const;

export const reviewVerdicts = ['approve', 'needs_revision', 'comment', 'blocked'] as const;
export const transcriptItemKinds = ['user', 'assistant', 'tool', 'system', 'note'] as const;
export const nextActionKinds = ['codex_fork_path', 'codex_resume_thread'] as const;

const timestampSchema = z.string().min(1);

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

const agentSessionSchema = z.object({
  id: z.string().min(1),
  change_unit_id: z.string().min(1),
  role: z.string().min(1),
  runtime: z.string().min(1),
  status: z.string().min(1),
  summary: z.string().min(1).optional(),
  milestones: z.array(milestoneSchema).default([]),
  transcript: z.object({
    summary: z.string().min(1).optional(),
    turns: z.array(transcriptTurnSchema).min(1),
  }),
  created_at: timestampSchema,
  updated_at: timestampSchema,
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

const tutorialEvidenceSnippetSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  language: z.string().min(1).optional(),
  snippet: z.string().min(1),
});

const tutorialStepSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  intent: z.string().min(1),
  affected_files: z.array(z.string().min(1)).default([]),
  evidence_snippets: z.array(tutorialEvidenceSnippetSchema).default([]),
  body_markdown: z.string().min(1),
});

const tutorialDocumentSchema = z.object({
  executive_summary: z.string().min(1),
  steps: z.array(tutorialStepSchema).min(1),
});

const nextActionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('codex_fork_path'),
    path: z.string().min(1),
    prompt: z.string().min(1),
    cwd: z.string().min(1).optional(),
    label: z.string().min(1).optional(),
    role: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal('codex_resume_thread'),
    thread_id: z.string().min(1),
    prompt: z.string().min(1),
    cwd: z.string().min(1).optional(),
    label: z.string().min(1).optional(),
    role: z.string().min(1).optional(),
  }),
]);

const changeUnitV2Schema = z.object({
  id: z.string().min(1),
  project_id: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(changeUnitStatuses),
  tutorial: tutorialDocumentSchema,
  next_action: nextActionSchema.optional(),
  diff: z.string().min(1),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});

const changeUnitBundleV2Schema = z.object({
  bundle_version: z.literal(2),
  project: projectSchema,
  change_unit: changeUnitV2Schema,
  agent_sessions: z.array(agentSessionSchema).min(1),
  review_verdicts: z.array(reviewVerdictSchema).default([]),
});

const changeUnitV1Schema = z.object({
  id: z.string().min(1),
  project_id: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(changeUnitStatuses),
  attention_score: z.number().int().min(0).max(100).default(50),
  tags: z.array(z.string().min(1)).default([]),
  summary: z.string().min(1),
  tutorial: z.string().min(1),
  next_chunk: z.string().min(1),
  diff: z.string().min(1),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});

const changeUnitBundleV1Schema = z.object({
  bundle_version: z.literal(1),
  project: projectSchema,
  change_unit: changeUnitV1Schema,
  agent_sessions: z.array(agentSessionSchema).min(1),
  review_verdicts: z.array(reviewVerdictSchema).default([]),
});

export const changeUnitBundleSchema = changeUnitBundleV2Schema;

export type ChangeUnitBundle = z.infer<typeof changeUnitBundleSchema>;
export type ChangeUnitStatus = (typeof changeUnitStatuses)[number];
export type ReviewVerdict = (typeof reviewVerdicts)[number];
export type NextActionKind = (typeof nextActionKinds)[number];

function migrateLegacyTutorial(markdown: string, summary: string) {
  const sections = markdown
    .split(/^## /gm)
    .map((section) => section.trim())
    .filter(Boolean)
    .map((section, index) => {
      const [rawTitle, ...bodyParts] = section.split('\n');
      const title = rawTitle.trim();
      return {
        id: `legacy-step-${index + 1}`,
        title,
        intent: `Review ${title.toLowerCase()}.`,
        affected_files: [],
        evidence_snippets: [],
        body_markdown: bodyParts.join('\n').trim() || title,
      };
    });

  return {
    executive_summary: summary,
    steps:
      sections.length > 0
        ? sections
        : [
            {
              id: 'legacy-step-1',
              title: 'Tutorial',
              intent: 'Review the imported tutorial notes.',
              affected_files: [],
              evidence_snippets: [],
              body_markdown: markdown,
            },
          ],
  };
}

export function parseChangeUnitBundle(input: unknown): ChangeUnitBundle {
  const parsedV2 = changeUnitBundleV2Schema.safeParse(input);
  if (parsedV2.success) {
    return parsedV2.data;
  }

  const legacy = changeUnitBundleV1Schema.parse(input);
  return {
    bundle_version: 2,
    project: legacy.project,
    change_unit: {
      id: legacy.change_unit.id,
      project_id: legacy.change_unit.project_id,
      title: legacy.change_unit.title,
      status: legacy.change_unit.status,
      tutorial: migrateLegacyTutorial(legacy.change_unit.tutorial, legacy.change_unit.summary),
      diff: legacy.change_unit.diff,
      created_at: legacy.change_unit.created_at,
      updated_at: legacy.change_unit.updated_at,
    },
    agent_sessions: legacy.agent_sessions,
    review_verdicts: legacy.review_verdicts,
  };
}
