import type { ChangeUnitBundle } from './changeUnitBundle.ts';

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
      changes: unknown[];
      status: string;
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
  } | null;
  thread: CodexThread | null;
  load_error: string | null;
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
