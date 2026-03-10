import type {
  WorkflowDefinitionDetail,
  WorkflowDefinitionSummary,
  WorkflowDefinitionValidation,
} from '../shared/workflowRuntime.ts';
import {
  registeredWorkflows,
  serializeWorkflowDefinition,
  summarizeWorkflowDefinition,
  validateWorkflowDefinition,
  type WorkflowDefinition,
} from './workflows/index.ts';

export class WorkflowDefinitionService {
  #definitions: Map<string, WorkflowDefinition>;

  constructor(definitions: WorkflowDefinition[] = registeredWorkflows) {
    this.#definitions = new Map(definitions.map((definition) => [definition.id, definition]));
  }

  listDefinitions(): WorkflowDefinitionSummary[] {
    return [...this.#definitions.values()].map((definition) => summarizeWorkflowDefinition(definition));
  }

  readDefinition(id: string): WorkflowDefinitionDetail | null {
    const definition = this.#definitions.get(id);
    return definition ? serializeWorkflowDefinition(definition) : null;
  }

  getDefinition(id: string): WorkflowDefinition | null {
    return this.#definitions.get(id) ?? null;
  }

  validateDefinition(id: string): WorkflowDefinitionValidation | null {
    const definition = this.#definitions.get(id);
    return definition ? validateWorkflowDefinition(definition) : null;
  }
}
