import type { ChangeUnitBundle, ReviewVerdict, ValidationState } from './changeUnitBundle.ts';

export type ReviewSummary = Record<ReviewVerdict, number>;

export type ChangeUnitListItem = {
  id: string;
  title: string;
  status: ChangeUnitBundle['change_unit']['status'];
  attention_score: number;
  executive_summary: string;
  updated_at: string;
  created_at: string;
  tags: string[];
  session_count: number;
  session_roles: string[];
  project: {
    id: string;
    name: string;
    worktree_path: string;
    repo_path: string;
  };
  pr: ChangeUnitBundle['change_unit']['pr'];
  validation: {
    state: ValidationState;
    summary: string;
  };
  review_summary: ReviewSummary;
};

export type ChangeUnitDetail = ChangeUnitBundle;
