import type {
  SwarmDefinitionDetail,
  SwarmDefinitionSummary,
  SwarmDefinitionValidation,
} from '../shared/workflowRuntime.ts';
import {
  registeredSwarms,
  serializeSwarmDefinition,
  summarizeSwarmDefinition,
  validateSwarmDefinition,
  type SwarmDefinition,
} from './swarms/index.ts';

export class SwarmDefinitionService {
  #definitions: Map<string, SwarmDefinition>;

  constructor(definitions: SwarmDefinition[] = registeredSwarms) {
    this.#definitions = new Map(definitions.map((definition) => [definition.id, definition]));
  }

  listDefinitions(): SwarmDefinitionSummary[] {
    return [...this.#definitions.values()].map((definition) => summarizeSwarmDefinition(definition));
  }

  readDefinition(id: string): SwarmDefinitionDetail | null {
    const definition = this.#definitions.get(id);
    return definition ? serializeSwarmDefinition(definition) : null;
  }

  getDefinition(id: string): SwarmDefinition | null {
    return this.#definitions.get(id) ?? null;
  }

  validateDefinition(id: string): SwarmDefinitionValidation | null {
    const definition = this.#definitions.get(id);
    return definition ? validateSwarmDefinition(definition) : null;
  }
}
