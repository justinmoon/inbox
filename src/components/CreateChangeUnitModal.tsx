import { useEffect, useState } from 'react';

import type { CreateLiveChangeUnitRequest } from '../../shared/liveChangeUnit.ts';

type CreateChangeUnitModalProps = {
  open: boolean;
  pending: boolean;
  errorMessage: string | null;
  suggestedRepoPath: string;
  onClose: () => void;
  onSubmit: (input: CreateLiveChangeUnitRequest) => void;
};

type FormState = {
  repo_path: string;
  project_name: string;
  github_repo: string;
  branch_name: string;
  planner: string;
  implementer: string;
  reviewer_a: string;
  reviewer_b: string;
};

function emptyForm(suggestedRepoPath: string): FormState {
  return {
    repo_path: suggestedRepoPath,
    project_name: '',
    github_repo: '',
    branch_name: '',
    planner: '',
    implementer: '',
    reviewer_a: '',
    reviewer_b: '',
  };
}

export function CreateChangeUnitModal({
  open,
  pending,
  errorMessage,
  suggestedRepoPath,
  onClose,
  onSubmit,
}: CreateChangeUnitModalProps) {
  const [form, setForm] = useState<FormState>(() => emptyForm(suggestedRepoPath));

  useEffect(() => {
    if (!open) return;
    setForm((current) => ({
      ...current,
      repo_path: current.repo_path || suggestedRepoPath,
    }));
  }, [open, suggestedRepoPath]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div className="modal-shell" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-header">
          <div>
            <p className="eyebrow">Live Packet</p>
            <h2>Create change unit from repo + Codex threads</h2>
            <p className="modal-copy">
              The backend will read the repo diff, ingest GitHub PR and CI state when available, pull the linked
              Codex threads, and write a real bundle through the same storage path as imported packets.
            </p>
          </div>
          <button className="ghost-button modal-close" onClick={onClose} type="button">
            Close
          </button>
        </div>

        <form
          className="modal-form"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit({
              repo_path: form.repo_path,
              project_name: form.project_name || undefined,
              github_repo: form.github_repo || undefined,
              branch_name: form.branch_name || undefined,
              thread_ids: {
                planner: form.planner || undefined,
                implementer: form.implementer,
                reviewer_a: form.reviewer_a || undefined,
                reviewer_b: form.reviewer_b || undefined,
              },
            });
          }}
        >
          <div className="form-grid">
            <label className="field">
              <span>Repo path</span>
              <input
                value={form.repo_path}
                onChange={(event) => setForm((current) => ({ ...current, repo_path: event.target.value }))}
                placeholder="/Users/justin/code/some-repo"
                required
              />
            </label>

            <label className="field">
              <span>Project label</span>
              <input
                value={form.project_name}
                onChange={(event) => setForm((current) => ({ ...current, project_name: event.target.value }))}
                placeholder="Optional display name"
              />
            </label>

            <label className="field">
              <span>GitHub repo</span>
              <input
                value={form.github_repo}
                onChange={(event) => setForm((current) => ({ ...current, github_repo: event.target.value }))}
                placeholder="owner/repo"
              />
            </label>

            <label className="field">
              <span>Branch name</span>
              <input
                value={form.branch_name}
                onChange={(event) => setForm((current) => ({ ...current, branch_name: event.target.value }))}
                placeholder="Optional override"
              />
            </label>

            <label className="field">
              <span>Planner thread</span>
              <input
                value={form.planner}
                onChange={(event) => setForm((current) => ({ ...current, planner: event.target.value }))}
                placeholder="Optional thread id"
              />
            </label>

            <label className="field">
              <span>Implementer thread</span>
              <input
                value={form.implementer}
                onChange={(event) => setForm((current) => ({ ...current, implementer: event.target.value }))}
                placeholder="Required thread id"
                required
              />
            </label>

            <label className="field">
              <span>Reviewer A thread</span>
              <input
                value={form.reviewer_a}
                onChange={(event) => setForm((current) => ({ ...current, reviewer_a: event.target.value }))}
                placeholder="Optional thread id"
              />
            </label>

            <label className="field">
              <span>Reviewer B thread</span>
              <input
                value={form.reviewer_b}
                onChange={(event) => setForm((current) => ({ ...current, reviewer_b: event.target.value }))}
                placeholder="Optional thread id"
              />
            </label>
          </div>

          {errorMessage ? <div className="banner banner-error">{errorMessage}</div> : null}

          <div className="modal-actions">
            <button className="ghost-button" onClick={onClose} type="button">
              Cancel
            </button>
            <button className="solid-button" disabled={pending} type="submit">
              {pending ? 'Building packet…' : 'Create live packet'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
