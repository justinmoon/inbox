import { useMemo, type RefObject } from 'react';

import type { ChangeUnitDetail } from '../../shared/api.ts';
import { orderSessions } from '../lib/sessionOrder.ts';
import {
  CodexSessionSurface,
  getSessionLabel,
  getSessionMeta,
  type LiveSessionUpdates,
} from './CodexSessionSurface.tsx';

type SessionReplayPanelProps = {
  detail: ChangeUnitDetail;
  panelId?: string;
  preferredSessionId?: string | null;
  liveSessionUpdates: LiveSessionUpdates;
  focusRef?: RefObject<HTMLElement | null>;
  onSelectSession: (sessionId: string) => void;
  onRespondApproval: (
    threadId: string,
    requestId: number,
    decision: 'accept' | 'decline',
  ) => Promise<void>;
  respondingApprovalIds: number[];
  approvalErrorMessage: string | null;
};

export function SessionReplayPanel({
  detail,
  panelId,
  preferredSessionId,
  liveSessionUpdates,
  focusRef,
  onSelectSession,
  onRespondApproval,
  respondingApprovalIds,
  approvalErrorMessage,
}: SessionReplayPanelProps) {
  const sessions = useMemo(() => orderSessions(detail.session_views), [detail.session_views]);
  const activeSession =
    sessions.find((session) => session.id === preferredSessionId) ?? sessions[0] ?? null;

  return (
    <aside
      ref={focusRef}
      className="replay-panel"
      aria-label="Replay and live sessions"
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
            <CodexSessionSurface
              session={activeSession}
              liveSessionUpdates={liveSessionUpdates}
              onRespondApproval={onRespondApproval}
              respondingApprovalIds={respondingApprovalIds}
              approvalErrorMessage={approvalErrorMessage}
              variant="rail"
            />
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
