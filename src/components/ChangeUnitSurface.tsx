import { useEffect, useMemo, useState, type RefObject } from 'react';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import type { ChangeUnitDetail } from '../../shared/api.ts';
import { executeNextAction } from '../lib/api.ts';
import {
  formatLongTimestamp,
  getReviewVerdictMeta,
  getSidebarState,
  getSidebarStateLabel,
} from '../lib/format.ts';
import { parseUnifiedDiff } from '../lib/diff.ts';
import { DiffViewer } from './DiffViewer.tsx';

type ChangeUnitSurfaceProps = {
  detail: ChangeUnitDetail;
  focusRef?: RefObject<HTMLElement | null>;
  onExecutionStateChange: () => Promise<void>;
  onOpenLiveSession: () => void;
};

export function ChangeUnitSurface({
  detail,
  focusRef,
  onExecutionStateChange,
  onOpenLiveSession,
}: ChangeUnitSurfaceProps) {
  const { change_unit: changeUnit } = detail;
  const sidebarState = getSidebarState(changeUnit.status);
  const stateLabel = getSidebarStateLabel(changeUnit.status);
  const changedFiles = useMemo(() => parseUnifiedDiff(changeUnit.diff), [changeUnit.diff]);
  const tutorial = changeUnit.tutorial;
  const [activeStepId, setActiveStepId] = useState<string>(tutorial.steps[0]?.id ?? '');
  const [isExecuting, setIsExecuting] = useState(false);
  const [localExecuteError, setLocalExecuteError] = useState<string | null>(null);

  useEffect(() => {
    setActiveStepId(tutorial.steps[0]?.id ?? '');
    setIsExecuting(false);
    setLocalExecuteError(null);
  }, [changeUnit.id, tutorial.steps]);

  const totalSteps = tutorial.steps.length;
  const activeStepIndex = Math.max(
    0,
    tutorial.steps.findIndex((step) => step.id === activeStepId),
  );
  const activeStep = tutorial.steps[activeStepIndex] ?? tutorial.steps[0];
  const promptExpanded =
    sidebarState === 'needs_attention' && detail.execution_state.status !== 'launched';
  const effectiveExecutionStatus = isExecuting ? 'launching' : detail.execution_state.status;
  const executionError =
    detail.execution_state.status === 'failed'
      ? detail.execution_state.error_message
      : localExecuteError;
  const workspaceRequest = changeUnit.next_action?.workspace_request;

  async function handleExecuteNext() {
    if (!changeUnit.next_action || effectiveExecutionStatus === 'launching') return;

    setIsExecuting(true);
    setLocalExecuteError(null);

    try {
      await executeNextAction(changeUnit.id);
      await onExecutionStateChange();
    } catch (error) {
      setLocalExecuteError(error instanceof Error ? error.message : 'Failed to execute next action.');
      await onExecutionStateChange().catch(() => undefined);
    } finally {
      setIsExecuting(false);
    }
  }

  function goToStep(index: number) {
    const nextStep = tutorial.steps[index];
    if (!nextStep) return;
    setActiveStepId(nextStep.id);
  }

  return (
    <main
      ref={focusRef}
      className="review-surface"
      data-focus-root="main-review"
      aria-label="Main review surface"
      tabIndex={-1}
    >
      <section className="review-brief article-surface">
        <p className="eyebrow">Review brief</p>
        <h2>{changeUnit.title}</h2>

        <div className="surface-topline">
          <span className={`binary-state-pill binary-state-${sidebarState}`}>{stateLabel}</span>
          {detail.review_verdicts.length > 0 ? (
            <div className="verdict-strip" aria-label="Review verdicts">
              {detail.review_verdicts.map((verdict) => {
                const meta = getReviewVerdictMeta(verdict.verdict);
                return (
                  <span key={verdict.id} className={`verdict-pill verdict-pill-${meta.tone}`}>
                    {verdict.reviewer_role.replaceAll('_', ' ')}: {meta.label}
                  </span>
                );
              })}
            </div>
          ) : null}
        </div>

        <section className="changed-files-block" aria-labelledby="changed-files-title">
          <div className="section-heading compact-heading">
            <div>
              <p className="eyebrow">Files changed</p>
              <h3 id="changed-files-title">{changedFiles.length} files in scope</h3>
            </div>
          </div>

          <div className="changed-files-list">
            {changedFiles.map((file) => (
              <div key={file.id} className="changed-file-chip">
                <span className="changed-file-path">{file.displayPath}</span>
                <span className="diff-counts">
                  <span className="diff-add">+{file.additions}</span>
                  <span className="diff-del">-{file.deletions}</span>
                </span>
              </div>
            ))}
          </div>
        </section>

        <p className="brief-summary">{tutorial.executive_summary}</p>

        <section className="tutorial-stepper" aria-labelledby="tutorial-stepper-title">
          <div className="section-heading tutorial-stepper-header">
            <div>
              <p className="eyebrow">Tutorial</p>
              <h3 id="tutorial-stepper-title">
                Step {activeStepIndex + 1} of {totalSteps}
              </h3>
            </div>

            {totalSteps > 1 ? (
              <div className="stepper-direction-controls">
                <button
                  className="ghost-button"
                  disabled={activeStepIndex === 0}
                  onClick={() => goToStep(activeStepIndex - 1)}
                  type="button"
                >
                  Previous
                </button>
                <button
                  className="ghost-button"
                  disabled={activeStepIndex >= totalSteps - 1}
                  onClick={() => goToStep(activeStepIndex + 1)}
                  type="button"
                >
                  Next
                </button>
              </div>
            ) : null}
          </div>

          <div className="stepper-nav-scroll">
            <div className="stepper-nav" role="tablist" aria-label="Tutorial steps">
              {tutorial.steps.map((step, index) => (
                <button
                  key={step.id}
                  className={`stepper-tab${step.id === activeStep?.id ? ' is-active' : ''}`}
                  data-step-title={step.title}
                  onClick={() => setActiveStepId(step.id)}
                  role="tab"
                  type="button"
                >
                  <span className="stepper-index">{index + 1}</span>
                  <span className="stepper-title">{step.title}</span>
                </button>
              ))}
            </div>
          </div>

          {activeStep ? (
            <article className="tutorial-step-card">
              <header className="tutorial-step-header">
                <div>
                  <p className="section-label">Step title</p>
                  <h4>{activeStep.title}</h4>
                </div>
                <p className="tutorial-step-intent">{activeStep.intent}</p>
              </header>

              {activeStep.affected_files.length > 0 ? (
                <div className="tutorial-files">
                  <p className="section-label">Affected files</p>
                  <div className="tutorial-file-list">
                    {activeStep.affected_files.map((file) => (
                      <span key={file} className="tutorial-file-chip">
                        {file}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}

              {activeStep.evidence_snippets.length > 0 ? (
                <div className="evidence-list">
                  {activeStep.evidence_snippets.map((snippet) => (
                    <figure key={snippet.id} className="evidence-card">
                      <figcaption>{snippet.label}</figcaption>
                      <pre>
                        <code>{snippet.snippet}</code>
                      </pre>
                    </figure>
                  ))}
                </div>
              ) : null}

              <div className="tutorial-step-body markdown-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {activeStep.body_markdown}
                </ReactMarkdown>
              </div>
            </article>
          ) : null}
        </section>
      </section>

      <section
        className={`surface-card action-area ${promptExpanded ? 'is-expanded' : 'is-collapsed'}`}
        data-next-prompt-mode={promptExpanded ? 'expanded' : 'collapsed'}
        data-execution-state={effectiveExecutionStatus}
      >
        <div className="section-heading action-area-header">
          <div>
            <p className="eyebrow">Next action</p>
            <h3>
              {effectiveExecutionStatus === 'launching'
                ? 'Launching next chunk'
                : detail.execution_state.status === 'launched'
                  ? 'Next chunk started'
                  : detail.execution_state.status === 'failed'
                    ? 'Next chunk failed'
                    : promptExpanded
                      ? 'Take the next step'
                      : 'Prepared follow-up'}
            </h3>
          </div>

          {changeUnit.next_action ? (
            detail.execution_state.status === 'launched' ? (
              <button
                className="solid-button execute-next-button"
                data-open-live-session="true"
                onClick={onOpenLiveSession}
                type="button"
              >
                Open Live Session
              </button>
            ) : (
              <button
                className="solid-button execute-next-button"
                data-execute-next="true"
                disabled={effectiveExecutionStatus === 'launching'}
                onClick={() => void handleExecuteNext()}
                type="button"
              >
                {effectiveExecutionStatus === 'launching'
                  ? 'Launching…'
                  : detail.execution_state.status === 'failed'
                    ? 'Retry Execute Next Prompt'
                    : changeUnit.next_action.label ?? 'Execute Next Prompt'}
              </button>
            )
          ) : null}
        </div>

        <p className="action-intro">
          {effectiveExecutionStatus === 'launching'
            ? 'Launching the configured next chunk. This review packet stays immutable while the live work starts in parallel.'
            : detail.execution_state.status === 'launched'
              ? 'The reviewed checkpoint remains fixed here. The next chunk is now running as a separate live Codex session you can open from the replay panel.'
              : detail.execution_state.status === 'failed'
                ? 'The launch failed. The checkpoint is unchanged and you can retry after reviewing the real error below.'
                : promptExpanded
                  ? 'This packet needs a real follow-up. The action below forks or resumes the configured Codex thread and starts the next turn against the committed example project.'
                  : 'This packet does not need you yet. The prepared follow-up stays here as supporting context until the unit moves back into attention.'}
        </p>

        {workspaceRequest ? (
          <dl className="execution-metadata execution-metadata-planned">
            <div>
              <dt>Workspace strategy</dt>
              <dd>{workspaceRequest.strategy}</dd>
            </div>
            <div>
              <dt>Workspace source</dt>
              <dd>
                <code>{workspaceRequest.repo.id ?? workspaceRequest.repo.source ?? 'repo'}</code>
              </dd>
            </div>
            <div>
              <dt>Base</dt>
              <dd>
                <code>
                  {workspaceRequest.from
                    ? workspaceRequest.from.kind === 'branch'
                      ? workspaceRequest.from.branch
                      : workspaceRequest.from.kind === 'ref'
                        ? workspaceRequest.from.ref
                        : workspaceRequest.from.kind === 'commit'
                          ? workspaceRequest.from.commit
                          : workspaceRequest.from.workspace_id
                    : 'default trunk'}
                </code>
              </dd>
            </div>
          </dl>
        ) : null}

        {detail.execution_state.status === 'launched' ? (
          <div className="execution-record" data-execution-result="true">
            <p className="execution-note">
              {detail.execution_state.message ?? 'Started the next chunk successfully.'}
            </p>
            <dl className="execution-metadata">
              <div>
                <dt>Thread</dt>
                <dd>
                  <code>{detail.execution_state.thread_id}</code>
                </dd>
              </div>
              <div>
                <dt>Turn</dt>
                <dd>
                  <code>{detail.execution_state.turn_id}</code>
                </dd>
              </div>
              <div>
                <dt>Started</dt>
                <dd>{formatLongTimestamp(detail.execution_state.started_at)}</dd>
              </div>
              <div>
                <dt>Source</dt>
                <dd>{detail.execution_state.thread_source}</dd>
              </div>
              {detail.execution_state.workspace ? (
                <>
                  <div>
                    <dt>Workspace</dt>
                    <dd>
                      <code>{detail.execution_state.workspace.path}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Strategy</dt>
                    <dd>{detail.execution_state.workspace.strategy}</dd>
                  </div>
                </>
              ) : null}
            </dl>
          </div>
        ) : null}

        {executionError ? <p className="execution-note execution-error">{executionError}</p> : null}

        {changeUnit.next_action ? (
          promptExpanded ? (
            <div className="next-prompt-body markdown-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {changeUnit.next_action.prompt}
              </ReactMarkdown>
            </div>
          ) : (
            <details className="next-prompt-details">
              <summary>Show prepared next prompt</summary>
              <div className="next-prompt-body markdown-body">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {changeUnit.next_action.prompt}
                </ReactMarkdown>
              </div>
            </details>
          )
        ) : (
          <p className="muted-copy">No executable next action is attached to this packet.</p>
        )}
      </section>

      <section className="surface-card diff-card reading-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Diff</p>
            <h3>Code changes</h3>
          </div>
        </div>

        <DiffViewer diffText={changeUnit.diff} />
      </section>
    </main>
  );
}
