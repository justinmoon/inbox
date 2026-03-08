import type { ChangeUnitListItem } from '../../shared/api.ts';
import type { ChangeUnitStatus, ReviewVerdict } from '../../shared/changeUnitBundle.ts';

export type SidebarState = 'needs_attention' | 'working' | 'landed';

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
  ready_to_land: { label: 'Ready To Land', tone: 'green' },
  landed: { label: 'Landed', tone: 'slate' },
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

function humanizeToken(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

export function getStatusMeta(status: string) {
  return statusMeta[status as ChangeUnitStatus] ?? { label: humanizeToken(status), tone: 'slate' as const };
}

export function getReviewVerdictMeta(verdict: string) {
  return reviewVerdictMeta[verdict as ReviewVerdict] ?? {
    label: humanizeToken(verdict),
    tone: 'slate' as const,
  };
}

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
      ready_to_land: 0,
      landed: 0,
    },
  );
}

export function getSidebarState(status: string): SidebarState {
  switch (status) {
    case 'awaiting_review':
    case 'needs_revision':
    case 'approved':
    case 'ready_to_land':
      return 'needs_attention';
    case 'in_progress':
      return 'working';
    case 'landed':
      return 'landed';
    default:
      return 'working';
  }
}

export function getSidebarStateLabel(status: string): string {
  switch (getSidebarState(status)) {
    case 'needs_attention':
      return 'Needs Attention';
    case 'landed':
      return 'Landed';
    default:
      return 'Working';
  }
}

export function isNeedsAttentionStatus(status: string): boolean {
  return getSidebarState(status) === 'needs_attention';
}
