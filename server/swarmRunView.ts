import type { WorkflowRunSessionDetail } from '../shared/api.ts';
import type {
  GateRecord,
  RunEventRecord,
  SwarmCurrentGateView,
  SwarmDefinitionDetail,
  SwarmDefinitionSummary,
  SwarmRunAgentView,
  SwarmRunTopLevelState,
  SwarmTimelineEntry,
  WorkflowRunRecord,
  WorkflowRunSwarmView,
} from '../shared/workflowRuntime.ts';
import { SwarmDefinitionService } from './swarmDefinitionService.ts';

const swarmDefinitions = new SwarmDefinitionService();

type WorkflowRunSwarmInput = {
  run: WorkflowRunRecord;
  sessions: WorkflowRunSessionDetail[];
  open_gates: GateRecord[];
  events: RunEventRecord[];
};

function humanizeToken(value: string) {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (char) => char.toUpperCase());
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

  return {
    gate_id: gate.id,
    title: gate.title,
    status: gate.status,
    actor: gate.actor,
    rule_id: rule?.id ?? null,
    owner_agent_id: rule?.owner_agent_id ?? null,
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
    planner_turn_failed: 'Planner turn failed',
    planner_marker_detected: 'Marker detected',
    planner_marker_not_found: 'Marker not found',
    gate_opened: 'Gate opened',
    gate_answered: 'Gate answered',
    gate_dismissed: 'Gate dismissed',
    state_transition: 'State changed',
    implementer_workspace_created: 'Implementer workspace created',
    implementer_session_started: 'Implementer session started',
    implementer_turn_started: 'Implementer turn started',
    implementer_turn_completed: 'Implementer turn completed',
    implementer_turn_failed: 'Implementer turn failed',
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
  if (event.type.includes('marker')) {
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
  return input.events.map((event) => ({
    id: `timeline_${event.id}`,
    event_id: event.id,
    timestamp: event.created_at,
    emphasis: eventEmphasis(event),
    title: eventTitle(event),
    summary: event.summary,
    agent_id: event.session_id ? sessionAgentIds.get(event.session_id) ?? null : null,
    session_id: event.session_id ?? null,
    turn_id: event.turn_id ?? null,
  }));
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

    const plannerRoute = args.definition.allowed_routes[0] ?? null;
    if (plannerRoute) {
      lines.push(`  ${gateNodeId} -->|approve| ${mermaidNodeId('agent', plannerRoute.to_agent_id)}`);
    }
  }

  lines.push(`  %% active_state=${args.activeStateId}`);
  return lines.join('\n');
}

export function buildWorkflowRunSwarmView(input: WorkflowRunSwarmInput): WorkflowRunSwarmView | null {
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

  return {
    definition: summarizeDefinition(definition),
    top_level_state: topLevelState,
    active_state_id: input.run.current_state_id,
    active_state_family: input.run.current_state_family,
    current_gate: currentGate,
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
