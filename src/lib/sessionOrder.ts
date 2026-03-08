export function sessionRoleWeight(role: string): number {
  switch (role) {
    case 'planner':
      return 0;
    case 'implementer':
      return 1;
    case 'reviewer_a':
      return 2;
    case 'reviewer_b':
      return 3;
    case 'live_session':
      return 4;
    default:
      return 9;
  }
}

export function orderSessions<T extends { role: string }>(sessions: readonly T[]): T[] {
  return [...sessions].sort((a, b) => sessionRoleWeight(a.role) - sessionRoleWeight(b.role));
}
