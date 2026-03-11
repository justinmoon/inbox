import { startTransition, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import type { WorkflowRunDetail, WorkflowRunSessionDetail } from '../../shared/api.ts';
import type {
  GateRecord,
  RunEventRecord,
  SwarmRunAgentView,
  SwarmTimelineEntry,
  WorkflowArtifactRecord,
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
  retryWorkflowPlanning,
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

function findReadyArtifact(
  detail: WorkflowRunDetail | null,
  kind: 'tutorial_artifact' | 'next_prompt_artifact',
) {
  if (!detail) {
    return null;
  }

  return (
    detail.artifacts
      .filter((artifact) => artifact.kind === kind && artifact.status === 'ready')
      .sort((a, b) => {
        const aTimestamp = a.completed_at ?? a.updated_at ?? a.created_at;
        const bTimestamp = b.completed_at ?? b.updated_at ?? b.created_at;
        const timestampOrder = bTimestamp.localeCompare(aTimestamp);
        if (timestampOrder !== 0) {
          return timestampOrder;
        }

        return b.id.localeCompare(a.id);
      })
      .at(0) ?? null
  );
}

function findActiveSession(detail: WorkflowRunDetail | null) {
  return detail?.sessions.find((entry) => entry.session.active_turn_id) ?? null;
}

function findStalledSession(detail: WorkflowRunDetail | null) {
  return detail?.sessions.find((entry) => entry.session.activity_status === 'stalled') ?? null;
}

function findLastSuccessfulRuntimeEvent(detail: WorkflowRunDetail | null) {
  return (
    detail?.events.findLast(
      (event) =>
        !event.type.endsWith('_timed_out') &&
        !event.type.endsWith('_failed') &&
        event.type !== 'planner_runtime_failed',
    ) ?? null
  );
}

function currentWorkspacePath(detail: WorkflowRunDetail | null) {
  const activeSession = findActiveSession(detail);
  if (activeSession?.session.cwd) {
    return activeSession.session.cwd;
  }

  if (!detail) {
    return null;
  }

  for (let index = detail.sessions.length - 1; index >= 0; index -= 1) {
    const session = detail.sessions[index];
    if (session?.session.cwd) {
      return session.session.cwd;
    }
  }

  return null;
}

function currentActiveAgentLabel(
  detail: WorkflowRunDetail | null,
  swarmView: WorkflowRunDetail['swarm'],
  openGate: GateRecord | null,
) {
  if (openGate) {
    return 'User';
  }

  const activeSession = findActiveSession(detail);
  if (activeSession) {
    const matchedAgent =
      swarmView?.agents.find(
        (agent) =>
          agent.session_id === activeSession.session.id || agent.thread_id === activeSession.session.thread_id,
      ) ?? null;
    if (matchedAgent) {
      return matchedAgent.title;
    }

    return humanizeToken(activeSession.session.actor);
  }

  const swarmAgent =
    swarmView?.agents.find((agent) => agent.status === 'working' || agent.status === 'stalled') ?? null;
  if (swarmAgent) {
    return swarmAgent.title;
  }

  return 'Idle';
}

function currentProgressState(detail: WorkflowRunDetail | null, openGate: GateRecord | null) {
  if (!detail) {
    return 'idle';
  }

  if (detail.run.status === 'failed') {
    return 'failed';
  }
  if (detail.run.status === 'completed') {
    return 'completed';
  }
  if (openGate) {
    return 'waiting_on_user';
  }
  if (findStalledSession(detail)) {
    return 'stalled';
  }
  if (findActiveSession(detail)) {
    return 'making_progress';
  }
  return 'idle';
}

function latestEventSequence(detail: WorkflowRunDetail | null) {
  return detail?.events.at(-1)?.sequence ?? 0;
}

function parseTimestamp(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function describeRelativeTime(value: string | null | undefined, nowMs: number) {
  const parsed = parseTimestamp(value);
  if (parsed == null) {
    return 'Unavailable';
  }

  const deltaMs = Math.max(0, nowMs - parsed);
  const seconds = Math.round(deltaMs / 1000);
  if (seconds < 5) {
    return 'Just now';
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

function deriveDisplayedProgressState(args: {
  detail: WorkflowRunDetail | null;
  swarmView: WorkflowRunDetail['swarm'];
  openGate: GateRecord | null;
  nowMs: number;
}) {
  const activity = args.swarmView?.activity ?? null;
  if (!activity) {
    return currentProgressState(args.detail, args.openGate);
  }

  if (activity.progress_state === 'making_progress' || activity.progress_state === 'quiet_but_active') {
    const freshnessAnchor = Math.max(
      parseTimestamp(activity.last_meaningful_event_at) ?? Number.NEGATIVE_INFINITY,
      parseTimestamp(activity.active_turn_started_at) ?? Number.NEGATIVE_INFINITY,
    );
    if (Number.isFinite(freshnessAnchor)) {
      return args.nowMs - freshnessAnchor <= 20_000 ? 'making_progress' : 'quiet_but_active';
    }
  }

  if (activity.progress_state === 'recently_updated') {
    const lastMeaningfulAt = parseTimestamp(activity.last_meaningful_event_at);
    if (lastMeaningfulAt != null && args.nowMs - lastMeaningfulAt > 45_000) {
      return 'idle';
    }
  }

  return activity.progress_state;
}

function progressStatePillClass(value: string) {
  switch (value) {
    case 'waiting_on_user':
    case 'stalled':
      return 'workflow-state-pill-amber';
    case 'failed':
      return 'workflow-state-pill-red';
    case 'completed':
    case 'recently_updated':
      return 'workflow-state-pill-green';
    case 'idle':
      return 'workflow-state-pill-slate';
    default:
      return 'workflow-state-pill-blue';
  }
}

function progressStateDescription(value: string) {
  const descriptions: Record<string, string> = {
    making_progress: 'Active work is moving and recent runtime events confirm it.',
    quiet_but_active: 'The current turn is still running, but the runtime has been quiet for a bit.',
    recently_updated: 'Background work just advanced and is between active turns.',
    stalled: 'The current turn timed out or stopped making progress and needs attention.',
    waiting_on_user: 'The run is paused on an explicit user gate.',
    idle: 'No active turn is running right now.',
    failed: 'The run failed and needs manual recovery.',
    completed: 'The run has completed its current workflow.',
  };

  return descriptions[value] ?? 'Runtime progress is being tracked from persisted workflow state.';
}

function SessionCard({ sessionDetail }: { sessionDetail: WorkflowRunSessionDetail }) {
  const { session, thread, load_error } = sessionDetail;
  const activityPillClass =
    session.activity_status === 'stalled'
      ? 'workflow-state-pill-amber'
      : session.activity_status === 'running'
        ? 'workflow-state-pill-blue'
        : 'workflow-state-pill-slate';

  return (
    <article
      className="workflow-session-card"
      data-workflow-session-kind={session.kind}
      data-workflow-session-actor={session.actor}
      data-workflow-session-status={session.status}
      data-workflow-session-activity-status={session.activity_status}
      data-workflow-session-thread-id={session.thread_id}
    >
      <header className="workflow-session-card-header">
        <div>
          <p className="workflow-card-kicker">{humanizeToken(session.kind)}</p>
          <h4>{humanizeToken(session.actor)}</h4>
        </div>
        <div className="workflow-session-pills">
          <span className="workflow-state-pill workflow-state-pill-slate">{session.status}</span>
          <span className={`workflow-state-pill ${activityPillClass}`}>
            {humanizeToken(session.activity_status)}
          </span>
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
    case 'stalled':
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

function ArtifactCard({ artifact }: { artifact: WorkflowArtifactRecord }) {
  return (
    <article
      className="workflow-event-card workflow-artifact-card"
      data-workflow-artifact-kind={artifact.kind}
      data-workflow-artifact-status={artifact.status}
      data-workflow-artifact-id={artifact.id}
    >
      <header>
        <div>
          <p className="workflow-card-kicker">{humanizeToken(artifact.status)}</p>
          <h4>{humanizeToken(artifact.kind)}</h4>
        </div>
        <span className="workflow-state-pill workflow-state-pill-slate">{artifact.state_id ?? 'unknown'}</span>
      </header>
      <p className="workflow-muted-copy">
        Session <code>{artifact.session_id ?? 'n/a'}</code> • Thread <code>{artifact.thread_id ?? 'n/a'}</code>
      </p>
      <pre>
        <code>{artifact.content ?? 'Artifact content is not ready yet.'}</code>
      </pre>
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
  const [retryingPlanning, setRetryingPlanning] = useState(false);
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
  const [liveEvent, setLiveEvent] = useState<RunEventRecord | null>(null);
  const [clockMs, setClockMs] = useState(() => Date.now());
  const activeRunIdRef = useRef<string | null>(runId);
  const detailRequestIdRef = useRef(0);
  const runsRequestIdRef = useRef(0);
  const latestExpectedEventSequenceRef = useRef(0);
  const latestAppliedDetailSequenceRef = useRef(0);

  const plannerSession = useMemo(() => findPlannerSession(detail), [detail]);
  const openApprovalGate = useMemo(() => findOpenApprovalGate(detail), [detail]);
  const tutorialArtifact = useMemo(() => findReadyArtifact(detail, 'tutorial_artifact'), [detail]);
  const nextPromptArtifact = useMemo(() => findReadyArtifact(detail, 'next_prompt_artifact'), [detail]);
  const swarmView = detail?.swarm ?? null;
  const activityView = swarmView?.activity ?? null;
  const activeAgentLabel = useMemo(
    () => activityView?.active_agent_title ?? currentActiveAgentLabel(detail, swarmView, openApprovalGate),
    [activityView, detail, swarmView, openApprovalGate],
  );
  const activeWorkspacePath = useMemo(
    () => activityView?.authoritative_workspace_path ?? currentWorkspacePath(detail),
    [activityView, detail],
  );
  const lastEvent = useMemo(() => {
    const detailEvent = detail?.events.at(-1) ?? null;
    if (!liveEvent) {
      return detailEvent;
    }
    if (!detailEvent || liveEvent.sequence >= detailEvent.sequence) {
      return liveEvent;
    }
    return detailEvent;
  }, [detail, liveEvent]);
  const lastSuccessfulRuntimeEvent = useMemo(() => findLastSuccessfulRuntimeEvent(detail), [detail]);
  const lastMeaningfulEvent = activityView?.last_meaningful_event ?? null;
  const progressState = useMemo(
    () => deriveDisplayedProgressState({ detail, swarmView, openGate: openApprovalGate, nowMs: clockMs }),
    [clockMs, detail, openApprovalGate, swarmView],
  );
  const workflowTitle = detail
    ? swarmView?.definition.title ?? getWorkflowTitle(definitions, detail.run.workflow_id)
    : workflowId;
  const progressPillClass = progressStatePillClass(progressState);
  const progressDescription = progressStateDescription(progressState);

  useEffect(() => {
    document.documentElement.dataset.theme = readThemeId();
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setClockMs(Date.now());
    }, 5_000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    activeRunIdRef.current = runId;
    latestExpectedEventSequenceRef.current = 0;
    latestAppliedDetailSequenceRef.current = 0;
    setLiveEvent(null);
  }, [runId]);

  useEffect(() => {
    const appliedSequence = detail && detail.run.id === runId ? latestEventSequence(detail) : 0;
    latestAppliedDetailSequenceRef.current = appliedSequence;
    latestExpectedEventSequenceRef.current = Math.max(latestExpectedEventSequenceRef.current, appliedSequence);
    if (liveEvent && appliedSequence >= liveEvent.sequence) {
      setLiveEvent(null);
    }
  }, [detail, liveEvent, runId]);

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
    const immediateRefreshEventTypes = new Set([
      'state_transition',
      'gate_opened',
      'gate_answered',
      'tutorial_artifact_persisted',
      'next_prompt_artifact_persisted',
      'review_result_detected',
    ]);

    let refreshTimer: number | null = null;
    let pollingTimer: number | null = null;
    let source: EventSource | null = null;
    let disposed = false;

    function scheduleRefresh(delayMs = 180) {
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }

      refreshTimer = window.setTimeout(() => {
        if (!disposed) {
          void refreshRuns();
          void refreshDetail(activeRunId);
        }
      }, delayMs);
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

        if (payload?.method === 'workflow-run/event') {
          latestExpectedEventSequenceRef.current = Math.max(
            latestExpectedEventSequenceRef.current,
            payload.params.event.sequence,
          );
          setLiveEvent(payload.params.event);
        }

        setLiveUpdates((current) => ({
          mode: 'events',
          runId: activeRunId,
          eventCount: current.runId === activeRunId ? current.eventCount + 1 : 1,
          lastEventAt:
            payload?.method === 'workflow-run/event' ? payload.params.event.created_at : current.lastEventAt,
          lastType:
            payload?.method === 'workflow-run/event' ? payload.params.event.type : current.lastType,
        }));
        scheduleRefresh(
          payload?.method === 'workflow-run/event' &&
            immediateRefreshEventTypes.has(payload.params.event.type)
            ? 40
            : 180,
        );
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
    const requestId = ++runsRequestIdRef.current;
    setLoadingRuns(true);
    try {
      const nextRuns = await fetchWorkflowRuns();
      if (requestId !== runsRequestIdRef.current) {
        return;
      }
      setRuns(nextRuns);
      setDetailError(null);
    } catch (error) {
      if (requestId !== runsRequestIdRef.current) {
        return;
      }
      setDetailError(error instanceof Error ? error.message : 'Failed to load workflow runs.');
    } finally {
      if (requestId === runsRequestIdRef.current) {
        setLoadingRuns(false);
      }
    }
  }

  async function refreshDetail(nextRunId: string) {
    const requestId = ++detailRequestIdRef.current;
    setLoadingDetail(true);
    try {
      const nextDetail = await fetchWorkflowRunDetail(nextRunId);
      if (nextRunId !== activeRunIdRef.current) {
        return;
      }

      const nextSequence = latestEventSequence(nextDetail);
      if (nextSequence < latestExpectedEventSequenceRef.current) {
        window.setTimeout(() => {
          if (activeRunIdRef.current === nextRunId) {
            void refreshDetail(nextRunId);
          }
        }, 120);
        return;
      }

      if (
        requestId !== detailRequestIdRef.current &&
        nextSequence <= latestAppliedDetailSequenceRef.current
      ) {
        return;
      }

      if (nextSequence < latestAppliedDetailSequenceRef.current) {
        return;
      }

      latestAppliedDetailSequenceRef.current = nextSequence;
      latestExpectedEventSequenceRef.current = Math.max(latestExpectedEventSequenceRef.current, nextSequence);
      setDetail((current) => {
        const currentSequence =
          current && current.run.id === nextDetail.run.id ? latestEventSequence(current) : -1;
        if (currentSequence > nextSequence) {
          return current;
        }

        return nextDetail;
      });
      setDetailError(null);
    } catch (error) {
      if (nextRunId !== activeRunIdRef.current || requestId !== detailRequestIdRef.current) {
        return;
      }
      if (error instanceof RequestError && error.status === 404) {
        setDetail(null);
        onNavigate('/workflow-runs', true);
        await refreshRuns();
        return;
      }

      setDetailError(error instanceof Error ? error.message : 'Failed to load workflow run.');
    } finally {
      if (requestId === detailRequestIdRef.current) {
        setLoadingDetail(false);
      }
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

  async function handlePlanningRetry() {
    if (!detail) return;

    setRetryingPlanning(true);
    setActionError(null);
    try {
      const nextDetail = await retryWorkflowPlanning(detail.run.id);
      setDetail(nextDetail);
      await refreshRuns();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to retry the planning turn.');
    } finally {
      setRetryingPlanning(false);
    }
  }

  async function handleGateAction(optionId: string) {
    if (!detail || !openApprovalGate) return;

    setAnsweringGate(true);
    setActionError(null);
    const requiresMessage = optionId === 'revise' || optionId === 'redirect';
    try {
      const nextDetail = await answerWorkflowGate({
        runId: detail.run.id,
        gateId: openApprovalGate.id,
        optionId,
        message: requiresMessage ? revisionMessage.trim() : undefined,
      });
      setDetail(nextDetail);
      if (requiresMessage) {
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
      const plannerIsStalled = plannerSession?.session.activity_status === 'stalled';
      const plannerStatusLabel = plannerIsStalled
        ? 'Planner stalled'
        : plannerSession?.session.active_turn_id
          ? 'Planner thinking'
          : 'Planner ready';
      const plannerStatusPillClass = plannerIsStalled
        ? 'workflow-state-pill-amber'
        : plannerSession?.session.active_turn_id
          ? 'workflow-state-pill-blue'
          : 'workflow-state-pill-slate';
      return (
        <section
          className="workflow-panel workflow-primary-panel"
          data-workflow-primary-surface="planning_conversation"
          data-workflow-planner-status={plannerSession?.session.activity_status ?? 'idle'}
          data-workflow-panel-priority="primary"
        >
          <header className="workflow-panel-header">
            <div>
              <p className="workflow-card-kicker">Planning Conversation</p>
              <h2>{workflowTitle}</h2>
            </div>
            <div className="workflow-session-pills">
              <span className={`workflow-state-pill ${plannerStatusPillClass}`}>
                {plannerStatusLabel}
              </span>
              <span className="workflow-state-pill workflow-state-pill-slate">
                {liveUpdates.mode === 'events' ? 'Live updates' : liveUpdates.mode === 'polling' ? 'Polling' : 'Idle'}
              </span>
            </div>
          </header>

          <p className="workflow-muted-copy">
            Stay in planning until the planner emits the explicit first-prompt marker.
          </p>

          {plannerIsStalled ? (
            <article className="workflow-goal-card" data-workflow-planning-stalled="true">
              <p className="workflow-card-kicker">Planner Timed Out</p>
              <p>
                The latest planning turn timed out. The run is still recoverable and stays in the same planning conversation.
              </p>
              <dl className="workflow-meta-grid">
                <div>
                  <dt>Current agent</dt>
                  <dd>{activeAgentLabel}</dd>
                </div>
                <div>
                  <dt>Workspace</dt>
                  <dd data-workflow-planning-workspace={activeWorkspacePath ?? ''}>
                    <code>{activeWorkspacePath ?? 'unavailable'}</code>
                  </dd>
                </div>
                <div>
                  <dt>Last milestone</dt>
                  <dd data-workflow-planning-last-milestone={lastSuccessfulRuntimeEvent?.type ?? ''}>
                    {lastSuccessfulRuntimeEvent?.summary ?? 'No successful planner milestone yet.'}
                  </dd>
                </div>
                <div>
                  <dt>Last error</dt>
                  <dd>{plannerSession?.session.last_error ?? 'Timeout while waiting for the planner turn.'}</dd>
                </div>
              </dl>
              <div className="workflow-action-row">
                <button
                  className="solid-button"
                  data-workflow-planning-retry="true"
                  disabled={retryingPlanning || sendingPlanningMessage}
                  onClick={() => void handlePlanningRetry()}
                  type="button"
                >
                  {retryingPlanning ? 'Retrying…' : 'Retry planner turn'}
                </button>
              </div>
            </article>
          ) : null}

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
                disabled={sendingPlanningMessage || retryingPlanning || !planningMessage.trim()}
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
      if (detail.run.current_state_id === 'step_approval') {
        const approveNextOption = openApprovalGate.options.find((option) => option.id === 'approve_next') ?? null;
        const redirectOption = openApprovalGate.options.find((option) => option.id === 'redirect') ?? null;
        const finishOption = openApprovalGate.options.find((option) => option.id === 'finish') ?? null;
        const abortOption = openApprovalGate.options.find((option) => option.id === 'abort') ?? null;
        const approvedPromptCandidate = openApprovalGate.metadata.approved_prompt_candidate ?? null;
        const tutorialContent =
          tutorialArtifact?.content ?? openApprovalGate.metadata.tutorial_artifact_content ?? null;
        const nextPromptContent =
          nextPromptArtifact?.content ??
          openApprovalGate.metadata.next_prompt_artifact_content ??
          openApprovalGate.metadata.prompt_candidate ??
          null;

        return (
          <section
            className="workflow-panel workflow-primary-panel workflow-primary-panel-gate"
            data-workflow-primary-surface="step_approval"
            data-workflow-gate-id={openApprovalGate.id}
            data-workflow-panel-priority="dominant"
          >
            <header className="workflow-panel-header">
              <div>
                <p className="workflow-card-kicker">Step Approval</p>
                <h2>{openApprovalGate.title}</h2>
              </div>
              <span className="workflow-state-pill workflow-state-pill-amber">Waiting for user</span>
            </header>

            <p>{openApprovalGate.description ?? 'Review the accepted step packet before continuing the loop.'}</p>

            <div className="workflow-step-packet-grid">
              <div className="workflow-approval-artifact" data-workflow-step-approved-prompt="true">
                <p className="workflow-card-kicker">Accepted Step</p>
                <pre>
                  <code>{approvedPromptCandidate ?? 'Approved prompt candidate unavailable.'}</code>
                </pre>
              </div>

              <div className="workflow-approval-artifact" data-workflow-step-tutorial="true">
                <p className="workflow-card-kicker">Tutorial</p>
                <pre>
                  <code>{tutorialContent ?? 'Tutorial artifact unavailable.'}</code>
                </pre>
              </div>

              <div className="workflow-approval-artifact" data-workflow-step-next-prompt="true">
                <p className="workflow-card-kicker">Next Prompt</p>
                <pre>
                  <code>{nextPromptContent ?? 'Next prompt artifact unavailable.'}</code>
                </pre>
              </div>
            </div>

            <p className="workflow-muted-copy">
              Full planner, implementer, and worker transcripts remain available in the session list below.
            </p>

            {redirectOption ? (
              <label className="workflow-field">
                <span>Redirect feedback</span>
                <textarea
                  data-workflow-redirect-input="true"
                  value={revisionMessage}
                  onChange={(event) => setRevisionMessage(event.target.value)}
                  placeholder="Tell the planner what to change before the next step."
                  rows={4}
                />
              </label>
            ) : null}

            <div className="workflow-action-row">
              <button
                className="solid-button"
                data-workflow-gate-action="approve_next"
                disabled={answeringGate || !nextPromptContent || !approveNextOption}
                onClick={() => void handleGateAction(approveNextOption?.id ?? 'approve_next')}
                type="button"
              >
                {answeringGate ? 'Working…' : approveNextOption?.label ?? 'Approve next prompt'}
              </button>
              <button
                className="ghost-button"
                data-workflow-gate-action="redirect"
                disabled={answeringGate || !revisionMessage.trim() || !redirectOption}
                onClick={() => void handleGateAction(redirectOption?.id ?? 'redirect')}
                type="button"
              >
                {redirectOption?.label ?? 'Redirect plan'}
              </button>
              <button
                className="ghost-button"
                data-workflow-gate-action="finish"
                disabled={answeringGate || !finishOption}
                onClick={() => void handleGateAction(finishOption?.id ?? 'finish')}
                type="button"
              >
                {finishOption?.label ?? 'Finish workflow'}
              </button>
              <button
                className="ghost-button"
                data-workflow-gate-action="abort"
                disabled={answeringGate || !abortOption}
                onClick={() => void handleGateAction(abortOption?.id ?? 'abort')}
                type="button"
              >
                {abortOption?.label ?? 'Abort run'}
              </button>
            </div>
          </section>
        );
      }

      const promptCandidate = openApprovalGate.metadata.prompt_candidate ?? null;
      const approveOption = openApprovalGate.options.find((option) => option.id === 'approve') ?? null;
      const reviseOption = openApprovalGate.options.find((option) => option.id === 'revise') ?? null;
      const abortOption = openApprovalGate.options.find((option) => option.id === 'abort') ?? null;
      return (
        <section
          className="workflow-panel workflow-primary-panel workflow-primary-panel-gate"
          data-workflow-primary-surface="approval_gate"
          data-workflow-gate-id={openApprovalGate.id}
          data-workflow-panel-priority="dominant"
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
            <button
              className="ghost-button"
              data-workflow-gate-action="abort"
              disabled={answeringGate || !abortOption}
              onClick={() => void handleGateAction(abortOption?.id ?? 'abort')}
              type="button"
            >
              {abortOption?.label ?? 'Abort run'}
            </button>
          </div>
        </section>
      );
    }

    return (
      <section
        className="workflow-panel workflow-primary-panel workflow-primary-panel-background"
        data-workflow-primary-surface="background"
        data-workflow-panel-priority="primary"
        data-workflow-subphase={activityView?.subphase_id ?? detail.run.current_state_id}
        data-workflow-progress-freshness={progressState}
      >
        <header className="workflow-panel-header">
          <div>
            <p className="workflow-card-kicker">Runtime State</p>
            <h2>{activityView?.subphase_title ?? humanizeToken(detail.run.current_state_id)}</h2>
          </div>
          <span className={`workflow-state-pill ${progressPillClass}`}>
            {humanizeToken(progressState)}
          </span>
        </header>
        <p className="workflow-muted-copy">{progressDescription}</p>

        <div className="workflow-background-status-grid">
          <article className="workflow-goal-card">
            <p className="workflow-card-kicker">Active Agent</p>
            <strong>{activeAgentLabel}</strong>
            <p className="workflow-muted-copy">
              {activityView?.active_thread_id ? <code>{activityView.active_thread_id}</code> : 'No active thread id yet.'}
            </p>
          </article>

          <article className="workflow-goal-card">
            <p className="workflow-card-kicker">Workspace</p>
            <code>{activeWorkspacePath ?? 'unavailable'}</code>
            <p className="workflow-muted-copy">
              Authoritative surfaced workspace for the current background step.
            </p>
          </article>

          <article className="workflow-goal-card">
            <p className="workflow-card-kicker">Last Meaningful Progress</p>
            <strong>{lastMeaningfulEvent?.title ?? 'No milestone yet'}</strong>
            <p className="workflow-muted-copy">
              {lastMeaningfulEvent
                ? `${lastMeaningfulEvent.summary} • ${describeRelativeTime(lastMeaningfulEvent.timestamp, clockMs)}`
                : 'The runtime has not recorded a meaningful progress milestone yet.'}
            </p>
          </article>
        </div>
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

      <main
        className="workflow-runtime-main"
        data-workflow-user-input={openApprovalGate ? 'true' : 'false'}
      >
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
          <div
            className={`workflow-runtime-grid${openApprovalGate ? ' is-gate-open' : ''}`}
            data-workflow-run-id={detail.run.id}
          >
            <section
              className="workflow-panel workflow-swarm-panel workflow-panel-secondary"
              data-workflow-swarm-overview="true"
              data-swarm-top-level-state={swarmView?.top_level_state ?? ''}
              data-workflow-current-state={detail.run.current_state_id}
              data-workflow-current-state-family={detail.run.current_state_family}
              data-workflow-panel-priority={openApprovalGate ? 'secondary' : 'normal'}
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

                  <div className="workflow-swarm-node-grid">
                    {swarmView.agents.map((agent) => (
                      <SwarmAgentNode key={agent.agent_id} agent={agent} />
                    ))}
                  </div>

                  {swarmView.current_gate ? (
                    <article
                      className="workflow-swarm-gate"
                      data-swarm-current-gate={swarmView.current_gate.gate_id}
                      data-swarm-current-gate-rule={swarmView.current_gate.rule_id ?? ''}
                      data-swarm-unlocks-route-id={swarmView.current_gate.unlocks_route_id ?? ''}
                      data-swarm-unlocks-target-agent-id={swarmView.current_gate.unlocks_target_agent_id ?? ''}
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
                  ) : null}

                  <pre className="workflow-mermaid-block" data-workflow-swarm-mermaid="true">
                    <code>{swarmView.graph_mermaid}</code>
                  </pre>
                </>
              ) : (
                <p className="workflow-muted-copy">No swarm mapping is available for this workflow run yet.</p>
              )}
            </section>

            <section
              className="workflow-panel"
              data-workflow-panel-priority={openApprovalGate ? 'secondary' : 'normal'}
            >
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
                      data-workflow-live-update-last-at={liveUpdates.lastEventAt ?? ''}
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

              <div className="workflow-goal-card" data-workflow-activity-card="true">
                <p className="workflow-card-kicker">Current Work</p>
                <dl className="workflow-meta-grid">
                  <div>
                    <dt>Active agent</dt>
                    <dd
                      data-workflow-active-agent={activeAgentLabel}
                      data-workflow-active-agent-kind={openApprovalGate ? 'user' : 'runtime'}
                    >
                      {activeAgentLabel}
                    </dd>
                  </div>
                  <div>
                    <dt>Authoritative workspace</dt>
                    <dd data-workflow-active-workspace={activeWorkspacePath ?? ''}>
                      <code>{activeWorkspacePath ?? 'unavailable'}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Subphase</dt>
                    <dd
                      data-workflow-subphase={activityView?.subphase_id ?? detail.run.current_state_id}
                    >
                      {activityView?.subphase_title ?? humanizeToken(detail.run.current_state_id)}
                    </dd>
                  </div>
                  <div>
                    <dt>Progress</dt>
                    <dd
                      data-workflow-progress-status={progressState}
                      data-workflow-progress-freshness={progressState}
                    >
                      <span className={`workflow-state-pill ${progressPillClass}`}>
                        {humanizeToken(progressState)}
                      </span>
                      <span className="workflow-inline-muted"> {progressDescription}</span>
                    </dd>
                  </div>
                  <div>
                    <dt>Last meaningful progress</dt>
                    <dd
                      data-workflow-last-meaningful-type={lastMeaningfulEvent?.type ?? ''}
                      data-workflow-last-meaningful-at={lastMeaningfulEvent?.timestamp ?? ''}
                    >
                      {lastMeaningfulEvent
                        ? `${lastMeaningfulEvent.summary} • ${describeRelativeTime(lastMeaningfulEvent.timestamp, clockMs)}`
                        : 'No meaningful progress recorded yet.'}
                    </dd>
                  </div>
                  <div>
                    <dt>Latest runtime event</dt>
                    <dd
                      data-workflow-last-event-type={lastEvent?.type ?? ''}
                      data-workflow-last-event-summary={lastEvent?.summary ?? ''}
                    >
                      {lastEvent
                        ? `${lastEvent.summary} • ${describeRelativeTime(lastEvent.created_at, clockMs)}`
                        : 'No runtime events yet.'}
                    </dd>
                  </div>
                </dl>
              </div>

              <div className="workflow-goal-card">
                <p className="workflow-card-kicker">Goal Prompt</p>
                <pre>
                  <code>{detail.run.goal_prompt}</code>
                </pre>
              </div>
            </section>

            <section
              className="workflow-panel workflow-panel-secondary"
              data-workflow-gate-panel="true"
              data-workflow-panel-priority={openApprovalGate ? 'secondary' : 'normal'}
            >
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

            <section
              className="workflow-panel workflow-artifacts-panel workflow-panel-secondary"
              data-workflow-artifacts-panel="true"
              data-workflow-panel-priority={openApprovalGate ? 'secondary' : 'normal'}
            >
              <header className="workflow-panel-header">
                <div>
                  <p className="workflow-card-kicker">Artifacts</p>
                  <h2>Persisted worker outputs</h2>
                </div>
              </header>
              {detail.artifacts.length > 0 ? (
                <div className="workflow-artifact-list">
                  {detail.artifacts.map((artifact) => (
                    <ArtifactCard key={artifact.id} artifact={artifact} />
                  ))}
                </div>
              ) : (
                <p className="workflow-muted-copy">No runtime artifacts have been persisted for this run yet.</p>
              )}
            </section>

            <section
              className="workflow-panel workflow-events-panel workflow-panel-secondary"
              data-workflow-timeline="true"
              data-workflow-panel-priority={openApprovalGate ? 'secondary' : 'normal'}
            >
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

            <section
              className="workflow-panel workflow-sessions-panel workflow-panel-secondary"
              data-workflow-sessions-panel="true"
              data-workflow-panel-priority={openApprovalGate ? 'secondary' : 'normal'}
            >
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
