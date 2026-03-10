import type { ChangeUnitBundle } from './changeUnitBundle.ts';
import type {
  RepositoryLocator,
  RepositoryRecord,
  RevisionRef,
  WorkspaceProviderKind,
  WorkspaceRecord,
} from './workspaces.ts';
import type {
  AgentSessionRecord,
  GateRecord,
  RunEventRecord,
  WorkflowDefinitionDetail,
  WorkflowDefinitionSummary,
  WorkflowRunRecord,
} from './workflowRuntime.ts';

export type ChangeUnitListItem = {
  id: string;
  title: string;
  status: ChangeUnitBundle['change_unit']['status'];
  updated_at: string;
  created_at: string;
  project: {
    id: string;
    name: string;
    worktree_path: string;
    repo_path: string;
  };
};

export type CodexUserInput = {
  type: string;
  text?: string;
  imageUrl?: string;
  path?: string;
  name?: string;
};

export type CodexFileChangeEntry = {
  path?: string | null;
  kind?: string | null;
  diff?: string | null;
  note?: string | null;
};

export type CodexThreadItem =
  | {
      type: 'userMessage';
      id: string;
      content: CodexUserInput[];
    }
  | {
      type: 'agentMessage';
      id: string;
      text: string;
      phase?: string | null;
    }
  | {
      type: 'plan';
      id: string;
      text: string;
    }
  | {
      type: 'reasoning';
      id: string;
      summary?: string[];
      content?: string[];
    }
  | {
      type: 'commandExecution';
      id: string;
      command: string;
      cwd: string;
      processId?: string | null;
      status: string;
      commandActions?: unknown[];
      aggregatedOutput?: string | null;
      exitCode?: number | null;
      durationMs?: number | null;
    }
  | {
      type: 'fileChange';
      id: string;
      changes: CodexFileChangeEntry[];
      status: string;
      rawOutput?: string | null;
    }
  | {
      type: 'mcpToolCall';
      id: string;
      server: string;
      tool: string;
      status: string;
      arguments: unknown;
      result?: unknown;
      error?: unknown;
      durationMs?: number | null;
    }
  | {
      type: 'dynamicToolCall';
      id: string;
      tool: string;
      arguments: unknown;
      status: string;
      contentItems?: unknown[] | null;
      success?: boolean | null;
      durationMs?: number | null;
    }
  | {
      type: 'collabAgentToolCall';
      id: string;
      tool: string;
      status: string;
      senderThreadId: string;
      receiverThreadIds: string[];
      prompt?: string | null;
      agentsStates?: Record<string, unknown>;
    }
  | {
      type: 'webSearch';
      id: string;
      query: string;
      action?: unknown;
    }
  | {
      type: 'imageView';
      id: string;
      path: string;
    }
  | {
      type: 'enteredReviewMode' | 'exitedReviewMode';
      id: string;
      review: string;
    }
  | {
      type: 'contextCompaction';
      id: string;
    }
  | {
      type: string;
      id: string;
      [key: string]: unknown;
    };

export type CodexTurn = {
  id: string;
  items: CodexThreadItem[];
  status: string;
  error?: {
    message: string;
    additionalDetails?: string | null;
  } | null;
};

export type CodexThread = {
  id: string;
  preview: string;
  ephemeral: boolean;
  modelProvider: string;
  createdAt: number;
  updatedAt: number;
  status: unknown;
  path?: string | null;
  cwd: string;
  cliVersion: string;
  source: unknown;
  agentNickname?: string | null;
  agentRole?: string | null;
  name?: string | null;
  turns: CodexTurn[];
};

export type CodexLiveApproval = {
  request_id: number;
  thread_id: string;
  turn_id: string | null;
  item_id: string | null;
  request_method: string;
  approval_kind: 'commandExecution' | 'fileChange' | 'other';
  status: 'pending' | 'answered' | 'cleared';
  requested_at: string;
  answered_at: string | null;
  cleared_at?: string | null;
  decision: 'accept' | 'decline' | null;
  reason?: string | null;
  command?: string | null;
  cwd?: string | null;
  command_actions?: unknown[];
  available_decisions?: string[];
  changes?: CodexFileChangeEntry[];
  additional_permissions?: unknown;
  network_approval_context?: unknown;
  raw_params?: unknown;
  synthetic?: boolean;
};

export type CodexSessionView = {
  id: string;
  role: string;
  runtime: string;
  status: string;
  source_kind: 'linked' | 'live';
  summary?: string | null;
  milestones: Array<{
    id: string;
    timestamp: string;
    label: string;
    description?: string;
  }>;
  launched_from?: {
    action_label: string;
    started_at: string;
    thread_source: 'forked' | 'resumed';
    turn_id?: string | null;
    workspace_path?: string | null;
    workspace_strategy?: string | null;
  } | null;
  thread: CodexThread | null;
  load_error: string | null;
  approvals: CodexLiveApproval[];
};

export type ChangeUnitExecutionIdle = {
  status: 'idle';
};

export type ChangeUnitExecutionLaunching = {
  status: 'launching';
  action_label: string;
  started_at: string;
  message?: string | null;
};

export type ChangeUnitExecutionLaunched = {
  status: 'launched';
  action_label: string;
  started_at: string;
  thread_id: string;
  turn_id: string;
  thread_source: 'forked' | 'resumed';
  workspace?: WorkspaceRecord | null;
  message?: string | null;
};

export type ChangeUnitExecutionFailed = {
  status: 'failed';
  action_label: string;
  started_at: string;
  error_message: string;
  message?: string | null;
};

export type ChangeUnitExecutionState =
  | ChangeUnitExecutionIdle
  | ChangeUnitExecutionLaunching
  | ChangeUnitExecutionLaunched
  | ChangeUnitExecutionFailed;

export type ChangeUnitDetail = ChangeUnitBundle & {
  execution_state: ChangeUnitExecutionState;
  session_views: CodexSessionView[];
  live_session_id: string | null;
};
export type ChangeUnitListResponse = {
  items: ChangeUnitListItem[];
  default_change_id: string | null;
  empty_message: string | null;
};

export type ExecuteNextActionResult = ChangeUnitExecutionLaunched;

export type RespondApprovalResult = {
  approval: CodexLiveApproval;
};

export type ListRepositoriesResponse = {
  repositories: RepositoryRecord[];
};

export type ListWorkspacesResponse = {
  workspaces: WorkspaceRecord[];
};

export type EnsureRepositoryRequest = {
  provider?: WorkspaceProviderKind;
  id?: string;
  source: string;
  tags?: string[];
  metadata?: Record<string, string>;
};

export type EnsureRepositoryResult = {
  repository: RepositoryRecord;
  trunk_workspace: WorkspaceRecord;
};

export type CreateWorkspaceRequest =
  | {
      provider?: WorkspaceProviderKind;
      repo_id: string;
      from?: RevisionRef;
      name_hint?: string;
      tags?: string[];
      metadata?: Record<string, string>;
    }
  | {
      provider?: WorkspaceProviderKind;
      source_workspace_id: string;
      name_hint?: string;
      tags?: string[];
      metadata?: Record<string, string>;
    };

export type CreateWorkspaceResult = {
  repository: RepositoryRecord;
  workspace: WorkspaceRecord;
};

export type ResolveWorkspaceRequest = {
  workspace_request: {
    provider?: WorkspaceProviderKind;
    repo: RepositoryLocator;
    from?: RevisionRef;
    name_hint?: string;
    tags?: string[];
    metadata?: Record<string, string>;
  };
};

export type ListWorkflowDefinitionsResponse = {
  workflows: WorkflowDefinitionSummary[];
};

export type ReadWorkflowDefinitionResponse = {
  workflow: WorkflowDefinitionDetail;
};

export type CreateWorkflowRunRequest = {
  workflow_id: string;
  repo_id?: string;
  repo_path?: string;
  goal_prompt: string;
  tags?: string[];
  metadata?: Record<string, string>;
};

export type CreateWorkflowRunResponse = {
  detail: WorkflowRunDetail;
};

export type WorkflowRunSessionDetail = {
  session: AgentSessionRecord;
  thread: CodexThread | null;
  load_error: string | null;
};

export type WorkflowRunDetail = {
  run: WorkflowRunRecord;
  sessions: WorkflowRunSessionDetail[];
  open_gates: GateRecord[];
  events: RunEventRecord[];
};

export type ReadWorkflowRunResponse = {
  detail: WorkflowRunDetail;
};

export type SendPlanningMessageRequest = {
  message: string;
};

export type SendPlanningMessageResponse = {
  detail: WorkflowRunDetail;
};

export type WorkflowRunStreamEvent =
  | {
      method: 'workflow-run/connected';
      params: {
        runId: string;
      };
    }
  | {
      method: 'workflow-run/event';
      params: {
        runId: string;
        event: RunEventRecord;
      };
    };
