import { useEffect, useMemo, useState, type RefObject } from 'react';

import type { ChangeUnitDetail, ReplayTurn } from '../../shared/api.ts';
import { formatLongTimestamp } from '../lib/format.ts';

type SessionReplayPanelProps = {
  detail: ChangeUnitDetail;
  mode: 'linked' | 'live';
  onModeChange: (mode: 'linked' | 'live') => void;
  focusRef?: RefObject<HTMLElement | null>;
};

type ReplayFilter = 'all' | 'assistant' | 'tool' | 'user';

function roleWeight(role: string): number {
  switch (role) {
    case 'planner':
      return 0;
    case 'implementer':
      return 1;
    case 'reviewer_a':
      return 2;
    case 'reviewer_b':
      return 3;
    default:
      return 9;
  }
}

export function SessionReplayPanel({
  detail,
  mode,
  onModeChange,
  focusRef,
}: SessionReplayPanelProps) {
  const sessions = useMemo(
    () => [...detail.agent_sessions].sort((a, b) => roleWeight(a.role) - roleWeight(b.role)),
    [detail.agent_sessions],
  );
  const [activeSessionId, setActiveSessionId] = useState<string>(sessions[0]?.id ?? '');
  const [filter, setFilter] = useState<ReplayFilter>('all');

  useEffect(() => {
    setActiveSessionId(sessions[0]?.id ?? '');
    setFilter('all');
  }, [detail.change_unit.id, sessions]);

  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? sessions[0];
  const linkedTurns = useMemo(() => {
    if (!activeSession) return [];

    return activeSession.transcript.turns
      .map((turn) => ({
        ...turn,
        items: turn.items.filter((item) => filter === 'all' || item.type === filter),
      }))
      .filter((turn) => turn.items.length > 0);
  }, [activeSession, filter]);

  const liveTurns = useMemo(() => {
    if (!detail.live_session) return [];

    return detail.live_session.transcript.turns
      .map((turn) => ({
        ...turn,
        items: turn.items.filter((item) => filter === 'all' || item.type === filter),
      }))
      .filter((turn) => turn.items.length > 0);
  }, [detail.live_session, filter]);

  const showLiveTab =
    detail.execution_state.status === 'launching' ||
    detail.execution_state.status === 'launched' ||
    detail.execution_state.status === 'failed' ||
    detail.live_session !== null;

  return (
    <aside
      ref={focusRef}
      className="replay-panel"
      aria-label="Replay and live sessions"
      tabIndex={-1}
    >
      <header className="panel-header">
        <div>
          <p className="eyebrow">Replay</p>
          <h3>{mode === 'live' ? 'Live session' : 'Linked sessions'}</h3>
        </div>
        <span className="panel-pill">
          {mode === 'live' && detail.live_session ? 'Live' : `${sessions.length} sessions`}
        </span>
      </header>

      {showLiveTab ? (
        <div className="replay-mode-toggle" role="tablist" aria-label="Replay views">
          <button
            className={`replay-mode-tab${mode === 'linked' ? ' active' : ''}`}
            onClick={() => onModeChange('linked')}
            role="tab"
            type="button"
          >
            Checkpoint replay
          </button>
          <button
            className={`replay-mode-tab${mode === 'live' ? ' active' : ''}`}
            onClick={() => onModeChange('live')}
            role="tab"
            type="button"
          >
            Live session
          </button>
        </div>
      ) : null}

      {mode === 'live' ? (
        <>
          {detail.execution_state.status === 'launching' ? (
            <section className="replay-card live-session-card" data-live-session-state="launching">
              <div className="section-heading">
                <div>
                  <p className="section-label">Status</p>
                  <h4>Launching next chunk</h4>
                </div>
              </div>
              <p className="session-summary-copy">
                {detail.execution_state.message ??
                  'Starting the configured next chunk. Live thread details will appear here as soon as the turn starts.'}
              </p>
            </section>
          ) : null}

          {detail.execution_state.status === 'failed' ? (
            <section className="replay-card live-session-card" data-live-session-state="failed">
              <div className="section-heading">
                <div>
                  <p className="section-label">Status</p>
                  <h4>Launch failed</h4>
                </div>
              </div>
              <p className="session-summary-copy">{detail.execution_state.error_message}</p>
              <p className="transcript-meta">Retry from the center action area.</p>
            </section>
          ) : null}

          {detail.live_session ? (
            <>
              <section className="replay-card live-session-card" data-live-session-state="launched">
                <div className="section-heading">
                  <div>
                    <p className="section-label">Live thread</p>
                    <h4>{detail.live_session.preview || 'Live session'}</h4>
                  </div>
                  <div className="session-meta">
                    <span>{detail.live_session.status}</span>
                    <span>{detail.live_session.thread_source}</span>
                  </div>
                </div>

                <p className="session-summary-copy">
                  {detail.execution_state.status === 'launched' ? detail.execution_state.message : null}
                </p>

                <dl className="live-session-metadata">
                  <div>
                    <dt>Thread</dt>
                    <dd>
                      <code>{detail.live_session.thread_id}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Turn</dt>
                    <dd>
                      <code>{detail.live_session.turn_id}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Started</dt>
                    <dd>{formatLongTimestamp(detail.live_session.started_at)}</dd>
                  </div>
                </dl>

                {detail.live_session_error ? (
                  <p className="execution-note execution-error">{detail.live_session_error}</p>
                ) : null}
              </section>

              <div className="transcript-controls">
                <span className="section-label">Live transcript</span>
                <div className="filter-pills">
                  {(['all', 'assistant', 'tool', 'user'] as ReplayFilter[]).map((nextFilter) => (
                    <button
                      key={nextFilter}
                      className={`filter-pill${nextFilter === filter ? ' active' : ''}`}
                      onClick={() => setFilter(nextFilter)}
                      type="button"
                    >
                      {nextFilter}
                    </button>
                  ))}
                </div>
              </div>

              <TranscriptList turns={liveTurns} emptyCopy="The launched session has no visible transcript items yet." />
            </>
          ) : detail.execution_state.status === 'launched' ? (
            <div className="empty-panel inset-empty">
              <p>{detail.live_session_error ?? 'Waiting for the launched session to become readable.'}</p>
            </div>
          ) : null}
        </>
      ) : activeSession ? (
        <>
          <div className="session-tabs" role="tablist" aria-label="Linked sessions">
            {sessions.map((session) => (
              <button
                key={session.id}
                className={`session-tab${session.id === activeSession?.id ? ' active' : ''}`}
                onClick={() => setActiveSessionId(session.id)}
                role="tab"
                type="button"
              >
                <span>{session.role.replaceAll('_', ' ')}</span>
                <strong>{session.status}</strong>
              </button>
            ))}
          </div>

          <section className="replay-card">
            <div className="section-heading">
              <div>
                <p className="section-label">Session</p>
                <h4>{activeSession.role.replaceAll('_', ' ')}</h4>
              </div>
              <div className="session-meta">
                <span>{activeSession.runtime}</span>
                <span>{activeSession.status}</span>
              </div>
            </div>

            <p className="session-summary-copy">
              {activeSession.summary ?? activeSession.transcript.summary ?? 'No summary captured.'}
            </p>

            {activeSession.milestones.length > 0 ? (
              <ul className="milestone-list">
                {activeSession.milestones.map((milestone) => (
                  <li key={milestone.id}>
                    <strong>{milestone.label}</strong>
                    {milestone.description ? <span>{milestone.description}</span> : null}
                    <time>{formatLongTimestamp(milestone.timestamp)}</time>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <div className="transcript-controls">
            <span className="section-label">Transcript</span>
            <div className="filter-pills">
              {(['all', 'assistant', 'tool', 'user'] as ReplayFilter[]).map((nextFilter) => (
                <button
                  key={nextFilter}
                  className={`filter-pill${nextFilter === filter ? ' active' : ''}`}
                  onClick={() => setFilter(nextFilter)}
                  type="button"
                >
                  {nextFilter}
                </button>
              ))}
            </div>
          </div>

          <TranscriptList turns={linkedTurns} emptyCopy="No transcript items match the current filter." />
        </>
      ) : (
        <div className="empty-panel inset-empty">
          <p>No linked sessions are attached yet.</p>
        </div>
      )}
    </aside>
  );
}

function TranscriptList({ turns, emptyCopy }: { turns: ReplayTurn[]; emptyCopy: string }) {
  return (
    <div className="transcript-list">
      {turns.length > 0 ? (
        turns.map((turn) => (
          <section key={turn.id} className="turn-card">
            <header className="turn-header">
              <div>
                <strong>{turn.label ?? 'Turn'}</strong>
                <span>{turn.status ?? 'completed'}</span>
              </div>
              <time>{formatLongTimestamp(turn.timestamp)}</time>
            </header>

            <div className="turn-items">
              {turn.items.map((item) => (
                <article key={item.id} className={`transcript-item item-${item.type}`}>
                  <div className="transcript-item-title">
                    <strong>{item.title ?? item.type}</strong>
                    {item.timestamp ? <time>{formatLongTimestamp(item.timestamp)}</time> : null}
                  </div>
                  {item.command ? <pre className="command-block">{item.command}</pre> : null}
                  {item.text ? <p>{item.text}</p> : null}
                  {item.output ? <pre className="transcript-output">{item.output}</pre> : null}
                  {typeof item.exit_code === 'number' ? (
                    <p className="transcript-meta">
                      exit {item.exit_code} · {item.duration_ms ?? 0} ms
                    </p>
                  ) : null}
                </article>
              ))}
            </div>
          </section>
        ))
      ) : (
        <div className="empty-panel inset-empty">
          <p>{emptyCopy}</p>
        </div>
      )}
    </div>
  );
}
