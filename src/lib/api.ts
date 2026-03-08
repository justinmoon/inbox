import type {
  ChangeUnitDetail,
  ChangeUnitListResponse,
  ExecuteNextActionResult,
  RespondApprovalResult,
} from '../../shared/api.ts';

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
