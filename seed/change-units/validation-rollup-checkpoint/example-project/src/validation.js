export function formatValidationChecks(checks) {
  const presentChecks = [];

  for (let index = 0; index < checks.length; index += 1) {
    if (index in checks) {
      presentChecks.push(checks[index]);
    }
  }

  if (presentChecks.length === 0) {
    return '';
  }

  const countsByState = new Map();

  for (const check of presentChecks) {
    countsByState.set(check.state, (countsByState.get(check.state) ?? 0) + 1);
  }

  const summary = `${presentChecks.length} check${presentChecks.length === 1 ? '' : 's'}: ${Array.from(
    countsByState,
  )
    .sort(([leftState], [rightState]) => leftState.localeCompare(rightState))
    .map(([state, count]) => `${count} ${state}`)
    .join(', ')}`;

  return `${summary}\n${presentChecks.map((check) => `${check.label}: ${check.state}`).join('\n')}`;
}
