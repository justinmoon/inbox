import { useEffect, useMemo, useState } from 'react';

import type { ChangeUnitDetail } from '../../shared/api.ts';
import { formatLongTimestamp, reviewVerdictMeta } from '../lib/format.ts';

type SessionReplayPanelProps = {
  detail: ChangeUnitDetail;
  refreshingSessionId: string | null;
  onRefreshFromCodex: (sessionId: string) => void;
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
  refreshingSessionId,
  onRefreshFromCodex,
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
  const visibleTurns = useMemo(() => {
    if (!activeSession) return [];
    return activeSession.transcript.turns
      .map((turn) => ({
        ...turn,
        items: turn.items.filter((item) => filter === 'all' || item.type === filter),
      }))
      .filter((turn) => turn.items.length > 0);
  }, [activeSession, filter]);

  const sessionVerdicts = detail.review_verdicts.filter(
    (verdict) => verdict.reviewer_role === activeSession?.role,
  );
  const codexSync = activeSession?.codex_sync;
  const syncTone =
    codexSync?.last_error ? 'red' : codexSync?.last_succeeded_at ? 'green' : codexSync?.last_attempted_at ? 'blue' : 'slate';
  const syncLabel = codexSync?.last_error
    ? 'Refresh failed'
    : codexSync?.last_succeeded_at
      ? 'Synced from Codex'
      : codexSync?.source === 'live_create'
        ? 'Imported from Codex'
        : 'Bundle metadata';

  return (
    <aside className="replay-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Replay</p>
          <h3>Linked sessions</h3>
        </div>
        <div className="panel-pill">{sessions.length} sessions</div>
      </div>

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

      {activeSession ? (
        <>
          <div className="session-headline">
            <div>
              <h4>{activeSession.role.replaceAll('_', ' ')}</h4>
              <p>{activeSession.summary ?? activeSession.transcript.summary ?? 'No summary captured.'}</p>
            </div>
            <div className="session-actions">
              <span>{activeSession.runtime}</span>
              {activeSession.thread_id ? <span>thread {activeSession.thread_id}</span> : null}
              {activeSession.thread_id ? (
                <button
                  className="ghost-button inline-ghost"
                  onClick={() => onRefreshFromCodex(activeSession.id)}
                  disabled={refreshingSessionId === activeSession.id}
                  type="button"
                >
                  {refreshingSessionId === activeSession.id ? 'Refreshing…' : 'Refresh from Codex'}
                </button>
              ) : null}
            </div>
          </div>

          {codexSync ? (
            <div className="sync-card">
              <div className="sync-card-top">
                <span className={`status-pill compact tone-${syncTone}`}>{syncLabel}</span>
                {codexSync.source_thread_status ? <span>thread {codexSync.source_thread_status}</span> : null}
              </div>
              <div className="sync-meta-grid">
                {codexSync.last_succeeded_at ? <span>last success {formatLongTimestamp(codexSync.last_succeeded_at)}</span> : null}
                {codexSync.last_attempted_at ? <span>last attempt {formatLongTimestamp(codexSync.last_attempted_at)}</span> : null}
                {typeof codexSync.imported_turn_count === 'number' ? (
                  <span>{codexSync.imported_turn_count} turns</span>
                ) : null}
                {typeof codexSync.imported_item_count === 'number' ? (
                  <span>{codexSync.imported_item_count} transcript items</span>
                ) : null}
              </div>
              {codexSync.last_error ? <p className="sync-error-copy">{codexSync.last_error}</p> : null}
            </div>
          ) : null}

          {sessionVerdicts.length > 0 ? (
            <div className="verdict-strip">
              {sessionVerdicts.map((verdict) => (
                <div key={verdict.id} className={`verdict-card tone-${reviewVerdictMeta[verdict.verdict].tone}`}>
                  <strong>{reviewVerdictMeta[verdict.verdict].label}</strong>
                  <span>{verdict.summary}</span>
                </div>
              ))}
            </div>
          ) : null}

          <div className="timeline-card">
            <p className="section-label">Milestones</p>
            {activeSession.milestones.length > 0 ? (
              <ul className="milestone-list">
                {activeSession.milestones.map((milestone) => (
                  <li key={milestone.id}>
                    <strong>{milestone.label}</strong>
                    <span>{milestone.description}</span>
                    <time>{formatLongTimestamp(milestone.timestamp)}</time>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted-copy">No milestones were captured for this session.</p>
            )}
          </div>

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

          <div className="transcript-list">
            {visibleTurns.length > 0 ? (
              visibleTurns.map((turn) => (
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
              <div className="empty-panel">
                <p>No transcript items match the current filter.</p>
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="empty-panel">
          <p>No linked sessions are attached yet.</p>
        </div>
      )}
    </aside>
  );
}
