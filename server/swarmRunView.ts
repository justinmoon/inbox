import type { WorkflowRunSessionDetail } from '../shared/api.ts';
import type {
  GateRecord,
  RunEventRecord,
  SwarmCurrentGateView,
  SwarmDefinitionDetail,
  SwarmDefinitionSummary,
  SwarmProgressState,
  SwarmRunActivityView,
  SwarmRunAgentView,
  SwarmRunTopLevelState,
  SwarmTimelineEntry,
  WorkflowRunRecord,
  WorkflowRunSwarmView,
} from '../shared/workflowRuntime.ts';
import { SwarmDefinitionService } from './swarmDefinitionService.ts';
import { resolveSwarmGateRuleRoute } from './swarms/index.ts';

const swarmDefinitions = new SwarmDefinitionService();

type WorkflowRunSwarmInput = {
  run: WorkflowRunRecord;
  sessions: WorkflowRunSessionDetail[];
  open_gates: GateRecord[];
  events: RunEventRecord[];
};

const ACTIVE_PROGRESS_WINDOW_MS = 20_000;
const RECENT_UPDATE_WINDOW_MS = 45_000;

function humanizeToken(value: string) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function parseTimestamp(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function latestTimestamp(values: Array<string | null | undefined>) {
  let bestTimestamp: string | null = null;
  let bestValue = Number.NEGATIVE_INFINITY;

  for (const value of values) {
    const parsed = parseTimestamp(value);
    if (parsed == null || parsed <= bestValue) {
      continue;
    }

    bestValue = parsed;
    bestTimestamp = value ?? null;
  }

  return bestTimestamp;
}

function mermaidNodeId(prefix: string, id: string) {
  return `${prefix}_${id.replace(/[^A-Za-z0-9_]/g, '_')}`;
}

function escapeMermaidLabel(value: string) {
  return value.replace(/"/g, '\\"');
}

function summarizeDefinition(definition: SwarmDefinitionDetail): SwarmDefinitionSummary {
  return {
    id: definition.id,
    title: definition.title,
    summary: definition.summary,
    agent_count: definition.agent_count,
    route_count: definition.route_count,
    gate_rule_count: definition.gate_rule_count,
    artifact_kind_count: definition.artifact_kind_count,
    validation: definition.validation,
  };
}

function matchesAgentSession(
  agent: SwarmDefinitionDetail['agents'][number],
  sessionDetail: WorkflowRunSessionDetail,
) {
  return (
    agent.session_kinds.includes(sessionDetail.session.kind) ||
    agent.owned_state_ids.includes(sessionDetail.session.state_id) ||
    sessionDetail.session.actor === agent.id
  );
}

function resolveArtifactTitle(definition: SwarmDefinitionDetail, artifactKindId: string | null) {
  if (!artifactKindId) {
    return 'Gate Artifact';
  }

  return (
    definition.artifact_kinds.find((artifactKind) => artifactKind.id === artifactKindId)?.title ??
    humanizeToken(artifactKindId)
  );
}

function buildCurrentGate(
  definition: SwarmDefinitionDetail,
  gate: GateRecord | null,
): SwarmCurrentGateView | null {
  if (!gate) {
    return null;
  }

  const rule =
    definition.gate_rules.find((gateRule) => gateRule.workflow_gate_ids.includes(gate.definition_gate_id)) ??
    null;
  const artifactKindId = rule?.artifact_kind_id ?? (gate.metadata.prompt_candidate ? 'prompt_candidate' : null);
  const artifactContent = gate.metadata.prompt_candidate ?? null;
  const unlockedRoute =
    rule != null
      ? resolveSwarmGateRuleRoute(definition, rule)
      : {
          route: null,
          target_agent_id: null,
        };
  const targetAgent = unlockedRoute.target_agent_id
    ? definition.agents.find((agent) => agent.id === unlockedRoute.target_agent_id) ?? null
    : null;

  return {
    gate_id: gate.id,
    title: gate.title,
    status: gate.status,
    actor: gate.actor,
    rule_id: rule?.id ?? null,
    owner_agent_id: rule?.owner_agent_id ?? null,
    unlocks_route_id: unlockedRoute.route?.id ?? null,
    unlocks_route_title: unlockedRoute.route?.title ?? null,
    unlocks_target_agent_id: unlockedRoute.target_agent_id,
    unlocks_target_agent_title: targetAgent?.title ?? null,
    artifact:
      artifactKindId || artifactContent
        ? {
            kind_id: artifactKindId,
            title: resolveArtifactTitle(definition, artifactKindId),
            content: artifactContent,
          }
        : null,
  };
}

export function deriveSwarmRunTopLevelState(args: {
  run: WorkflowRunRecord;
  open_gates: GateRecord[];
}): SwarmRunTopLevelState {
  if (args.run.current_state_id === 'failed' || args.run.status === 'failed') {
    return 'failed';
  }

  if (args.run.status === 'completed') {
    return 'completed';
  }

  if (args.open_gates.some((gate) => gate.status === 'open')) {
    return 'needs_user_input';
  }

  return 'working';
}

function eventOrder(a: RunEventRecord, b: RunEventRecord) {
  if (a.sequence !== b.sequence) {
    return a.sequence - b.sequence;
  }

  const timestampOrder = a.created_at.localeCompare(b.created_at);
  if (timestampOrder !== 0) {
    return timestampOrder;
  }

  return a.id.localeCompare(b.id);
}

function isMeaningfulProgressEvent(event: RunEventRecord) {
  if (
    event.type.endsWith('_failed') ||
    event.type.endsWith('_timed_out') ||
    event.type.endsWith('_runtime_failed') ||
    event.type.endsWith('_startup_failed') ||
    event.type === 'workspace_contract_violated'
  ) {
    return false;
  }

  return true;
}

function subphaseTitle(stateId: string) {
  const labels: Record<string, string> = {
    planning_conversation: 'Planning the next worker step',
    first_prompt_approval: 'Reviewing the first worker prompt',
    implementing: 'Implementer is executing the approved step',
    auto_review: 'Planner is reviewing implementer output',
    fixup_implementing: 'Implementer is applying a review fixup',
    artifact_forking: 'Artifact workers are preparing the approval packet',
    step_approval: 'Reviewing the next-step packet',
    completed: 'Workflow completed',
    failed: 'Workflow failed',
  };

  return labels[stateId] ?? humanizeToken(stateId);
}

function deriveProgressState(args: {
  run: WorkflowRunRecord;
  topLevelState: SwarmRunTopLevelState;
  activeSession: WorkflowRunSessionDetail | null;
  stalledSession: WorkflowRunSessionDetail | null;
  lastMeaningfulEvent: RunEventRecord | null;
  now: string;
}): SwarmProgressState {
  if (args.run.current_state_id === 'failed' || args.run.status === 'failed') {
    return 'failed';
  }

  if (args.run.status === 'completed') {
    return 'completed';
  }

  if (args.topLevelState === 'needs_user_input') {
    return 'waiting_on_user';
  }

  if (args.stalledSession) {
    return 'stalled';
  }

  const now = parseTimestamp(args.now);
  const lastMeaningfulAt = parseTimestamp(args.lastMeaningfulEvent?.created_at);
  const activeTurnStartedAt = parseTimestamp(args.activeSession?.session.active_turn_started_at);

  if (args.activeSession?.session.active_turn_id) {
    const freshnessAnchor = Math.max(
      lastMeaningfulAt ?? Number.NEGATIVE_INFINITY,
      activeTurnStartedAt ?? Number.NEGATIVE_INFINITY,
    );
    if (now != null && Number.isFinite(freshnessAnchor)) {
      return now - freshnessAnchor <= ACTIVE_PROGRESS_WINDOW_MS ? 'making_progress' : 'quiet_but_active';
    }

    return 'making_progress';
  }

  if (now != null && lastMeaningfulAt != null && now - lastMeaningfulAt <= RECENT_UPDATE_WINDOW_MS) {
    return 'recently_updated';
  }

  return 'idle';
}

function buildAgentViews(
  definition: SwarmDefinitionDetail,
  input: WorkflowRunSwarmInput,
  currentGate: SwarmCurrentGateView | null,
  topLevelState: SwarmRunTopLevelState,
) {
  const sessionAgentIds = new Map<string, string>();
  const agents: SwarmRunAgentView[] = definition.agents.map((agent) => {
    const matchedSessions = input.sessions.filter((sessionDetail) => matchesAgentSession(agent, sessionDetail));
    for (const sessionDetail of matchedSessions) {
      sessionAgentIds.set(sessionDetail.session.id, agent.id);
    }

    const primarySession =
      matchedSessions.findLast((sessionDetail) => Boolean(sessionDetail.session.active_turn_id)) ??
      matchedSessions.findLast((sessionDetail) => sessionDetail.session.status === 'active') ??
      matchedSessions.at(-1) ??
      null;
    const ownsCurrentState = agent.owned_state_ids.includes(input.run.current_state_id);
    const waitingOnUser = currentGate?.owner_agent_id === agent.id;

    let status: SwarmRunAgentView['status'] = 'idle';
    if (primarySession?.session.status === 'failed') {
      status = 'failed';
    } else if (topLevelState === 'needs_user_input' && waitingOnUser) {
      status = 'waiting_on_user';
    } else if (primarySession?.session.activity_status === 'stalled') {
      status = 'stalled';
    } else if (primarySession?.session.active_turn_id || (ownsCurrentState && topLevelState === 'working')) {
      status = 'working';
    }

    return {
      agent_id: agent.id,
      title: agent.title,
      kind: agent.kind,
      status,
      active_state_id:
        primarySession?.session.state_id ?? (ownsCurrentState ? input.run.current_state_id : null),
      session_id: primarySession?.session.id ?? null,
      thread_id: primarySession?.session.thread_id ?? null,
      active_turn_id: primarySession?.session.active_turn_id ?? null,
    };
  });

  return { agents, sessionAgentIds };
}

function eventTitle(event: RunEventRecord) {
  const labels: Record<string, string> = {
    run_created: 'Run created',
    agent_session_started: 'Agent session started',
    planner_turn_started: 'Planner turn started',
    planner_turn_steered: 'Planner turn updated',
    planner_turn_completed: 'Planner turn completed',
    planner_turn_timed_out: 'Planner turn timed out',
    planner_turn_retried: 'Planner turn retried',
    planner_turn_failed: 'Planner turn failed',
    planner_marker_detected: 'Marker detected',
    planner_marker_not_found: 'Marker not found',
    review_turn_started: 'Planner review started',
    review_turn_completed: 'Planner review completed',
    review_turn_failed: 'Planner review failed',
    review_result_detected: 'Review result detected',
    gate_opened: 'Gate opened',
    gate_answered: 'Gate answered',
    gate_dismissed: 'Gate dismissed',
    state_transition: 'State changed',
    implementer_workspace_created: 'Implementer workspace created',
    implementer_session_started: 'Implementer session started',
    implementer_turn_started: 'Implementer turn started',
    implementer_turn_completed: 'Implementer turn completed',
    implementer_turn_failed: 'Implementer turn failed',
    tutorial_worker_session_started: 'Tutorial worker session started',
    tutorial_worker_turn_started: 'Tutorial worker turn started',
    tutorial_worker_turn_completed: 'Tutorial worker turn completed',
    tutorial_worker_turn_failed: 'Tutorial worker turn failed',
    tutorial_artifact_persisted: 'Tutorial artifact persisted',
    next_prompt_worker_session_started: 'Next prompt worker session started',
    next_prompt_worker_turn_started: 'Next prompt worker turn started',
    next_prompt_worker_turn_completed: 'Next prompt worker turn completed',
    next_prompt_worker_turn_failed: 'Next prompt worker turn failed',
    next_prompt_artifact_persisted: 'Next prompt artifact persisted',
  };

  return labels[event.type] ?? humanizeToken(event.type);
}

function eventEmphasis(event: RunEventRecord): SwarmTimelineEntry['emphasis'] {
  if (event.type.includes('session_started')) {
    return 'session';
  }
  if (event.type.includes('turn_')) {
    return 'turn';
  }
  if (event.type.includes('marker') || event.type === 'review_result_detected') {
    return 'marker';
  }
  if (event.type.endsWith('_artifact_persisted')) {
    return 'marker';
  }
  if (event.type.startsWith('gate_')) {
    return 'gate';
  }
  if (event.type === 'state_transition') {
    return 'transition';
  }
  return 'system';
}

function buildTimeline(
  input: WorkflowRunSwarmInput,
  sessionAgentIds: Map<string, string>,
): SwarmTimelineEntry[] {
  return [...input.events]
    .sort(eventOrder)
    .map((event) => ({
      id: `timeline_${event.id}`,
      event_id: event.id,
      event_sequence: event.sequence,
      timestamp: event.created_at,
      emphasis: eventEmphasis(event),
      title: eventTitle(event),
      summary: event.summary,
      agent_id: event.session_id ? sessionAgentIds.get(event.session_id) ?? null : null,
      session_id: event.session_id ?? null,
      turn_id: event.turn_id ?? null,
    }));
}

function buildActivityView(args: {
  input: WorkflowRunSwarmInput;
  currentGate: SwarmCurrentGateView | null;
  topLevelState: SwarmRunTopLevelState;
  agents: SwarmRunAgentView[];
  sessionAgentIds: Map<string, string>;
  now: string;
}): SwarmRunActivityView {
  const sortedEvents = [...args.input.events].sort(eventOrder);
  const lastMeaningfulEvent =
    [...sortedEvents].reverse().find((event) => isMeaningfulProgressEvent(event)) ?? null;
  const activeSession =
    args.input.sessions.find((sessionDetail) => Boolean(sessionDetail.session.active_turn_id)) ?? null;
  const stalledSession =
    args.input.sessions.find((sessionDetail) => sessionDetail.session.activity_status === 'stalled') ?? null;
  const currentSession = activeSession ?? stalledSession ?? args.input.sessions.at(-1) ?? null;

  const activeAgentId =
    args.currentGate
      ? 'user'
      : currentSession?.session.id
        ? args.sessionAgentIds.get(currentSession.session.id) ?? currentSession.session.actor
        : args.agents.find((agent) => agent.status === 'working' || agent.status === 'stalled')?.agent_id ?? null;
  const activeAgentTitle =
    activeAgentId === 'user'
      ? 'User'
      : args.agents.find((agent) => agent.agent_id === activeAgentId)?.title ??
        (currentSession ? humanizeToken(currentSession.session.actor) : null);
  const authoritativeWorkspacePath =
    currentSession?.session.cwd ??
    args.input.sessions.findLast((sessionDetail) => Boolean(sessionDetail.session.cwd))?.session.cwd ??
    null;

  return {
    progress_state: deriveProgressState({
      run: args.input.run,
      topLevelState: args.topLevelState,
      activeSession,
      stalledSession,
      lastMeaningfulEvent,
      now: args.now,
    }),
    active_agent_id: activeAgentId,
    active_agent_title: activeAgentTitle,
    active_session_id: currentSession?.session.id ?? null,
    active_thread_id: currentSession?.session.thread_id ?? null,
    authoritative_workspace_path: authoritativeWorkspacePath,
    subphase_id: args.input.run.current_state_id,
    subphase_title: subphaseTitle(args.input.run.current_state_id),
    active_turn_started_at:
      activeSession?.session.active_turn_started_at ??
      latestTimestamp(args.input.sessions.map((sessionDetail) => sessionDetail.session.active_turn_started_at)),
    last_meaningful_event:
      lastMeaningfulEvent == null
        ? null
        : {
            event_id: lastMeaningfulEvent.id,
            event_sequence: lastMeaningfulEvent.sequence,
            type: lastMeaningfulEvent.type,
            title: eventTitle(lastMeaningfulEvent),
            summary: lastMeaningfulEvent.summary,
            timestamp: lastMeaningfulEvent.created_at,
          },
    last_meaningful_event_at: lastMeaningfulEvent?.created_at ?? null,
  };
}

function renderRunSwarmMermaid(args: {
  definition: SwarmDefinitionDetail;
  agents: SwarmRunAgentView[];
  currentGate: SwarmCurrentGateView | null;
  topLevelState: SwarmRunTopLevelState;
  activeStateId: string;
}) {
  const lines = ['flowchart LR'];

  for (const agent of args.agents) {
    const label = `${agent.title}\\n${agent.status}${agent.active_state_id ? `\\n${agent.active_state_id}` : ''}`;
    lines.push(`  ${mermaidNodeId('agent', agent.agent_id)}["${escapeMermaidLabel(label)}"]`);
  }

  for (const route of args.definition.allowed_routes) {
    lines.push(
      `  ${mermaidNodeId('agent', route.from_agent_id)} -->|${escapeMermaidLabel(route.title)}| ${mermaidNodeId('agent', route.to_agent_id)}`,
    );
  }

  if (args.currentGate) {
    const gateNodeId = mermaidNodeId('gate', args.currentGate.rule_id ?? args.currentGate.gate_id);
    const gateLabel = `${args.currentGate.title}\\n${args.topLevelState}`;
    lines.push(`  ${gateNodeId}{{"${escapeMermaidLabel(gateLabel)}"}}`);

    const gateRule =
      args.definition.gate_rules.find((rule) => rule.id === args.currentGate?.rule_id) ?? null;
    if (gateRule) {
      lines.push(`  ${mermaidNodeId('agent', gateRule.owner_agent_id)} -. gate .-> ${gateNodeId}`);
    }

    if (args.currentGate.unlocks_target_agent_id) {
      const approveLabel = args.currentGate.unlocks_route_title
        ? `approve via ${args.currentGate.unlocks_route_title}`
        : 'approve';
      lines.push(
        `  ${gateNodeId} -->|${escapeMermaidLabel(approveLabel)}| ${mermaidNodeId('agent', args.currentGate.unlocks_target_agent_id)}`,
      );
    }
  }

  lines.push(`  %% active_state=${args.activeStateId}`);
  return lines.join('\n');
}

export function buildWorkflowRunSwarmView(
  input: WorkflowRunSwarmInput,
  args?: {
    now?: string;
  },
): WorkflowRunSwarmView | null {
  const definition = swarmDefinitions.readDefinition(input.run.workflow_id);
  if (!definition) {
    return null;
  }

  const topLevelState = deriveSwarmRunTopLevelState({
    run: input.run,
    open_gates: input.open_gates,
  });
  const currentGate = buildCurrentGate(definition, input.open_gates[0] ?? null);
  const { agents, sessionAgentIds } = buildAgentViews(definition, input, currentGate, topLevelState);
  const timeline = buildTimeline(input, sessionAgentIds);
  const activity = buildActivityView({
    input,
    currentGate,
    topLevelState,
    agents,
    sessionAgentIds,
    now: args?.now ?? new Date().toISOString(),
  });

  return {
    definition: summarizeDefinition(definition),
    top_level_state: topLevelState,
    active_state_id: input.run.current_state_id,
    active_state_family: input.run.current_state_family,
    current_gate: currentGate,
    activity,
    agents,
    timeline,
    graph_mermaid: renderRunSwarmMermaid({
      definition,
      agents,
      currentGate,
      topLevelState,
      activeStateId: input.run.current_state_id,
    }),
  };
}
