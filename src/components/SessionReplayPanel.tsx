import { useMemo, type RefObject } from 'react';

import type { ChangeUnitDetail, CodexLiveApproval, CodexSessionView } from '../../shared/api.ts';
import { formatLongTimestamp } from '../lib/format.ts';
import { orderSessions } from '../lib/sessionOrder.ts';
import { CodexThreadViewer } from './CodexThreadViewer.tsx';

type LiveSessionUpdates = {
  mode: 'idle' | 'events' | 'polling';
  threadId: string | null;
  eventCount: number;
  lastEventAt: string | null;
  lastMethod: string | null;
};

type SessionReplayPanelProps = {
  detail: ChangeUnitDetail;
  panelId?: string;
  preferredSessionId?: string | null;
  liveSessionUpdates: LiveSessionUpdates;
  focusRef?: RefObject<HTMLElement | null>;
  replayFocused?: boolean;
  onSelectSession: (sessionId: string) => void;
  onRespondApproval: (
    threadId: string,
    requestId: number,
    decision: 'accept' | 'decline',
  ) => Promise<void>;
  respondingApprovalIds: number[];
  approvalErrorMessage: string | null;
};

function humanizeToken(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function getSessionLabel(session: CodexSessionView): string {
  return session.source_kind === 'live' ? 'Live Session' : humanizeToken(session.role);
}

function getSessionMeta(session: CodexSessionView): string {
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

export function SessionReplayPanel({
  detail,
  panelId,
  preferredSessionId,
  liveSessionUpdates,
  focusRef,
  replayFocused = false,
  onSelectSession,
  onRespondApproval,
  respondingApprovalIds,
  approvalErrorMessage,
}: SessionReplayPanelProps) {
  const sessions = useMemo(() => orderSessions(detail.session_views), [detail.session_views]);
  const activeSession =
    sessions.find((session) => session.id === preferredSessionId) ?? sessions[0] ?? null;
  const liveSession =
    activeSession?.source_kind === 'live' && activeSession.thread?.id === liveSessionUpdates.threadId
      ? liveSessionUpdates
      : null;

  return (
    <aside
      ref={focusRef}
      className="replay-panel"
      aria-label="Replay and live sessions"
      data-replay-focus={replayFocused}
      data-active-session-id={activeSession?.id ?? ''}
      data-active-session-role={activeSession?.role ?? ''}
      tabIndex={-1}
      id={panelId}
    >
      <header className="panel-header">
        <div>
          <p className="eyebrow">Sessions</p>
          <h3>{activeSession ? getSessionLabel(activeSession) : 'Codex session log'}</h3>
        </div>
        <span className="panel-pill">{sessions.length} threads</span>
      </header>

      {detail.execution_state.status === 'launching' ? (
        <section className="replay-log-shell replay-status-shell" data-live-session-state="launching">
          <p className="section-label">Launching next chunk</p>
          <p className="session-summary-copy">
            {detail.execution_state.message ??
              'Starting the configured Codex thread. The launched session will appear here once the turn is readable.'}
          </p>
        </section>
      ) : null}

      {detail.execution_state.status === 'failed' ? (
        <section className="replay-log-shell replay-status-shell" data-live-session-state="failed">
          <p className="section-label">Launch failed</p>
          <p className="session-summary-copy">{detail.execution_state.error_message}</p>
        </section>
      ) : null}

      {sessions.length > 0 ? (
        <>
          <div className="session-tabs" role="tablist" aria-label="Codex sessions">
            {sessions.map((session) => (
              <button
                key={session.id}
                className={`session-tab${session.id === activeSession?.id ? ' active' : ''}`}
                data-session-role={session.role}
                data-session-source={session.source_kind}
                onClick={() => onSelectSession(session.id)}
                role="tab"
                type="button"
              >
                <span>{getSessionLabel(session)}</span>
                <strong>{getSessionMeta(session)}</strong>
              </button>
            ))}
          </div>

          {activeSession ? (
            <>
              <section
                className="replay-log-shell replay-session-shell"
                data-session-view={activeSession.source_kind}
              >
                <div className="section-heading">
                  <div>
                    <p className="section-label">{activeSession.source_kind === 'live' ? 'Live thread' : 'Captured thread'}</p>
                    <h4>{activeSession.thread?.preview || activeSession.summary || getSessionLabel(activeSession)}</h4>
                  </div>
                  <div className="session-meta">
                    <span>{activeSession.runtime}</span>
                    <span>{getSessionMeta(activeSession)}</span>
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

                {activeSession.summary ? (
                  <p className="session-summary-copy">{activeSession.summary}</p>
                ) : null}

                {activeSession.launched_from ? (
                  <dl className="live-session-metadata">
                    <div>
                      <dt>Started</dt>
                      <dd>{formatLongTimestamp(activeSession.launched_from.started_at)}</dd>
                    </div>
                    <div>
                      <dt>Source</dt>
                      <dd>{activeSession.launched_from.thread_source}</dd>
                    </div>
                    <div>
                      <dt>Turn</dt>
                      <dd>
                        <code>{activeSession.launched_from.turn_id ?? 'pending'}</code>
                      </dd>
                    </div>
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

                {activeSession.thread ? (
                  <dl className="thread-metadata">
                    <div>
                      <dt>Thread</dt>
                      <dd>
                        <code>{activeSession.thread.id}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>Provider</dt>
                      <dd>{activeSession.thread.modelProvider}</dd>
                    </div>
                    <div>
                      <dt>Working dir</dt>
                      <dd>
                        <code>{activeSession.thread.cwd || 'unknown'}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>Turns</dt>
                      <dd>{activeSession.thread.turns.length}</dd>
                    </div>
                  </dl>
                ) : null}

                {activeSession.load_error ? (
                  <p className="execution-note execution-error">{activeSession.load_error}</p>
                ) : null}
              </section>

              {activeSession.source_kind === 'live' && activeSession.approvals.length > 0 ? (
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
                    {activeSession.approvals.map((approval) => {
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

              {activeSession.milestones.length > 0 ? (
                <section className="replay-log-shell replay-milestones-shell">
                  <p className="section-label">Checkpoint milestones</p>
                  <ul className="milestone-list">
                    {activeSession.milestones.map((milestone) => (
                      <li key={milestone.id}>
                        <strong>{milestone.label}</strong>
                        {milestone.description ? <span>{milestone.description}</span> : null}
                        <time>{formatLongTimestamp(milestone.timestamp)}</time>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {activeSession.thread ? (
                <CodexThreadViewer thread={activeSession.thread} />
              ) : (
                <div className="empty-panel inset-empty">
                  <p>{activeSession.load_error ?? 'This session does not have readable Codex history yet.'}</p>
                </div>
              )}
            </>
          ) : null}
        </>
      ) : (
        <div className="empty-panel inset-empty">
          <p>No linked or live Codex sessions are attached to this checkpoint.</p>
        </div>
      )}
    </aside>
  );
}
