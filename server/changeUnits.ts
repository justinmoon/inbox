import type { ChangeUnitListItem } from '../shared/api.ts';
import type { ChangeUnitBundle } from '../shared/changeUnitBundle.ts';

export function listChangeUnits(bundles: ChangeUnitBundle[]): ChangeUnitListItem[] {
  return bundles.map((bundle) => ({
    id: bundle.change_unit.id,
    title: bundle.change_unit.title,
    status: bundle.change_unit.status,
    updated_at: bundle.change_unit.updated_at,
    created_at: bundle.change_unit.created_at,
    project: {
      id: bundle.project.id,
      name: bundle.project.name,
      worktree_path: bundle.project.worktree_path,
      repo_path: bundle.project.repo_path,
    },
  }));
}

export function getChangeUnitDetail(
  bundles: ChangeUnitBundle[],
  id: string,
): ChangeUnitBundle | null {
  return bundles.find((bundle) => bundle.change_unit.id === id) ?? null;
}
