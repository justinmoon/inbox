import { z } from 'zod';

const timestampSchema = z.string().min(1);
const metadataSchema = z.record(z.string(), z.string()).default({});
const tagsSchema = z.array(z.string().min(1)).default([]);

export const workflowStateFamilies = ['conversation', 'background', 'approval', 'terminal'] as const;
export const workflowRunStatuses = ['active', 'completed', 'failed', 'cancelled'] as const;
export const gateStatuses = ['open', 'answered', 'dismissed'] as const;
export const gateKinds = ['approval', 'input_required'] as const;
export const agentSessionStatuses = ['active', 'completed', 'failed'] as const;

export const workflowRepositoryInputSchema = z
  .object({
    repo_id: z.string().min(1).nullable().default(null),
    repo_path: z.string().min(1).nullable().default(null),
  })
  .refine((value) => Boolean(value.repo_id || value.repo_path), {
    message: 'Workflow repository input requires repo_id or repo_path.',
  });

export const gateOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  transition_id: z.string().min(1),
  description: z.string().min(1).nullable().optional(),
});

export const gateSchema = z.object({
  id: z.string().min(1),
  run_id: z.string().min(1),
  workflow_id: z.string().min(1),
  definition_gate_id: z.string().min(1),
  state_id: z.string().min(1),
  kind: z.enum(gateKinds),
  actor: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1).nullable().optional(),
  status: z.enum(gateStatuses),
  blocking: z.boolean().default(true),
  options: z.array(gateOptionSchema).default([]),
  opened_at: timestampSchema,
  answered_at: timestampSchema.nullable().default(null),
  closed_at: timestampSchema.nullable().default(null),
  tags: tagsSchema,
  metadata: metadataSchema,
});

export const workflowRunSchema = z.object({
  id: z.string().min(1),
  workflow_id: z.string().min(1),
  workflow_version: z.string().min(1),
  status: z.enum(workflowRunStatuses),
  current_state_id: z.string().min(1),
  current_state_family: z.enum(workflowStateFamilies),
  repo: workflowRepositoryInputSchema,
  goal_prompt: z.string().min(1),
  open_gate_ids: z.array(z.string().min(1)).default([]),
  last_transition_id: z.string().min(1).nullable().default(null),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  completed_at: timestampSchema.nullable().default(null),
  tags: tagsSchema,
  metadata: metadataSchema,
});

export const agentSessionSchema = z.object({
  id: z.string().min(1),
  run_id: z.string().min(1),
  workflow_id: z.string().min(1),
  backend: z.literal('codex'),
  kind: z.string().min(1),
  actor: z.string().min(1),
  state_id: z.string().min(1),
  thread_id: z.string().min(1),
  workspace_id: z.string().min(1).nullable().default(null),
  cwd: z.string().min(1).nullable().default(null),
  latest_turn_id: z.string().min(1).nullable().default(null),
  status: z.enum(agentSessionStatuses),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  tags: tagsSchema,
  metadata: metadataSchema,
});

export const runEventSchema = z.object({
  id: z.string().min(1),
  run_id: z.string().min(1),
  workflow_id: z.string().min(1),
  type: z.string().min(1),
  summary: z.string().min(1),
  state_id: z.string().min(1).nullable().default(null),
  from_state_id: z.string().min(1).nullable().default(null),
  to_state_id: z.string().min(1).nullable().default(null),
  transition_id: z.string().min(1).nullable().default(null),
  session_id: z.string().min(1).nullable().default(null),
  thread_id: z.string().min(1).nullable().default(null),
  turn_id: z.string().min(1).nullable().default(null),
  created_at: timestampSchema,
  tags: tagsSchema,
  metadata: metadataSchema,
});

export type WorkflowStateFamily = (typeof workflowStateFamilies)[number];
export type WorkflowRunStatus = (typeof workflowRunStatuses)[number];
export type GateStatus = (typeof gateStatuses)[number];
export type GateKind = (typeof gateKinds)[number];
export type AgentSessionStatus = (typeof agentSessionStatuses)[number];

export type WorkflowRepositoryInput = z.infer<typeof workflowRepositoryInputSchema>;
export type GateOptionRecord = z.infer<typeof gateOptionSchema>;
export type GateRecord = z.infer<typeof gateSchema>;
export type WorkflowRunRecord = z.infer<typeof workflowRunSchema>;
export type AgentSessionRecord = z.infer<typeof agentSessionSchema>;
export type RunEventRecord = z.infer<typeof runEventSchema>;

export type WorkflowDefinitionValidationIssue = {
  level: 'error' | 'warning';
  code: string;
  message: string;
  state_id?: string;
  transition_id?: string;
  gate_id?: string;
};

export type WorkflowDefinitionValidation = {
  valid: boolean;
  issues: WorkflowDefinitionValidationIssue[];
};

export type WorkflowDefinitionStateView = {
  id: string;
  title: string;
  description: string;
  family: WorkflowStateFamily;
  terminal: boolean;
  entry_gate_ids: string[];
  prompt_ids: string[];
};

export type WorkflowDefinitionTransitionView = {
  id: string;
  from: string;
  event: string;
  to: string;
  title: string;
  description: string;
};

export type WorkflowDefinitionGateView = {
  id: string;
  state_id: string;
  kind: GateKind;
  actor: string;
  title: string;
  description: string;
  blocking: boolean;
  options: GateOptionRecord[];
};

export type WorkflowDefinitionPromptView = {
  id: string;
  actor_label: string;
  title: string;
  description: string;
  used_in_state_ids: string[];
  output_marker_ids: string[];
  parser_hook_ids: string[];
};

export type WorkflowMarkerProtocolView = {
  id: string;
  title: string;
  description: string;
  kind: 'block_tag' | 'self_closing_tag';
  tag: string;
  attributes: Record<string, string>;
  example: string;
};

export type WorkflowParserHookView = {
  id: string;
  title: string;
  description: string;
  marker_ids: string[];
  output_kind: string;
  transition_event?: string | null;
};

export type WorkflowDefinitionSummary = {
  id: string;
  title: string;
  summary: string;
  version: string;
  initial_state_id: string;
  state_count: number;
  transition_count: number;
  validation: WorkflowDefinitionValidation;
};

export type WorkflowDefinitionDetail = WorkflowDefinitionSummary & {
  states: WorkflowDefinitionStateView[];
  transitions: WorkflowDefinitionTransitionView[];
  gates: WorkflowDefinitionGateView[];
  prompts: WorkflowDefinitionPromptView[];
  markers: WorkflowMarkerProtocolView[];
  parser_hooks: WorkflowParserHookView[];
  mermaid: string;
};
