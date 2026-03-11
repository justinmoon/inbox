import { z } from 'zod';

const timestampSchema = z.string().min(1);
const metadataSchema = z.record(z.string(), z.string()).default({});
const tagsSchema = z.array(z.string().min(1)).default([]);

export const workflowStateFamilies = ['conversation', 'background', 'approval', 'terminal'] as const;
export const workflowRunStatuses = ['active', 'completed', 'failed', 'cancelled'] as const;
export const gateStatuses = ['open', 'answered', 'dismissed'] as const;
export const gateKinds = ['approval', 'input_required'] as const;
export const agentSessionStatuses = ['active', 'completed', 'failed'] as const;
export const agentTurnStatuses = ['running', 'completed', 'failed', 'interrupted'] as const;
export const agentSessionActivityStatuses = ['idle', 'running', 'stalled'] as const;
export const workflowArtifactStatuses = ['pending', 'ready', 'failed'] as const;
export const swarmAgentKinds = ['hub', 'worker'] as const;
export const swarmRunTopLevelStates = ['working', 'needs_user_input', 'failed', 'completed'] as const;
export const swarmRunAgentStatuses = ['idle', 'working', 'stalled', 'waiting_on_user', 'failed'] as const;
export const swarmTimelineEmphasis = ['session', 'turn', 'marker', 'gate', 'transition', 'system'] as const;

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
  active_turn_id: z.string().min(1).nullable().default(null),
  active_turn_started_at: timestampSchema.nullable().default(null),
  latest_turn_id: z.string().min(1).nullable().default(null),
  latest_turn_completed_at: timestampSchema.nullable().default(null),
  last_turn_status: z.enum(agentTurnStatuses).nullable().default(null),
  activity_status: z.enum(agentSessionActivityStatuses).default('idle'),
  stalled_at: timestampSchema.nullable().default(null),
  stall_reason: z.string().min(1).nullable().default(null),
  last_error: z.string().min(1).nullable().default(null),
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
  sequence: z.number().int().nonnegative().default(0),
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

export const workflowArtifactSchema = z.object({
  id: z.string().min(1),
  run_id: z.string().min(1),
  workflow_id: z.string().min(1),
  kind: z.string().min(1),
  status: z.enum(workflowArtifactStatuses),
  state_id: z.string().min(1).nullable().default(null),
  session_id: z.string().min(1).nullable().default(null),
  thread_id: z.string().min(1).nullable().default(null),
  turn_id: z.string().min(1).nullable().default(null),
  content: z.string().min(1).nullable().default(null),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  completed_at: timestampSchema.nullable().default(null),
  tags: tagsSchema,
  metadata: metadataSchema,
});

export type WorkflowStateFamily = (typeof workflowStateFamilies)[number];
export type WorkflowRunStatus = (typeof workflowRunStatuses)[number];
export type GateStatus = (typeof gateStatuses)[number];
export type GateKind = (typeof gateKinds)[number];
export type AgentSessionStatus = (typeof agentSessionStatuses)[number];
export type AgentTurnStatus = (typeof agentTurnStatuses)[number];
export type AgentSessionActivityStatus = (typeof agentSessionActivityStatuses)[number];
export type WorkflowArtifactStatus = (typeof workflowArtifactStatuses)[number];
export type SwarmAgentKind = (typeof swarmAgentKinds)[number];
export type SwarmRunTopLevelState = (typeof swarmRunTopLevelStates)[number];
export type SwarmRunAgentStatus = (typeof swarmRunAgentStatuses)[number];
export type SwarmTimelineEmphasis = (typeof swarmTimelineEmphasis)[number];

export type WorkflowRepositoryInput = z.infer<typeof workflowRepositoryInputSchema>;
export type GateOptionRecord = z.infer<typeof gateOptionSchema>;
export type GateRecord = z.infer<typeof gateSchema>;
export type WorkflowRunRecord = z.infer<typeof workflowRunSchema>;
export type AgentSessionRecord = z.infer<typeof agentSessionSchema>;
export type RunEventRecord = z.infer<typeof runEventSchema>;
export type WorkflowArtifactRecord = z.infer<typeof workflowArtifactSchema>;

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

export type SwarmDefinitionValidationIssue = {
  level: 'error' | 'warning';
  code: string;
  message: string;
  agent_id?: string;
  route_id?: string;
  gate_rule_id?: string;
  artifact_kind_id?: string;
};

export type SwarmDefinitionValidation = {
  valid: boolean;
  issues: SwarmDefinitionValidationIssue[];
};

export type SwarmAgentDefinitionView = {
  id: string;
  title: string;
  summary: string;
  kind: SwarmAgentKind;
  owned_state_ids: string[];
  session_kinds: string[];
  role_prompt: string;
  operating_guidelines: string[];
  review_role_prompt: string | null;
  review_guidelines: string[];
  expected_marker_ids: string[];
  target_artifact_kind_ids: string[];
  target_gate_rule_ids: string[];
};

export type SwarmRouteView = {
  id: string;
  from_agent_id: string;
  to_agent_id: string;
  title: string;
  summary: string;
};

export type SwarmGateRuleView = {
  id: string;
  title: string;
  summary: string;
  owner_agent_id: string;
  workflow_gate_ids: string[];
  artifact_kind_id: string;
  unlocks_route_id: string | null;
};

export type SwarmArtifactKindView = {
  id: string;
  title: string;
  summary: string;
};

export type SwarmDefinitionSummary = {
  id: string;
  title: string;
  summary: string;
  agent_count: number;
  route_count: number;
  gate_rule_count: number;
  artifact_kind_count: number;
  validation: SwarmDefinitionValidation;
};

export type SwarmDefinitionDetail = SwarmDefinitionSummary & {
  agents: SwarmAgentDefinitionView[];
  allowed_routes: SwarmRouteView[];
  gate_rules: SwarmGateRuleView[];
  artifact_kinds: SwarmArtifactKindView[];
  mermaid: string;
};

export type SwarmRunAgentView = {
  agent_id: string;
  title: string;
  kind: SwarmAgentKind;
  status: SwarmRunAgentStatus;
  active_state_id: string | null;
  session_id: string | null;
  thread_id: string | null;
  active_turn_id: string | null;
};

export type SwarmGateArtifactView = {
  kind_id: string | null;
  title: string;
  content: string | null;
};

export type SwarmCurrentGateView = {
  gate_id: string;
  title: string;
  status: GateStatus;
  actor: string;
  rule_id: string | null;
  owner_agent_id: string | null;
  unlocks_route_id: string | null;
  unlocks_route_title: string | null;
  unlocks_target_agent_id: string | null;
  unlocks_target_agent_title: string | null;
  artifact: SwarmGateArtifactView | null;
};

export type SwarmTimelineEntry = {
  id: string;
  event_id: string;
  event_sequence: number;
  timestamp: string;
  emphasis: SwarmTimelineEmphasis;
  title: string;
  summary: string;
  agent_id: string | null;
  session_id: string | null;
  turn_id: string | null;
};

export type WorkflowRunSwarmView = {
  definition: SwarmDefinitionSummary;
  top_level_state: SwarmRunTopLevelState;
  active_state_id: string;
  active_state_family: WorkflowStateFamily;
  current_gate: SwarmCurrentGateView | null;
  agents: SwarmRunAgentView[];
  timeline: SwarmTimelineEntry[];
  graph_mermaid: string;
};
