import type {
  WorkflowDefinitionDetail,
  WorkflowDefinitionGateView,
  WorkflowDefinitionPromptView,
  WorkflowDefinitionStateView,
  WorkflowDefinitionSummary,
  WorkflowDefinitionTransitionView,
  WorkflowDefinitionValidation,
  WorkflowDefinitionValidationIssue,
  WorkflowMarkerProtocolView,
  WorkflowParserHookView,
  WorkflowRunRecord,
} from '../../shared/workflowRuntime.ts';

export type WorkflowPromptContext = {
  run: WorkflowRunRecord;
};

export type WorkflowPromptTemplate = WorkflowDefinitionPromptView & {
  render: (context: WorkflowPromptContext) => string;
};

export type WorkflowMarkerMatch = {
  marker_id: string;
  raw: string;
  content: string | null;
  attributes: Record<string, string>;
  start: number;
  end: number;
};

export type WorkflowExtractionMarker = WorkflowMarkerProtocolView & {
  parse: (text: string) => WorkflowMarkerMatch[];
};

export type WorkflowParserHook = WorkflowParserHookView & {
  parse: (text: string) => unknown | null;
};

export type WorkflowDefinition = {
  id: string;
  title: string;
  summary: string;
  version: string;
  initial_state_id: string;
  states: WorkflowDefinitionStateView[];
  transitions: WorkflowDefinitionTransitionView[];
  gates: WorkflowDefinitionGateView[];
  prompts: WorkflowPromptTemplate[];
  markers: WorkflowExtractionMarker[];
  parser_hooks: WorkflowParserHook[];
};

export type WorkflowTransitionGraph = {
  initial_state_id: string;
  adjacency: Record<string, string[]>;
  inbound: Record<string, string[]>;
  terminal_state_ids: string[];
};

export function getWorkflowState(definition: WorkflowDefinition, stateId: string) {
  return definition.states.find((state) => state.id === stateId) ?? null;
}

export function getWorkflowPrompt(definition: WorkflowDefinition, promptId: string) {
  return definition.prompts.find((prompt) => prompt.id === promptId) ?? null;
}

export function getWorkflowParserHook(definition: WorkflowDefinition, parserHookId: string) {
  return definition.parser_hooks.find((hook) => hook.id === parserHookId) ?? null;
}

export function findWorkflowTransition(definition: WorkflowDefinition, args: {
  fromStateId: string;
  event: string;
}) {
  return (
    definition.transitions.find(
      (transition) => transition.from === args.fromStateId && transition.event === args.event,
    ) ?? null
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseAttributes(raw: string) {
  const attributes: Record<string, string> = {};
  for (const match of raw.matchAll(/([A-Za-z0-9:_-]+)\s*=\s*"([^"]*)"/g)) {
    attributes[match[1]] = match[2];
  }
  return attributes;
}

function matchesRequiredAttributes(
  actual: Record<string, string>,
  expected: Record<string, string>,
): boolean {
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) {
      return false;
    }
  }
  return true;
}

function buildSummary(
  definition: WorkflowDefinition,
  validation: WorkflowDefinitionValidation,
): WorkflowDefinitionSummary {
  return {
    id: definition.id,
    title: definition.title,
    summary: definition.summary,
    version: definition.version,
    initial_state_id: definition.initial_state_id,
    state_count: definition.states.length,
    transition_count: definition.transitions.length,
    validation,
  };
}

function escapeMermaidLabel(value: string) {
  return value.replace(/"/g, '\\"');
}

export function defineWorkflow(definition: WorkflowDefinition) {
  return definition;
}

export function createBlockTagMarker(args: {
  id: string;
  title: string;
  description: string;
  tag: string;
  example: string;
  attributes?: Record<string, string>;
}): WorkflowExtractionMarker {
  const requiredAttributes = args.attributes ?? {};
  const regex = new RegExp(
    `<${escapeRegExp(args.tag)}(?<attrs>\\s+[^>]*)?>(?<content>[\\s\\S]*?)<\\/${escapeRegExp(args.tag)}>`,
    'g',
  );

  return {
    id: args.id,
    title: args.title,
    description: args.description,
    kind: 'block_tag',
    tag: args.tag,
    attributes: requiredAttributes,
    example: args.example,
    parse(text) {
      const matches: WorkflowMarkerMatch[] = [];
      for (const match of text.matchAll(regex)) {
        const rawAttributes = match.groups?.attrs ?? '';
        const attributes = parseAttributes(rawAttributes);
        if (!matchesRequiredAttributes(attributes, requiredAttributes)) {
          continue;
        }

        matches.push({
          marker_id: args.id,
          raw: match[0],
          content: match.groups?.content?.trim() ?? null,
          attributes,
          start: match.index ?? 0,
          end: (match.index ?? 0) + match[0].length,
        });
      }
      return matches;
    },
  };
}

export function createSelfClosingTagMarker(args: {
  id: string;
  title: string;
  description: string;
  tag: string;
  example: string;
  attributes?: Record<string, string>;
}): WorkflowExtractionMarker {
  const requiredAttributes = args.attributes ?? {};
  const regex = new RegExp(`<${escapeRegExp(args.tag)}(?<attrs>\\s+[^>]*)?\\s*\\/?>`, 'g');

  return {
    id: args.id,
    title: args.title,
    description: args.description,
    kind: 'self_closing_tag',
    tag: args.tag,
    attributes: requiredAttributes,
    example: args.example,
    parse(text) {
      const matches: WorkflowMarkerMatch[] = [];
      for (const match of text.matchAll(regex)) {
        const rawAttributes = match.groups?.attrs ?? '';
        const attributes = parseAttributes(rawAttributes);
        if (!matchesRequiredAttributes(attributes, requiredAttributes)) {
          continue;
        }

        matches.push({
          marker_id: args.id,
          raw: match[0],
          content: null,
          attributes,
          start: match.index ?? 0,
          end: (match.index ?? 0) + match[0].length,
        });
      }
      return matches;
    },
  };
}

export function buildWorkflowTransitionGraph(definition: WorkflowDefinition): WorkflowTransitionGraph {
  const adjacency = Object.fromEntries(definition.states.map((state) => [state.id, [] as string[]]));
  const inbound = Object.fromEntries(definition.states.map((state) => [state.id, [] as string[]]));

  for (const transition of definition.transitions) {
    if (transition.from in adjacency) {
      adjacency[transition.from]!.push(transition.id);
    }
    if (transition.to in inbound) {
      inbound[transition.to]!.push(transition.id);
    }
  }

  return {
    initial_state_id: definition.initial_state_id,
    adjacency,
    inbound,
    terminal_state_ids: definition.states.filter((state) => state.terminal).map((state) => state.id),
  };
}

export function validateWorkflowDefinition(definition: WorkflowDefinition): WorkflowDefinitionValidation {
  const issues: WorkflowDefinitionValidationIssue[] = [];
  const stateIds = new Set<string>();
  const transitionIds = new Set<string>();
  const gateIds = new Set<string>();
  const promptIds = new Set<string>();
  const markerIds = new Set<string>();
  const parserHookIds = new Set<string>();
  const stateById = new Map(definition.states.map((state) => [state.id, state]));

  for (const state of definition.states) {
    if (stateIds.has(state.id)) {
      issues.push({
        level: 'error',
        code: 'duplicate_state_id',
        message: `State "${state.id}" is defined more than once.`,
        state_id: state.id,
      });
      continue;
    }
    stateIds.add(state.id);
  }

  if (!stateIds.has(definition.initial_state_id)) {
    issues.push({
      level: 'error',
      code: 'missing_initial_state',
      message: `Initial state "${definition.initial_state_id}" is not defined.`,
      state_id: definition.initial_state_id,
    });
  }

  for (const transition of definition.transitions) {
    if (transitionIds.has(transition.id)) {
      issues.push({
        level: 'error',
        code: 'duplicate_transition_id',
        message: `Transition "${transition.id}" is defined more than once.`,
        transition_id: transition.id,
      });
      continue;
    }
    transitionIds.add(transition.id);

    if (!stateById.has(transition.from)) {
      issues.push({
        level: 'error',
        code: 'unknown_transition_source',
        message: `Transition "${transition.id}" references unknown source state "${transition.from}".`,
        transition_id: transition.id,
        state_id: transition.from,
      });
    }
    if (!stateById.has(transition.to)) {
      issues.push({
        level: 'error',
        code: 'unknown_transition_target',
        message: `Transition "${transition.id}" references unknown target state "${transition.to}".`,
        transition_id: transition.id,
        state_id: transition.to,
      });
    }
  }

  for (const parserHook of definition.parser_hooks) {
    parserHookIds.add(parserHook.id);
  }

  for (const gate of definition.gates) {
    if (gateIds.has(gate.id)) {
      issues.push({
        level: 'error',
        code: 'duplicate_gate_id',
        message: `Gate "${gate.id}" is defined more than once.`,
        gate_id: gate.id,
      });
      continue;
    }
    gateIds.add(gate.id);

    const state = stateById.get(gate.state_id);
    if (!state) {
      issues.push({
        level: 'error',
        code: 'unknown_gate_state',
        message: `Gate "${gate.id}" references unknown state "${gate.state_id}".`,
        gate_id: gate.id,
        state_id: gate.state_id,
      });
      continue;
    }

    if (gate.kind === 'approval' && state.family !== 'approval') {
      issues.push({
        level: 'error',
        code: 'approval_gate_requires_approval_state',
        message: `Approval gate "${gate.id}" must live on an approval state.`,
        gate_id: gate.id,
        state_id: gate.state_id,
      });
    }

    for (const option of gate.options) {
      const transition = definition.transitions.find((entry) => entry.id === option.transition_id) ?? null;
      if (!transition) {
        issues.push({
          level: 'error',
          code: 'unknown_gate_transition',
          message: `Gate "${gate.id}" option "${option.id}" references unknown transition "${option.transition_id}".`,
          gate_id: gate.id,
          transition_id: option.transition_id,
        });
        continue;
      }

      if (transition.from !== gate.state_id) {
        issues.push({
          level: 'error',
          code: 'gate_transition_from_mismatch',
          message: `Gate "${gate.id}" option "${option.id}" must reference a transition that starts at "${gate.state_id}".`,
          gate_id: gate.id,
          transition_id: option.transition_id,
          state_id: gate.state_id,
        });
      }
    }
  }

  for (const prompt of definition.prompts) {
    if (promptIds.has(prompt.id)) {
      issues.push({
        level: 'error',
        code: 'duplicate_prompt_id',
        message: `Prompt "${prompt.id}" is defined more than once.`,
      });
      continue;
    }
    promptIds.add(prompt.id);

    for (const stateId of prompt.used_in_state_ids) {
      if (!stateById.has(stateId)) {
        issues.push({
          level: 'error',
          code: 'prompt_uses_unknown_state',
          message: `Prompt "${prompt.id}" references unknown state "${stateId}".`,
          state_id: stateId,
        });
      }
    }

    for (const parserHookId of prompt.parser_hook_ids) {
      if (!parserHookIds.has(parserHookId)) {
        issues.push({
          level: 'error',
          code: 'prompt_uses_unknown_parser_hook',
          message: `Prompt "${prompt.id}" references unknown parser hook "${parserHookId}".`,
        });
      }
    }
  }

  for (const marker of definition.markers) {
    if (markerIds.has(marker.id)) {
      issues.push({
        level: 'error',
        code: 'duplicate_marker_id',
        message: `Marker "${marker.id}" is defined more than once.`,
      });
      continue;
    }
    markerIds.add(marker.id);
  }

  for (const parserHook of definition.parser_hooks) {
    const duplicateCount = definition.parser_hooks.filter((hook) => hook.id === parserHook.id).length;
    if (duplicateCount > 1) {
      issues.push({
        level: 'error',
        code: 'duplicate_parser_hook_id',
        message: `Parser hook "${parserHook.id}" is defined more than once.`,
      });
    }

    for (const markerId of parserHook.marker_ids) {
      if (!markerIds.has(markerId)) {
        issues.push({
          level: 'error',
          code: 'parser_hook_uses_unknown_marker',
          message: `Parser hook "${parserHook.id}" references unknown marker "${markerId}".`,
        });
      }
    }

    if (
      parserHook.transition_event &&
      !definition.transitions.some((transition) => transition.event === parserHook.transition_event)
    ) {
      issues.push({
        level: 'error',
        code: 'parser_hook_uses_unknown_transition_event',
        message: `Parser hook "${parserHook.id}" references unknown transition event "${parserHook.transition_event}".`,
      });
    }
  }

  for (const prompt of definition.prompts) {
    for (const markerId of prompt.output_marker_ids) {
      if (!markerIds.has(markerId)) {
        issues.push({
          level: 'error',
          code: 'prompt_uses_unknown_marker',
          message: `Prompt "${prompt.id}" references unknown marker "${markerId}".`,
        });
      }
    }
  }

  const graph = buildWorkflowTransitionGraph(definition);
  const reachable = new Set<string>();
  const queue = [definition.initial_state_id];

  while (queue.length > 0) {
    const stateId = queue.shift()!;
    if (reachable.has(stateId)) {
      continue;
    }
    reachable.add(stateId);

    for (const transitionId of graph.adjacency[stateId] ?? []) {
      const transition = definition.transitions.find((entry) => entry.id === transitionId);
      if (transition && !reachable.has(transition.to)) {
        queue.push(transition.to);
      }
    }
  }

  for (const state of definition.states) {
    const outgoingCount = graph.adjacency[state.id]?.length ?? 0;
    if (state.terminal && outgoingCount > 0) {
      issues.push({
        level: 'error',
        code: 'terminal_state_has_outgoing_transition',
        message: `Terminal state "${state.id}" cannot have outgoing transitions.`,
        state_id: state.id,
      });
    }
    if (!state.terminal && outgoingCount === 0) {
      issues.push({
        level: 'error',
        code: 'non_terminal_state_without_transition',
        message: `Non-terminal state "${state.id}" needs at least one outgoing transition.`,
        state_id: state.id,
      });
    }
    if (!reachable.has(state.id)) {
      issues.push({
        level: 'error',
        code: 'unreachable_state',
        message: `State "${state.id}" is unreachable from the initial state.`,
        state_id: state.id,
      });
    }
  }

  return {
    valid: issues.every((issue) => issue.level !== 'error'),
    issues,
  };
}

export function renderWorkflowDefinitionMermaid(definition: WorkflowDefinition) {
  const lines = ['stateDiagram-v2', `    [*] --> ${definition.initial_state_id}`, ''];

  for (const state of definition.states) {
    const gateSuffix = state.entry_gate_ids.length > 0 ? `\\nGates: ${state.entry_gate_ids.join(', ')}` : '';
    lines.push(`    state "${escapeMermaidLabel(`${state.title}${gateSuffix}`)}" as ${state.id}`);
  }

  lines.push('');

  for (const transition of definition.transitions) {
    const label = transition.title ? `${transition.event}\\n${transition.title}` : transition.event;
    lines.push(`    ${transition.from} --> ${transition.to}: ${escapeMermaidLabel(label)}`);
  }

  return `${lines.join('\n')}\n`;
}

export function serializeWorkflowDefinition(definition: WorkflowDefinition): WorkflowDefinitionDetail {
  const validation = validateWorkflowDefinition(definition);
  return {
    ...buildSummary(definition, validation),
    states: definition.states,
    transitions: definition.transitions,
    gates: definition.gates,
    prompts: definition.prompts.map((prompt) => ({
      id: prompt.id,
      actor_label: prompt.actor_label,
      title: prompt.title,
      description: prompt.description,
      used_in_state_ids: prompt.used_in_state_ids,
      output_marker_ids: prompt.output_marker_ids,
      parser_hook_ids: prompt.parser_hook_ids,
    })),
    markers: definition.markers.map((marker) => ({
      id: marker.id,
      title: marker.title,
      description: marker.description,
      kind: marker.kind,
      tag: marker.tag,
      attributes: marker.attributes,
      example: marker.example,
    })),
    parser_hooks: definition.parser_hooks.map((hook) => ({
      id: hook.id,
      title: hook.title,
      description: hook.description,
      marker_ids: hook.marker_ids,
      output_kind: hook.output_kind,
      transition_event: hook.transition_event ?? null,
    })),
    mermaid: renderWorkflowDefinitionMermaid(definition),
  };
}

export function summarizeWorkflowDefinition(definition: WorkflowDefinition): WorkflowDefinitionSummary {
  return buildSummary(definition, validateWorkflowDefinition(definition));
}
