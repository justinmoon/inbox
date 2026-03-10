import type {
  SwarmArtifactKindView,
  SwarmDefinitionDetail,
  SwarmDefinitionSummary,
  SwarmDefinitionValidation,
  SwarmDefinitionValidationIssue,
  SwarmGateRuleView,
  SwarmRouteView,
  SwarmAgentDefinitionView,
} from '../../shared/workflowRuntime.ts';

export type SwarmDefinition = {
  id: string;
  title: string;
  summary: string;
  agents: SwarmAgentDefinitionView[];
  allowed_routes: SwarmRouteView[];
  gate_rules: SwarmGateRuleView[];
  artifact_kinds: SwarmArtifactKindView[];
};

function escapeMermaidLabel(value: string) {
  return value.replace(/"/g, '\\"');
}

function mermaidNodeId(prefix: string, id: string) {
  return `${prefix}_${id.replace(/[^A-Za-z0-9_]/g, '_')}`;
}

function buildSummary(
  definition: SwarmDefinition,
  validation: SwarmDefinitionValidation,
): SwarmDefinitionSummary {
  return {
    id: definition.id,
    title: definition.title,
    summary: definition.summary,
    agent_count: definition.agents.length,
    route_count: definition.allowed_routes.length,
    gate_rule_count: definition.gate_rules.length,
    artifact_kind_count: definition.artifact_kinds.length,
    validation,
  };
}

export function defineSwarm(definition: SwarmDefinition) {
  return definition;
}

export function validateSwarmDefinition(definition: SwarmDefinition): SwarmDefinitionValidation {
  const issues: SwarmDefinitionValidationIssue[] = [];
  const agentIds = new Set<string>();
  const routeIds = new Set<string>();
  const gateRuleIds = new Set<string>();
  const artifactKindIds = new Set<string>();
  const hubAgents = definition.agents.filter((agent) => agent.kind === 'hub');

  for (const agent of definition.agents) {
    if (agentIds.has(agent.id)) {
      issues.push({
        level: 'error',
        code: 'duplicate_agent_id',
        message: `Agent "${agent.id}" is defined more than once.`,
        agent_id: agent.id,
      });
      continue;
    }
    agentIds.add(agent.id);
  }

  if (hubAgents.length === 0) {
    issues.push({
      level: 'error',
      code: 'missing_hub_agent',
      message: 'A hub-and-spoke swarm definition needs at least one hub agent.',
    });
  }

  for (const artifactKind of definition.artifact_kinds) {
    if (artifactKindIds.has(artifactKind.id)) {
      issues.push({
        level: 'error',
        code: 'duplicate_artifact_kind_id',
        message: `Artifact kind "${artifactKind.id}" is defined more than once.`,
        artifact_kind_id: artifactKind.id,
      });
      continue;
    }
    artifactKindIds.add(artifactKind.id);
  }

  for (const route of definition.allowed_routes) {
    if (routeIds.has(route.id)) {
      issues.push({
        level: 'error',
        code: 'duplicate_route_id',
        message: `Route "${route.id}" is defined more than once.`,
        route_id: route.id,
      });
      continue;
    }
    routeIds.add(route.id);

    if (!agentIds.has(route.from_agent_id)) {
      issues.push({
        level: 'error',
        code: 'unknown_route_source_agent',
        message: `Route "${route.id}" references unknown source agent "${route.from_agent_id}".`,
        route_id: route.id,
        agent_id: route.from_agent_id,
      });
    }

    if (!agentIds.has(route.to_agent_id)) {
      issues.push({
        level: 'error',
        code: 'unknown_route_target_agent',
        message: `Route "${route.id}" references unknown target agent "${route.to_agent_id}".`,
        route_id: route.id,
        agent_id: route.to_agent_id,
      });
    }
  }

  for (const gateRule of definition.gate_rules) {
    if (gateRuleIds.has(gateRule.id)) {
      issues.push({
        level: 'error',
        code: 'duplicate_gate_rule_id',
        message: `Gate rule "${gateRule.id}" is defined more than once.`,
        gate_rule_id: gateRule.id,
      });
      continue;
    }
    gateRuleIds.add(gateRule.id);

    if (!agentIds.has(gateRule.owner_agent_id)) {
      issues.push({
        level: 'error',
        code: 'unknown_gate_rule_owner',
        message: `Gate rule "${gateRule.id}" references unknown owner agent "${gateRule.owner_agent_id}".`,
        gate_rule_id: gateRule.id,
        agent_id: gateRule.owner_agent_id,
      });
    }

    if (!artifactKindIds.has(gateRule.artifact_kind_id)) {
      issues.push({
        level: 'error',
        code: 'unknown_gate_rule_artifact_kind',
        message: `Gate rule "${gateRule.id}" references unknown artifact kind "${gateRule.artifact_kind_id}".`,
        gate_rule_id: gateRule.id,
        artifact_kind_id: gateRule.artifact_kind_id,
      });
    }

    if (gateRule.workflow_gate_ids.length === 0) {
      issues.push({
        level: 'warning',
        code: 'gate_rule_without_workflow_gate_ids',
        message: `Gate rule "${gateRule.id}" is not mapped to any workflow gate ids yet.`,
        gate_rule_id: gateRule.id,
      });
    }
  }

  return {
    valid: issues.every((issue) => issue.level !== 'error'),
    issues,
  };
}

export function renderSwarmDefinitionMermaid(definition: SwarmDefinition) {
  const lines = ['flowchart LR'];

  for (const agent of definition.agents) {
    const nodeId = mermaidNodeId('agent', agent.id);
    lines.push(
      `  ${nodeId}["${escapeMermaidLabel(`${agent.title}\\n${agent.kind}`)}"]`,
    );
  }

  for (const route of definition.allowed_routes) {
    lines.push(
      `  ${mermaidNodeId('agent', route.from_agent_id)} -->|${escapeMermaidLabel(route.title)}| ${mermaidNodeId('agent', route.to_agent_id)}`,
    );
  }

  for (const gateRule of definition.gate_rules) {
    const gateNodeId = mermaidNodeId('gate', gateRule.id);
    lines.push(`  ${gateNodeId}{{"${escapeMermaidLabel(gateRule.title)}"}}`);
    lines.push(
      `  ${mermaidNodeId('agent', gateRule.owner_agent_id)} -. opens .-> ${gateNodeId}`,
    );
  }

  return lines.join('\n');
}

export function summarizeSwarmDefinition(definition: SwarmDefinition): SwarmDefinitionSummary {
  return buildSummary(definition, validateSwarmDefinition(definition));
}

export function serializeSwarmDefinition(definition: SwarmDefinition): SwarmDefinitionDetail {
  const validation = validateSwarmDefinition(definition);
  return {
    ...buildSummary(definition, validation),
    agents: definition.agents,
    allowed_routes: definition.allowed_routes,
    gate_rules: definition.gate_rules,
    artifact_kinds: definition.artifact_kinds,
    mermaid: renderSwarmDefinitionMermaid(definition),
  };
}
