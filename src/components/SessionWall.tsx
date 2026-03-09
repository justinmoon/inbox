import { useMemo } from 'react';

import type { ChangeUnitDetail } from '../../shared/api.ts';
import { getSidebarState } from '../lib/format.ts';
import { orderSessions } from '../lib/sessionOrder.ts';
import {
  CodexSessionSurface,
  getSessionLabel,
  getSessionMeta,
  type LiveSessionUpdates,
} from './CodexSessionSurface.tsx';

type SessionWallProps = {
  detail: ChangeUnitDetail;
  activeSessionId?: string | null;
  liveSessionUpdates: LiveSessionUpdates;
  onColumnRef?: (sessionId: string, node: HTMLDivElement | null) => void;
  onSelectSession: (sessionId: string) => void;
  onRespondApproval: (
    threadId: string,
    requestId: number,
    decision: 'accept' | 'decline',
  ) => Promise<void>;
  respondingApprovalIds: number[];
  approvalErrorMessage: string | null;
  onExit: () => void;
};

function getBinaryStateLabel(status: string) {
  const state = getSidebarState(status);
  if (state === 'working') return 'Working';
  if (state === 'landed') return 'Landed';
  return 'Needs Attention';
}

export function SessionWall({
  detail,
  activeSessionId,
  liveSessionUpdates,
  onColumnRef,
  onSelectSession,
  onRespondApproval,
  respondingApprovalIds,
  approvalErrorMessage,
  onExit,
}: SessionWallProps) {
  const sessions = useMemo(() => orderSessions(detail.session_views), [detail.session_views]);

  return (
    <div className="session-wall" data-wall-mode="true">
      <header className="session-wall-topbar">
        <div>
          <p className="eyebrow">Session Wall</p>
          <h2>{detail.change_unit.title}</h2>
        </div>
        <div className="session-wall-meta">
          <span className={`binary-state-pill binary-state-${getSidebarState(detail.change_unit.status)}`}>
            {getBinaryStateLabel(detail.change_unit.status)}
          </span>
          <button className="ghost-button session-wall-exit" onClick={onExit} type="button">
            Exit Wall
          </button>
        </div>
      </header>

      <div className="session-wall-columns" data-session-count={String(sessions.length)}>
        {sessions.map((session) => {
          const isActive = session.id === activeSessionId;

          return (
            <section
              key={session.id}
              className={`session-wall-column${isActive ? ' is-active' : ''}`}
              data-wall-session-id={session.id}
              data-wall-session-role={session.role}
              data-wall-column-active={isActive}
            >
              <div
                ref={(node) => onColumnRef?.(session.id, node)}
                className="session-wall-column-scroll"
                data-wall-scroll-for={session.id}
                onClick={(event) => {
                  onSelectSession(session.id);
                  event.currentTarget.focus();
                }}
                tabIndex={-1}
              >
                <header className="session-wall-column-header">
                  <div>
                    <p className="section-label">{session.role.replaceAll('_', ' ')}</p>
                    <h3>{getSessionLabel(session)}</h3>
                  </div>
                  <div className="session-wall-column-meta">
                    <span className="panel-pill">{getSessionMeta(session)}</span>
                    <span className="panel-pill">{session.runtime}</span>
                  </div>
                </header>

                <CodexSessionSurface
                  session={session}
                  liveSessionUpdates={liveSessionUpdates}
                  onRespondApproval={onRespondApproval}
                  respondingApprovalIds={respondingApprovalIds}
                  approvalErrorMessage={approvalErrorMessage}
                  variant="wall"
                />
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
