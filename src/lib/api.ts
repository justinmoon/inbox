import type { ChangeUnitDetail, ChangeUnitListItem } from '../../shared/api.ts';
import type {
  CreateLiveChangeUnitRequest,
  CreateLiveChangeUnitResponse,
} from '../../shared/liveChangeUnit.ts';

async function requestJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `Request failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function fetchChangeUnits(): Promise<ChangeUnitListItem[]> {
  const response = await requestJson<{ items: ChangeUnitListItem[] }>('/api/change-units');
  return response.items;
}

export async function fetchChangeUnitDetail(id: string): Promise<ChangeUnitDetail> {
  const response = await requestJson<{ detail: ChangeUnitDetail }>(`/api/change-units/${id}`);
  return response.detail;
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

export async function createLiveChangeUnit(
  input: CreateLiveChangeUnitRequest,
): Promise<CreateLiveChangeUnitResponse> {
  return await requestJson('/api/live/change-units', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function refreshSessionFromCodex(
  changeUnitId: string,
  sessionId: string,
): Promise<{
  refreshed: string;
  thread_id: string;
  codex_sync?: Record<string, unknown>;
}> {
  return await requestJson(`/api/change-units/${changeUnitId}/sessions/${sessionId}/refresh-codex`, {
    method: 'POST',
  });
}
