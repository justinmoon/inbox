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

export type ReplayTurnItem = {
  id: string;
  type: 'user' | 'assistant' | 'tool' | 'system' | 'note';
  title?: string;
  text?: string;
  command?: string;
  output?: string;
  status?: string;
  exit_code?: number;
  duration_ms?: number;
  timestamp?: string;
};

export type ReplayTurn = {
  id: string;
  label?: string;
  timestamp: string;
  status?: string;
  items: ReplayTurnItem[];
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

export type LiveSessionDetail = {
  thread_id: string;
  turn_id: string;
  thread_source: 'forked' | 'resumed';
  started_at: string;
  action_label: string;
  preview: string;
  status: string;
  updated_at: string | null;
  transcript: {
    turns: ReplayTurn[];
  };
};

export type ChangeUnitDetail = ChangeUnitBundle & {
  execution_state: ChangeUnitExecutionState;
  live_session: LiveSessionDetail | null;
  live_session_error: string | null;
};
export type ChangeUnitListResponse = {
  items: ChangeUnitListItem[];
  default_change_id: string | null;
  empty_message: string | null;
};

export type ExecuteNextActionResult = ChangeUnitExecutionLaunched;
