import type { ChangeUnitListItem } from '../../shared/api.ts';
import type { ChangeUnitStatus, ReviewVerdict, ValidationState } from '../../shared/changeUnitBundle.ts';

export const statusMeta: Record<
  ChangeUnitStatus,
  {
    label: string;
    tone: 'amber' | 'red' | 'blue' | 'green' | 'slate';
  }
> = {
  in_progress: { label: 'In Progress', tone: 'blue' },
  awaiting_review: { label: 'Awaiting Review', tone: 'amber' },
  needs_revision: { label: 'Needs Revision', tone: 'red' },
  approved: { label: 'Approved', tone: 'green' },
  validating: { label: 'Validating', tone: 'blue' },
  ready_to_land: { label: 'Ready To Land', tone: 'green' },
  landed: { label: 'Landed', tone: 'slate' },
};

export const validationMeta: Record<
  ValidationState,
  {
    label: string;
    tone: 'amber' | 'red' | 'blue' | 'green' | 'slate';
  }
> = {
  not_run: { label: 'Not Run', tone: 'slate' },
  running: { label: 'Running', tone: 'blue' },
  passed: { label: 'Passed', tone: 'green' },
  failed: { label: 'Failed', tone: 'red' },
  warning: { label: 'Warning', tone: 'amber' },
};

export const reviewVerdictMeta: Record<
  ReviewVerdict,
  {
    label: string;
    tone: 'amber' | 'red' | 'blue' | 'green' | 'slate';
  }
> = {
  approve: { label: 'Approve', tone: 'green' },
  needs_revision: { label: 'Needs Revision', tone: 'red' },
  comment: { label: 'Comment', tone: 'blue' },
  blocked: { label: 'Blocked', tone: 'amber' },
};

export function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

export function formatLongTimestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

export function summarizeInbox(items: ChangeUnitListItem[]) {
  return items.reduce<Record<ChangeUnitStatus, number>>(
    (accumulator, item) => {
      accumulator[item.status] += 1;
      return accumulator;
    },
    {
      in_progress: 0,
      awaiting_review: 0,
      needs_revision: 0,
      approved: 0,
      validating: 0,
      ready_to_land: 0,
      landed: 0,
    },
  );
}
