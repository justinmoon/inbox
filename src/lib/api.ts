import type {
  ChangeUnitDetail,
  ChangeUnitListResponse,
  CreateWorkflowRunRequest,
  ReadWorkflowDefinitionResponse,
  WorkflowRunDetail,
  WorkflowRunStreamEvent,
  ExecuteNextActionResult,
  RespondApprovalResult,
} from '../../shared/api.ts';
import type {
  WorkflowDefinitionDetail,
  WorkflowDefinitionSummary,
  WorkflowRunRecord,
} from '../../shared/workflowRuntime.ts';

export class RequestError extends Error {
  status: number;
  code: string | null;

  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function requestJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { message?: string; error?: string }
      | null;
    throw new RequestError(
      body?.message ?? `Request failed with ${response.status}`,
      response.status,
      body?.error ?? null,
    );
  }
  return (await response.json()) as T;
}

export async function fetchChangeUnits(): Promise<ChangeUnitListResponse> {
  return await requestJson<ChangeUnitListResponse>('/api/change-units');
}

export async function fetchChangeUnitDetail(id: string): Promise<ChangeUnitDetail> {
  const response = await requestJson<{ detail: ChangeUnitDetail }>(`/api/change-units/${id}`);
  return response.detail;
}

export async function executeNextAction(id: string): Promise<ExecuteNextActionResult> {
  const response = await requestJson<{ execution: ExecuteNextActionResult }>(
    `/api/change-units/${id}/execute-next`,
    { method: 'POST' },
  );
  return response.execution;
}

export async function respondToLiveApproval(
  threadId: string,
  requestId: number,
  decision: 'accept' | 'decline',
): Promise<RespondApprovalResult> {
  return await requestJson<RespondApprovalResult>(
    `/api/live-sessions/${encodeURIComponent(threadId)}/approvals/${requestId}/respond`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision }),
    },
  );
}

export async function reseedDemo(): Promise<void> {
  await requestJson('/api/dev/reseed', { method: 'POST' });
}

export async function importBundle(path: string): Promise<{ imported: string; path: string }> {
  return await requestJson('/api/import-bundle', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  });
}

export async function fetchWorkflowDefinitions(): Promise<WorkflowDefinitionSummary[]> {
  const response = await requestJson<{ workflows: WorkflowDefinitionSummary[] }>('/api/workflows');
  return response.workflows;
}

export async function fetchWorkflowDefinition(id: string): Promise<WorkflowDefinitionDetail> {
  const response = await requestJson<ReadWorkflowDefinitionResponse>(
    `/api/workflows/${encodeURIComponent(id)}`,
  );
  return response.workflow;
}

export async function fetchWorkflowRuns(): Promise<WorkflowRunRecord[]> {
  const response = await requestJson<{ runs: WorkflowRunRecord[] }>('/api/workflow-runs');
  return response.runs;
}

export async function fetchWorkflowRunDetail(id: string): Promise<WorkflowRunDetail> {
  const response = await requestJson<{ detail: WorkflowRunDetail }>(
    `/api/workflow-runs/${encodeURIComponent(id)}`,
  );
  return response.detail;
}

export async function createWorkflowRun(request: CreateWorkflowRunRequest): Promise<WorkflowRunDetail> {
  const response = await requestJson<{ detail: WorkflowRunDetail }>('/api/workflow-runs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  return response.detail;
}

export async function sendWorkflowPlanningMessage(
  runId: string,
  message: string,
): Promise<WorkflowRunDetail> {
  const response = await requestJson<{ detail: WorkflowRunDetail }>(
    `/api/workflow-runs/${encodeURIComponent(runId)}/planning-message`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    },
  );
  return response.detail;
}

export async function answerWorkflowGate(args: {
  runId: string;
  gateId: string;
  optionId: string;
  message?: string;
}): Promise<WorkflowRunDetail> {
  const response = await requestJson<{ detail: WorkflowRunDetail }>(
    `/api/workflow-runs/${encodeURIComponent(args.runId)}/gates/${encodeURIComponent(args.gateId)}/answer`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        option_id: args.optionId,
        message: args.message,
      }),
    },
  );
  return response.detail;
}

export function openWorkflowRunEvents(runId: string) {
  return new EventSource(`/api/workflow-runs/${encodeURIComponent(runId)}/events`);
}

export function parseWorkflowRunStreamEvent(payload: string): WorkflowRunStreamEvent | null {
  try {
    return JSON.parse(payload) as WorkflowRunStreamEvent;
  } catch {
    return null;
  }
}
