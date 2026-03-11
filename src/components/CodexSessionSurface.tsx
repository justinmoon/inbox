import type { CodexLiveApproval, CodexSessionView } from '../../shared/api.ts';
import { formatLongTimestamp } from '../lib/format.ts';
import { CodexThreadViewer } from './CodexThreadViewer.tsx';

export type LiveSessionUpdates = {
  mode: 'idle' | 'events' | 'polling';
  threadId: string | null;
  eventCount: number;
  lastEventAt: string | null;
  lastMethod: string | null;
};

type CodexSessionSurfaceProps = {
  session: CodexSessionView;
  liveSessionUpdates: LiveSessionUpdates;
  onRespondApproval: (
    threadId: string,
    requestId: number,
    decision: 'accept' | 'decline',
  ) => Promise<void>;
  respondingApprovalIds: number[];
  approvalErrorMessage: string | null;
  variant?: 'rail' | 'wall';
};

function humanizeToken(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    return 'Unknown';
  }

  return value.replaceAll('_', ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

export function getSessionLabel(session: CodexSessionView): string {
  return session.source_kind === 'live' ? 'Live Session' : humanizeToken(session.role);
}

export function getSessionMeta(session: CodexSessionView): string {
  if (session.source_kind === 'live') return 'Launched';
  return session.status;
}

function getApprovalTitle(approval: CodexLiveApproval) {
  switch (approval.approval_kind) {
    case 'commandExecution':
      return 'Command approval';
    case 'fileChange':
      return 'File change approval';
    default:
      return 'Approval request';
  }
}

function getApprovalStatusCopy(approval: CodexLiveApproval) {
  if (approval.status === 'pending') return 'Pending';
  if (approval.status === 'cleared') return 'Resolved';
  return approval.decision === 'accept' ? 'Accepted' : 'Declined';
}

export function CodexSessionSurface({
  session,
  liveSessionUpdates,
  onRespondApproval,
  respondingApprovalIds,
  approvalErrorMessage,
  variant = 'rail',
}: CodexSessionSurfaceProps) {
  const liveSession =
    session.source_kind === 'live' && session.thread?.id === liveSessionUpdates.threadId
      ? liveSessionUpdates
      : null;

  return (
    <div className={`codex-session-surface codex-session-surface-${variant}`}>
      <section
        className="replay-log-shell replay-session-shell codex-session-shell"
        data-session-view={session.source_kind}
      >
        <div className="section-heading codex-session-shell-header">
          <div>
            <p className="section-label">
              {session.source_kind === 'live' ? 'Live thread' : 'Captured thread'}
            </p>
            <h4>{session.thread?.preview || session.summary || getSessionLabel(session)}</h4>
          </div>
          <div className="session-meta">
            <span>{session.runtime}</span>
            <span>{getSessionMeta(session)}</span>
            {liveSession ? (
              <span
                className={`live-update-pill live-update-pill-${liveSession.mode}`}
                data-live-update-mode={liveSession.mode}
                data-live-update-count={String(liveSession.eventCount)}
              >
                {liveSession.mode === 'events'
                  ? `Live updates ${liveSession.eventCount > 0 ? `(${liveSession.eventCount})` : ''}`
                  : liveSession.mode === 'polling'
                    ? 'Polling for updates'
                    : 'Live session'}
              </span>
            ) : null}
          </div>
        </div>

        {session.summary ? <p className="session-summary-copy">{session.summary}</p> : null}

        {session.launched_from ? (
          <dl className="live-session-metadata">
            <div>
              <dt>Started</dt>
              <dd>{formatLongTimestamp(session.launched_from.started_at)}</dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>{session.launched_from.thread_source}</dd>
            </div>
            <div>
              <dt>Turn</dt>
              <dd>
                <code>{session.launched_from.turn_id ?? 'pending'}</code>
              </dd>
            </div>
            {session.launched_from.workspace_path ? (
              <div>
                <dt>Workspace</dt>
                <dd>
                  <code>{session.launched_from.workspace_path}</code>
                </dd>
              </div>
            ) : null}
            {session.launched_from.workspace_strategy ? (
              <div>
                <dt>Strategy</dt>
                <dd>{session.launched_from.workspace_strategy}</dd>
              </div>
            ) : null}
            {liveSession?.lastMethod ? (
              <div>
                <dt>Latest event</dt>
                <dd>{liveSession.lastMethod}</dd>
              </div>
            ) : null}
            {liveSession?.lastEventAt ? (
              <div>
                <dt>Last update</dt>
                <dd>{formatLongTimestamp(liveSession.lastEventAt)}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}

        {session.thread ? (
          <dl className="thread-metadata">
            <div>
              <dt>Thread</dt>
              <dd>
                <code>{session.thread.id}</code>
              </dd>
            </div>
            <div>
              <dt>Provider</dt>
              <dd>{session.thread.modelProvider}</dd>
            </div>
            <div>
              <dt>Working dir</dt>
              <dd>
                <code>{session.thread.cwd || 'unknown'}</code>
              </dd>
            </div>
            <div>
              <dt>Turns</dt>
              <dd>{session.thread.turns.length}</dd>
            </div>
          </dl>
        ) : null}

        {session.load_error ? (
          <p className="execution-note execution-error">{session.load_error}</p>
        ) : null}
      </section>

      {session.source_kind === 'live' && session.approvals.length > 0 ? (
        <section className="replay-log-shell replay-approvals-shell">
          <div className="section-heading">
            <div>
              <p className="section-label">Approvals</p>
              <h4>Inline live-session approvals</h4>
            </div>
          </div>

          {approvalErrorMessage ? (
            <p className="execution-note execution-error">{approvalErrorMessage}</p>
          ) : null}

          <div className="approval-list">
            {session.approvals.map((approval) => {
              const isResponding = respondingApprovalIds.includes(approval.request_id);

              return (
                <article
                  key={approval.request_id}
                  className={`approval-card approval-card-${approval.status}`}
                  data-approval-kind={approval.approval_kind}
                  data-approval-request-id={String(approval.request_id)}
                  data-approval-status={approval.status}
                >
                  <header className="approval-card-header">
                    <div>
                      <p className="section-label">{getApprovalTitle(approval)}</p>
                      <h5>{getApprovalStatusCopy(approval)}</h5>
                    </div>
                    <code>request {approval.request_id}</code>
                  </header>

                  {approval.reason ? <p className="thread-item-text">{approval.reason}</p> : null}

                  {approval.command ? (
                    <pre className="thread-code-block">
                      <code>{approval.command}</code>
                    </pre>
                  ) : null}

                  {approval.changes && approval.changes.length > 0 ? (
                    <div className="thread-file-change-list">
                      {approval.changes.map((change, index) => (
                        <section
                          key={`${change.path ?? change.kind ?? 'change'}-${index}`}
                          className="thread-file-change-entry"
                        >
                          <header className="thread-file-change-header">
                            <strong>{change.path ?? 'Pending change'}</strong>
                            {change.kind ? <span>{change.kind}</span> : null}
                          </header>
                          {change.diff ? (
                            <pre className="thread-code-block thread-patch-block">
                              <code>{change.diff}</code>
                            </pre>
                          ) : null}
                        </section>
                      ))}
                    </div>
                  ) : null}

                  <dl className="thread-item-metadata">
                    <div>
                      <dt>Thread</dt>
                      <dd>
                        <code>{approval.thread_id}</code>
                      </dd>
                    </div>
                    {approval.turn_id ? (
                      <div>
                        <dt>Turn</dt>
                        <dd>
                          <code>{approval.turn_id}</code>
                        </dd>
                      </div>
                    ) : null}
                    {approval.item_id ? (
                      <div>
                        <dt>Item</dt>
                        <dd>
                          <code>{approval.item_id}</code>
                        </dd>
                      </div>
                    ) : null}
                    {approval.cwd ? (
                      <div>
                        <dt>cwd</dt>
                        <dd>
                          <code>{approval.cwd}</code>
                        </dd>
                      </div>
                    ) : null}
                  </dl>

                  {approval.status === 'pending' ? (
                    <div className="approval-actions">
                      <button
                        className="execute-next-button"
                        disabled={isResponding}
                        onClick={() =>
                          void onRespondApproval(approval.thread_id, approval.request_id, 'accept')
                        }
                        type="button"
                      >
                        {isResponding ? 'Responding…' : 'Accept'}
                      </button>
                      <button
                        className="replay-mode-tab"
                        disabled={isResponding}
                        onClick={() =>
                          void onRespondApproval(approval.thread_id, approval.request_id, 'decline')
                        }
                        type="button"
                      >
                        Decline
                      </button>
                    </div>
                  ) : (
                    <p className="thread-item-text">
                      {approval.status === 'cleared'
                        ? 'This request is no longer pending.'
                        : approval.decision === 'accept'
                          ? 'Codex was allowed to continue.'
                          : 'Codex was declined for this action.'}
                    </p>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      ) : null}

      {session.milestones.length > 0 ? (
        <section className="replay-log-shell replay-milestones-shell">
          <p className="section-label">Checkpoint milestones</p>
          <ul className="milestone-list">
            {session.milestones.map((milestone) => (
              <li key={milestone.id}>
                <strong>{milestone.label}</strong>
                {milestone.description ? <span>{milestone.description}</span> : null}
                <time>{formatLongTimestamp(milestone.timestamp)}</time>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {session.thread ? (
        <CodexThreadViewer thread={session.thread} />
      ) : (
        <div className="empty-panel inset-empty">
          <p>{session.load_error ?? 'This session does not have readable Codex history yet.'}</p>
        </div>
      )}
    </div>
  );
}
