import { startTransition, useEffect, useMemo, useState, type FormEvent } from 'react';

import type { WorkflowRunDetail, WorkflowRunSessionDetail } from '../../shared/api.ts';
import type {
  GateRecord,
  SwarmRunAgentView,
  SwarmTimelineEntry,
  WorkflowDefinitionSummary,
  WorkflowRunRecord,
} from '../../shared/workflowRuntime.ts';
import { CodexThreadViewer } from '../components/CodexThreadViewer.tsx';
import {
  RequestError,
  answerWorkflowGate,
  createWorkflowRun,
  fetchWorkflowDefinitions,
  fetchWorkflowRunDetail,
  fetchWorkflowRuns,
  openWorkflowRunEvents,
  parseWorkflowRunStreamEvent,
  sendWorkflowPlanningMessage,
} from '../lib/api.ts';
import { formatLongTimestamp, formatTimestamp } from '../lib/format.ts';

type WorkflowRunPageProps = {
  runId: string | null;
  onNavigate: (pathname: string, replace?: boolean) => void;
};

type WorkflowRunLiveUpdates = {
  mode: 'idle' | 'events' | 'polling';
  runId: string | null;
  eventCount: number;
  lastEventAt: string | null;
  lastType: string | null;
};

const THEME_STORAGE_KEY = 'inbox.theme';

function humanizeToken(value: unknown) {
  if (typeof value !== 'string' || value.length === 0) {
    return 'Unknown';
  }

  return value.replaceAll('_', ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function readThemeId() {
  if (typeof window === 'undefined') return 'tokyo-night';
  return window.localStorage.getItem(THEME_STORAGE_KEY) ?? 'tokyo-night';
}

function getWorkflowTitle(
  definitions: WorkflowDefinitionSummary[],
  workflowId: string,
) {
  return definitions.find((entry) => entry.id === workflowId)?.title ?? workflowId;
}

function findPlannerSession(detail: WorkflowRunDetail | null) {
  return detail?.sessions.find((entry) => entry.session.kind === 'planning_conversation') ?? null;
}

function findOpenApprovalGate(detail: WorkflowRunDetail | null) {
  return detail?.open_gates.find((gate) => gate.kind === 'approval') ?? null;
}

function SessionCard({ sessionDetail }: { sessionDetail: WorkflowRunSessionDetail }) {
  const { session, thread, load_error } = sessionDetail;

  return (
    <article
      className="workflow-session-card"
      data-workflow-session-kind={session.kind}
      data-workflow-session-actor={session.actor}
      data-workflow-session-status={session.status}
      data-workflow-session-thread-id={session.thread_id}
    >
      <header className="workflow-session-card-header">
        <div>
          <p className="workflow-card-kicker">{humanizeToken(session.kind)}</p>
          <h4>{humanizeToken(session.actor)}</h4>
        </div>
        <div className="workflow-session-pills">
          <span className="workflow-state-pill workflow-state-pill-slate">{session.status}</span>
          {session.active_turn_id ? (
            <span className="workflow-state-pill workflow-state-pill-blue">Turn active</span>
          ) : null}
        </div>
      </header>

      <dl className="workflow-meta-grid">
        <div>
          <dt>Thread</dt>
          <dd>
            <code>{session.thread_id}</code>
          </dd>
        </div>
        <div>
          <dt>Workspace</dt>
          <dd>
            <code>{session.cwd ?? session.workspace_id ?? 'unavailable'}</code>
          </dd>
        </div>
        <div>
          <dt>Active turn</dt>
          <dd>
            <code>{session.active_turn_id ?? 'idle'}</code>
          </dd>
        </div>
        <div>
          <dt>Latest turn</dt>
          <dd>
            <code>{session.latest_turn_id ?? 'none yet'}</code>
          </dd>
        </div>
      </dl>

      {load_error ? <p className="execution-note execution-error">{load_error}</p> : null}
      {thread ? <CodexThreadViewer thread={thread} /> : null}
    </article>
  );
}

function GateSummary({ gate }: { gate: GateRecord }) {
  return (
    <article className="workflow-gate-summary">
      <header>
        <p className="workflow-card-kicker">{humanizeToken(gate.kind)}</p>
        <h4>{gate.title}</h4>
      </header>
      {gate.description ? <p>{gate.description}</p> : null}
      <p className="workflow-muted-copy">Options: {gate.options.map((option) => option.label).join(' • ')}</p>
    </article>
  );
}

function swarmStatePillClass(value: 'working' | 'needs_user_input' | 'failed' | 'completed') {
  switch (value) {
    case 'needs_user_input':
      return 'workflow-state-pill-amber';
    case 'failed':
      return 'workflow-state-pill-red';
    case 'completed':
      return 'workflow-state-pill-green';
    default:
      return 'workflow-state-pill-blue';
  }
}

function swarmAgentStatePillClass(value: SwarmRunAgentView['status']) {
  switch (value) {
    case 'waiting_on_user':
      return 'workflow-state-pill-amber';
    case 'failed':
      return 'workflow-state-pill-red';
    case 'idle':
      return 'workflow-state-pill-slate';
    default:
      return 'workflow-state-pill-blue';
  }
}

function SwarmAgentNode({ agent }: { agent: SwarmRunAgentView }) {
  return (
    <article
      className={`workflow-swarm-node is-${agent.status}`}
      data-swarm-agent-id={agent.agent_id}
      data-swarm-agent-kind={agent.kind}
      data-swarm-agent-status={agent.status}
      data-swarm-agent-thread-id={agent.thread_id ?? ''}
    >
      <header>
        <p className="workflow-card-kicker">{humanizeToken(agent.kind)}</p>
        <span className={`workflow-state-pill ${swarmAgentStatePillClass(agent.status)}`}>
          {humanizeToken(agent.status)}
        </span>
      </header>
      <h3>{agent.title}</h3>
      <p className="workflow-muted-copy">
        {agent.active_state_id ? humanizeToken(agent.active_state_id) : 'Idle'}
      </p>
      <p className="workflow-muted-copy">
        {agent.thread_id ? <code>{agent.thread_id}</code> : 'No session yet'}
      </p>
    </article>
  );
}

function TimelineCard({ entry }: { entry: SwarmTimelineEntry }) {
  const emphasisClass =
    entry.emphasis === 'gate'
      ? 'workflow-state-pill-amber'
      : entry.emphasis === 'transition'
        ? 'workflow-state-pill-green'
        : entry.emphasis === 'marker'
          ? 'workflow-state-pill-blue'
          : 'workflow-state-pill-slate';

  return (
    <article className="workflow-event-card workflow-timeline-card">
      <header>
        <strong>{entry.title}</strong>
        <span>{formatLongTimestamp(entry.timestamp)}</span>
      </header>
      <div className="workflow-session-pills">
        <span className={`workflow-state-pill ${emphasisClass}`}>{humanizeToken(entry.emphasis)}</span>
        {entry.agent_id ? (
          <span className="workflow-state-pill workflow-state-pill-slate">{humanizeToken(entry.agent_id)}</span>
        ) : null}
      </div>
      <p>{entry.summary}</p>
    </article>
  );
}

export function WorkflowRunPage({ runId, onNavigate }: WorkflowRunPageProps) {
  const [definitions, setDefinitions] = useState<WorkflowDefinitionSummary[]>([]);
  const [runs, setRuns] = useState<WorkflowRunRecord[]>([]);
  const [detail, setDetail] = useState<WorkflowRunDetail | null>(null);
  const [loadingDefinitions, setLoadingDefinitions] = useState(true);
  const [loadingRuns, setLoadingRuns] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [creatingRun, setCreatingRun] = useState(false);
  const [sendingPlanningMessage, setSendingPlanningMessage] = useState(false);
  const [answeringGate, setAnsweringGate] = useState(false);
  const [planningMessage, setPlanningMessage] = useState('');
  const [revisionMessage, setRevisionMessage] = useState('');
  const [workflowId, setWorkflowId] = useState('plan-implement-review');
  const [repoPath, setRepoPath] = useState('');
  const [goalPrompt, setGoalPrompt] = useState('');
  const [liveUpdates, setLiveUpdates] = useState<WorkflowRunLiveUpdates>({
    mode: 'idle',
    runId: null,
    eventCount: 0,
    lastEventAt: null,
    lastType: null,
  });

  const plannerSession = useMemo(() => findPlannerSession(detail), [detail]);
  const openApprovalGate = useMemo(() => findOpenApprovalGate(detail), [detail]);
  const swarmView = detail?.swarm ?? null;
  const workflowTitle = detail
    ? swarmView?.definition.title ?? getWorkflowTitle(definitions, detail.run.workflow_id)
    : workflowId;

  useEffect(() => {
    document.documentElement.dataset.theme = readThemeId();
  }, []);

  useEffect(() => {
    if (!workflowId && definitions[0]?.id) {
      setWorkflowId(definitions[0].id);
    }
  }, [definitions, workflowId]);

  useEffect(() => {
    void refreshDefinitions();
    void refreshRuns();
  }, []);

  useEffect(() => {
    if (!runId) {
      setDetail(null);
      return;
    }

    void refreshDetail(runId);
  }, [runId]);

  useEffect(() => {
    if (!runId && runs.length > 0) {
      onNavigate(`/workflow-runs/${encodeURIComponent(runs[0]!.id)}`, true);
    }
  }, [onNavigate, runId, runs]);

  useEffect(() => {
    if (!runId) {
      setLiveUpdates({
        mode: 'idle',
        runId: null,
        eventCount: 0,
        lastEventAt: null,
        lastType: null,
      });
      return;
    }

    const activeRunId = runId;

    let refreshTimer: number | null = null;
    let pollingTimer: number | null = null;
    let source: EventSource | null = null;
    let disposed = false;

    function scheduleRefresh() {
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }

      refreshTimer = window.setTimeout(() => {
        if (!disposed) {
          void refreshRuns();
          void refreshDetail(activeRunId);
        }
      }, 180);
    }

    function beginPolling() {
      setLiveUpdates((current) => ({
        mode: 'polling',
        runId: activeRunId,
        eventCount: current.runId === activeRunId ? current.eventCount : 0,
        lastEventAt: current.runId === activeRunId ? current.lastEventAt : null,
        lastType: current.runId === activeRunId ? current.lastType : null,
      }));

      if (pollingTimer !== null) return;
      pollingTimer = window.setInterval(() => {
        void refreshRuns();
        void refreshDetail(activeRunId);
      }, 2000);
    }

    setLiveUpdates({
      mode: 'events',
      runId: activeRunId,
      eventCount: 0,
      lastEventAt: null,
      lastType: null,
    });

    if (typeof EventSource !== 'undefined') {
      source = openWorkflowRunEvents(activeRunId);
      source.onopen = () => {
        if (!disposed) {
          setLiveUpdates((current) => ({ ...current, mode: 'events', runId: activeRunId }));
        }
      };
      source.onmessage = (event) => {
        if (disposed) return;
        const payload = parseWorkflowRunStreamEvent(event.data);
        if (payload?.method === 'workflow-run/connected') {
          return;
        }

        setLiveUpdates((current) => ({
          mode: 'events',
          runId: activeRunId,
          eventCount: current.runId === activeRunId ? current.eventCount + 1 : 1,
          lastEventAt: new Date().toISOString(),
          lastType:
            payload?.method === 'workflow-run/event' ? payload.params.event.type : current.lastType,
        }));
        scheduleRefresh();
      };
      source.onerror = () => {
        source?.close();
        source = null;
        if (!disposed) {
          beginPolling();
        }
      };
    } else {
      beginPolling();
    }

    return () => {
      disposed = true;
      source?.close();
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
      if (pollingTimer !== null) {
        window.clearInterval(pollingTimer);
      }
    };
  }, [runId]);

  async function refreshDefinitions() {
    setLoadingDefinitions(true);
    try {
      const nextDefinitions = await fetchWorkflowDefinitions();
      setDefinitions(nextDefinitions);
      setCreateError(null);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : 'Failed to load workflow definitions.');
    } finally {
      setLoadingDefinitions(false);
    }
  }

  async function refreshRuns() {
    setLoadingRuns(true);
    try {
      const nextRuns = await fetchWorkflowRuns();
      setRuns(nextRuns);
      setDetailError(null);
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : 'Failed to load workflow runs.');
    } finally {
      setLoadingRuns(false);
    }
  }

  async function refreshDetail(nextRunId: string) {
    setLoadingDetail(true);
    try {
      const nextDetail = await fetchWorkflowRunDetail(nextRunId);
      setDetail(nextDetail);
      setDetailError(null);
    } catch (error) {
      if (error instanceof RequestError && error.status === 404) {
        setDetail(null);
        onNavigate('/workflow-runs', true);
        await refreshRuns();
        return;
      }

      setDetailError(error instanceof Error ? error.message : 'Failed to load workflow run.');
    } finally {
      setLoadingDetail(false);
    }
  }

  async function handleCreateRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreatingRun(true);
    setCreateError(null);

    try {
      const created = await createWorkflowRun({
        workflow_id: workflowId,
        repo_path: repoPath,
        goal_prompt: goalPrompt,
      });
      await refreshRuns();
      setPlanningMessage('');
      setRevisionMessage('');
      startTransition(() => {
        onNavigate(`/workflow-runs/${encodeURIComponent(created.run.id)}`);
      });
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : 'Failed to create workflow run.');
    } finally {
      setCreatingRun(false);
    }
  }

  async function handlePlanningMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!detail || !planningMessage.trim()) return;

    setSendingPlanningMessage(true);
    setActionError(null);
    try {
      const nextDetail = await sendWorkflowPlanningMessage(detail.run.id, planningMessage.trim());
      setDetail(nextDetail);
      setPlanningMessage('');
      await refreshRuns();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to send planning message.');
    } finally {
      setSendingPlanningMessage(false);
    }
  }

  async function handleGateAction(optionId: string) {
    if (!detail || !openApprovalGate) return;

    setAnsweringGate(true);
    setActionError(null);
    try {
      const nextDetail = await answerWorkflowGate({
        runId: detail.run.id,
        gateId: openApprovalGate.id,
        optionId,
        message: optionId === 'revise' ? revisionMessage.trim() : undefined,
      });
      setDetail(nextDetail);
      if (optionId === 'revise') {
        setRevisionMessage('');
      }
      await refreshRuns();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to answer workflow gate.');
    } finally {
      setAnsweringGate(false);
    }
  }

  function renderPrimarySurface() {
    if (!detail) {
      return (
        <section
          className="workflow-panel workflow-panel-empty"
          data-workflow-primary-surface="empty"
        >
          <h2>Start a workflow run</h2>
          <p>Create a run from the form, or open one from the run list to inspect its live state.</p>
        </section>
      );
    }

    if (detail.run.current_state_family === 'conversation') {
      return (
        <section
          className="workflow-panel workflow-primary-panel"
          data-workflow-primary-surface="planning_conversation"
        >
          <header className="workflow-panel-header">
            <div>
              <p className="workflow-card-kicker">Planning Conversation</p>
              <h2>{workflowTitle}</h2>
            </div>
            <div className="workflow-session-pills">
              <span className="workflow-state-pill workflow-state-pill-blue">
                {plannerSession?.session.active_turn_id ? 'Planner thinking' : 'Planner ready'}
              </span>
              <span className="workflow-state-pill workflow-state-pill-slate">
                {liveUpdates.mode === 'events' ? 'Live updates' : liveUpdates.mode === 'polling' ? 'Polling' : 'Idle'}
              </span>
            </div>
          </header>

          <p className="workflow-muted-copy">
            Stay in planning until the planner emits the explicit first-prompt marker.
          </p>

          {plannerSession?.thread ? <CodexThreadViewer thread={plannerSession.thread} /> : null}

          <form
            className="workflow-composer"
            data-workflow-planning-form="true"
            onSubmit={handlePlanningMessage}
          >
            <label className="workflow-field">
              <span>Send planner feedback</span>
              <textarea
                data-workflow-planning-input="true"
                value={planningMessage}
                onChange={(event) => setPlanningMessage(event.target.value)}
                placeholder="Clarify scope, constraints, or ask for a tighter first step."
                rows={4}
              />
            </label>
            <div className="workflow-action-row">
              <button
                className="solid-button"
                data-workflow-planning-send="true"
                disabled={sendingPlanningMessage || !planningMessage.trim()}
                type="submit"
              >
                {sendingPlanningMessage ? 'Sending…' : 'Send planning message'}
              </button>
            </div>
          </form>
        </section>
      );
    }

    if (detail.run.current_state_family === 'approval' && openApprovalGate) {
      const promptCandidate = openApprovalGate.metadata.prompt_candidate ?? null;
      const approveOption = openApprovalGate.options.find((option) => option.id === 'approve') ?? null;
      const reviseOption = openApprovalGate.options.find((option) => option.id === 'revise') ?? null;
      return (
        <section
          className="workflow-panel workflow-primary-panel"
          data-workflow-primary-surface="approval_gate"
          data-workflow-gate-id={openApprovalGate.id}
        >
          <header className="workflow-panel-header">
            <div>
              <p className="workflow-card-kicker">Approval Gate</p>
              <h2>{openApprovalGate.title}</h2>
            </div>
            <span className="workflow-state-pill workflow-state-pill-amber">Waiting for user</span>
          </header>

          <p>{openApprovalGate.description ?? 'Review the proposed first prompt before launching the implementer.'}</p>

          <div className="workflow-approval-artifact" data-workflow-gate-artifact="true">
            <p className="workflow-card-kicker">Approved Artifact Candidate</p>
            <pre>
              <code>{promptCandidate ?? 'Prompt candidate unavailable.'}</code>
            </pre>
          </div>

          <label className="workflow-field">
            <span>Revision feedback</span>
            <textarea
              data-workflow-revision-input="true"
              value={revisionMessage}
              onChange={(event) => setRevisionMessage(event.target.value)}
              placeholder="Tell the planner what to tighten or change before implementation."
              rows={4}
            />
          </label>

          <div className="workflow-action-row">
            <button
              className="solid-button"
              data-workflow-gate-action="approve"
              disabled={answeringGate || !promptCandidate || !approveOption}
              onClick={() => void handleGateAction(approveOption?.id ?? 'approve')}
              type="button"
            >
              {answeringGate ? 'Working…' : approveOption?.label ?? 'Approve first prompt'}
            </button>
            <button
              className="ghost-button"
              data-workflow-gate-action="revise"
              disabled={answeringGate || !revisionMessage.trim() || !reviseOption}
              onClick={() => void handleGateAction(reviseOption?.id ?? 'revise')}
              type="button"
            >
              {reviseOption?.label ?? 'Return to planning'}
            </button>
          </div>
        </section>
      );
    }

    return (
      <section
        className="workflow-panel workflow-primary-panel"
        data-workflow-primary-surface="background"
      >
        <header className="workflow-panel-header">
          <div>
            <p className="workflow-card-kicker">Runtime State</p>
            <h2>{humanizeToken(detail.run.current_state_id)}</h2>
          </div>
          <span className="workflow-state-pill workflow-state-pill-green">
            {humanizeToken(detail.run.current_state_family)}
          </span>
        </header>
        <p className="workflow-muted-copy">
          Background execution is active. The session list below shows the planner and implementer state honestly.
        </p>
      </section>
    );
  }

  return (
    <div className="workflow-runtime-shell" data-workflow-runtime-route="true">
      <aside className="workflow-runtime-sidebar">
        <div className="workflow-runtime-sidebar-top">
          <a className="ghost-button workflow-back-link" href="/">
            ← Control Room
          </a>
          <div>
            <p className="workflow-card-kicker">Workflow Runtime</p>
            <h1>Runs</h1>
          </div>
        </div>

        <section className="workflow-panel workflow-create-panel">
          <header className="workflow-panel-header">
            <div>
              <p className="workflow-card-kicker">Start Run</p>
              <h2>New workflow run</h2>
            </div>
          </header>

          <form
            className="workflow-create-form"
            data-workflow-create-form="true"
            onSubmit={handleCreateRun}
          >
            <label className="workflow-field">
              <span>Workflow</span>
              <select
                data-workflow-field="workflow-id"
                value={workflowId}
                onChange={(event) => setWorkflowId(event.target.value)}
              >
                {definitions.map((definition) => (
                  <option key={definition.id} value={definition.id}>
                    {definition.title}
                  </option>
                ))}
              </select>
            </label>

            <label className="workflow-field">
              <span>Repo path</span>
              <input
                data-workflow-field="repo-path"
                value={repoPath}
                onChange={(event) => setRepoPath(event.target.value)}
                placeholder="/Users/you/code/inbox"
                type="text"
              />
            </label>

            <label className="workflow-field">
              <span>Goal prompt</span>
              <textarea
                data-workflow-field="goal-prompt"
                value={goalPrompt}
                onChange={(event) => setGoalPrompt(event.target.value)}
                placeholder="Describe the first workflow objective in one concrete paragraph."
                rows={5}
              />
            </label>

            <button
              className="solid-button"
              data-workflow-submit="create-run"
              disabled={creatingRun || !workflowId || !repoPath.trim() || !goalPrompt.trim() || loadingDefinitions}
              type="submit"
            >
              {creatingRun ? 'Starting…' : 'Create run'}
            </button>
          </form>

          {createError ? <p className="execution-note execution-error">{createError}</p> : null}
        </section>

        <section className="workflow-panel workflow-run-list-panel">
          <header className="workflow-panel-header">
            <div>
              <p className="workflow-card-kicker">Available Runs</p>
              <h2>Recent workflow runs</h2>
            </div>
          </header>

          {loadingRuns && runs.length === 0 ? <p>Loading runs…</p> : null}

          <div className="workflow-run-list">
            {runs.map((run) => {
              const title = getWorkflowTitle(definitions, run.workflow_id);
              const isSelected = run.id === runId;

              return (
                <button
                  key={run.id}
                  className={`workflow-run-list-item${isSelected ? ' is-selected' : ''}`}
                  data-workflow-run-list-item={run.id}
                  onClick={() => onNavigate(`/workflow-runs/${encodeURIComponent(run.id)}`)}
                  type="button"
                >
                  <div>
                    <strong>{title}</strong>
                    <span>{humanizeToken(run.current_state_id)}</span>
                  </div>
                  <div className="workflow-run-list-item-meta">
                    <span className="workflow-state-pill workflow-state-pill-slate">
                      {humanizeToken(run.current_state_family)}
                    </span>
                    <span>{formatTimestamp(run.updated_at)}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      </aside>

      <main className="workflow-runtime-main">
        {detailError ? (
          <div className="banner banner-error">
            <strong>Runtime request failed.</strong>
            <span>{detailError}</span>
          </div>
        ) : null}

        {actionError ? (
          <div className="banner banner-error">
            <strong>Workflow action failed.</strong>
            <span>{actionError}</span>
          </div>
        ) : null}

        {loadingDetail && !detail ? (
          <section className="workflow-panel workflow-panel-empty">
            <h2>Loading workflow run</h2>
            <p>Refreshing the selected run detail and attached sessions.</p>
          </section>
        ) : (
          renderPrimarySurface()
        )}

        {detail ? (
          <div className="workflow-runtime-grid" data-workflow-run-id={detail.run.id}>
            <section
              className="workflow-panel workflow-swarm-panel"
              data-workflow-swarm-overview="true"
              data-swarm-top-level-state={swarmView?.top_level_state ?? ''}
              data-workflow-current-state={detail.run.current_state_id}
              data-workflow-current-state-family={detail.run.current_state_family}
            >
              <header className="workflow-panel-header">
                <div>
                  <p className="workflow-card-kicker">Swarm Overview</p>
                  <h2>{swarmView?.definition.title ?? workflowTitle}</h2>
                </div>
                {swarmView ? (
                  <span className={`workflow-state-pill ${swarmStatePillClass(swarmView.top_level_state)}`}>
                    {humanizeToken(swarmView.top_level_state)}
                  </span>
                ) : null}
              </header>

              {swarmView ? (
                <>
                  <div className="workflow-session-pills">
                    <span className="workflow-state-pill workflow-state-pill-slate">
                      Active state: {humanizeToken(swarmView.active_state_id)}
                    </span>
                    <span className="workflow-state-pill workflow-state-pill-blue">
                      {humanizeToken(swarmView.active_state_family)}
                    </span>
                  </div>

                  <div className="workflow-swarm-graph">
                    {swarmView.agents[0] ? <SwarmAgentNode agent={swarmView.agents[0]} /> : null}
                    <div className="workflow-swarm-arrow">delegates</div>
                    {swarmView.current_gate ? (
                      <>
                        <article
                          className="workflow-swarm-gate"
                          data-swarm-current-gate={swarmView.current_gate.gate_id}
                          data-swarm-current-gate-rule={swarmView.current_gate.rule_id ?? ''}
                          data-swarm-unlocks-route-id={swarmView.current_gate.unlocks_route_id ?? ''}
                          data-swarm-unlocks-target-agent-id={
                            swarmView.current_gate.unlocks_target_agent_id ?? ''
                          }
                        >
                          <p className="workflow-card-kicker">Current Gate</p>
                          <h3>{swarmView.current_gate.title}</h3>
                          <p className="workflow-muted-copy">
                            {swarmView.current_gate.artifact?.title ?? 'Gate artifact'}
                          </p>
                          {swarmView.current_gate.unlocks_target_agent_title ? (
                            <p className="workflow-muted-copy">
                              Approve unlocks {swarmView.current_gate.unlocks_route_title ?? 'the next route'} to{' '}
                              {swarmView.current_gate.unlocks_target_agent_title}.
                            </p>
                          ) : null}
                        </article>
                        <div className="workflow-swarm-arrow">
                          {swarmView.current_gate.unlocks_route_title
                            ? `approve via ${swarmView.current_gate.unlocks_route_title}`
                            : 'approve'}
                        </div>
                      </>
                    ) : null}
                    {swarmView.agents[1] ? <SwarmAgentNode agent={swarmView.agents[1]} /> : null}
                  </div>
                </>
              ) : (
                <p className="workflow-muted-copy">No swarm mapping is available for this workflow run yet.</p>
              )}
            </section>

            <section className="workflow-panel">
              <header className="workflow-panel-header">
                <div>
                  <p className="workflow-card-kicker">Run Detail</p>
                  <h2>{workflowTitle}</h2>
                </div>
                <div className="workflow-session-pills">
                  {swarmView ? (
                    <span className={`workflow-state-pill ${swarmStatePillClass(swarmView.top_level_state)}`}>
                      {humanizeToken(swarmView.top_level_state)}
                    </span>
                  ) : null}
                  <span className="workflow-state-pill workflow-state-pill-slate">
                    {humanizeToken(detail.run.status)}
                  </span>
                  <span className="workflow-state-pill workflow-state-pill-blue">
                    {humanizeToken(detail.run.current_state_family)}
                  </span>
                </div>
              </header>

              <dl className="workflow-meta-grid">
                <div>
                  <dt>Run</dt>
                  <dd>
                    <code>{detail.run.id}</code>
                  </dd>
                </div>
                <div>
                  <dt>State</dt>
                  <dd>{humanizeToken(detail.run.current_state_id)}</dd>
                </div>
                <div>
                  <dt>Repo</dt>
                  <dd>
                    <code>{detail.run.repo.repo_path ?? detail.run.repo.repo_id ?? 'unknown'}</code>
                  </dd>
                </div>
                <div>
                  <dt>Live updates</dt>
                  <dd>
                    <span
                      data-workflow-live-update-mode={liveUpdates.mode}
                      data-workflow-live-update-count={String(liveUpdates.eventCount)}
                      data-workflow-live-update-last-type={liveUpdates.lastType ?? ''}
                    >
                      {liveUpdates.mode === 'events'
                        ? `SSE${liveUpdates.eventCount > 0 ? ` (${liveUpdates.eventCount})` : ''}`
                        : liveUpdates.mode === 'polling'
                          ? 'Polling'
                          : 'Idle'}
                    </span>
                  </dd>
                </div>
              </dl>

              <div className="workflow-goal-card">
                <p className="workflow-card-kicker">Goal Prompt</p>
                <pre>
                  <code>{detail.run.goal_prompt}</code>
                </pre>
              </div>
            </section>

            <section className="workflow-panel" data-workflow-gate-panel="true">
              <header className="workflow-panel-header">
                <div>
                  <p className="workflow-card-kicker">Gate Artifact</p>
                  <h2>Current user gate</h2>
                </div>
              </header>
              {swarmView?.current_gate ? (
                <div className="workflow-gate-list">
                  <article
                    className="workflow-gate-summary"
                    data-workflow-current-gate={swarmView.current_gate.gate_id}
                  >
                    <header>
                      <p className="workflow-card-kicker">{humanizeToken(swarmView.current_gate.status)}</p>
                      <h4>{swarmView.current_gate.title}</h4>
                    </header>
                    {swarmView.current_gate.unlocks_target_agent_title ? (
                      <p className="workflow-muted-copy">
                        Unlocks {swarmView.current_gate.unlocks_route_title ?? 'the next route'} to{' '}
                        {swarmView.current_gate.unlocks_target_agent_title}.
                      </p>
                    ) : null}
                    {swarmView.current_gate.artifact ? (
                      <div className="workflow-approval-artifact" data-workflow-gate-artifact="true">
                        <p className="workflow-card-kicker">{swarmView.current_gate.artifact.title}</p>
                        <pre>
                          <code>{swarmView.current_gate.artifact.content ?? 'Artifact content unavailable.'}</code>
                        </pre>
                      </div>
                    ) : (
                      <p className="workflow-muted-copy">This gate is waiting on explicit user input.</p>
                    )}
                  </article>
                </div>
              ) : detail.open_gates.length === 0 ? (
                <p className="workflow-muted-copy">No open gates in the current state.</p>
              ) : (
                <div className="workflow-gate-list">
                  {detail.open_gates.map((gate) => (
                    <GateSummary key={gate.id} gate={gate} />
                  ))}
                </div>
              )}
            </section>

            <section className="workflow-panel workflow-events-panel" data-workflow-timeline="true">
              <header className="workflow-panel-header">
                <div>
                  <p className="workflow-card-kicker">Timeline</p>
                  <h2>What the swarm did</h2>
                </div>
              </header>
              {swarmView ? (
                <div className="workflow-event-list workflow-timeline-list">
                  {swarmView.timeline.map((entry) => (
                    <div
                      key={entry.id}
                      data-workflow-timeline-entry={entry.title}
                      data-workflow-timeline-emphasis={entry.emphasis}
                    >
                      <TimelineCard entry={entry} />
                    </div>
                  ))}
                </div>
              ) : (
                <p className="workflow-muted-copy">Timeline data will appear here when the run has a swarm view.</p>
              )}
            </section>

            <section className="workflow-panel workflow-sessions-panel" data-workflow-sessions-panel="true">
              <header className="workflow-panel-header">
                <div>
                  <p className="workflow-card-kicker">Sessions</p>
                  <h2>Attached Codex sessions</h2>
                </div>
              </header>
              <div className="workflow-session-list">
                {detail.sessions.map((sessionDetail) => (
                  <SessionCard key={sessionDetail.session.id} sessionDetail={sessionDetail} />
                ))}
              </div>
            </section>
          </div>
        ) : null}
      </main>
    </div>
  );
}
