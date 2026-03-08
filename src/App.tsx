import { startTransition, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import type { ChangeUnitDetail, ChangeUnitListItem } from '../shared/api.ts';
import type { CreateLiveChangeUnitRequest } from '../shared/liveChangeUnit.ts';
import {
  createLiveChangeUnit,
  fetchChangeUnitDetail,
  fetchChangeUnits,
  refreshSessionFromCodex,
  reseedDemo,
} from './lib/api.ts';
import { ChangeUnitSurface } from './components/ChangeUnitSurface.tsx';
import { CreateChangeUnitModal } from './components/CreateChangeUnitModal.tsx';
import { InboxRail } from './components/InboxRail.tsx';
import { SessionReplayPanel } from './components/SessionReplayPanel.tsx';

export function App() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [items, setItems] = useState<ChangeUnitListItem[]>([]);
  const [detail, setDetail] = useState<ChangeUnitDetail | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [refreshingSessionId, setRefreshingSessionId] = useState<string | null>(null);
  const [reseeding, setReseeding] = useState(false);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [creatingLivePacket, setCreatingLivePacket] = useState(false);
  const [createErrorMessage, setCreateErrorMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const selectedId = searchParams.get('change');

  useEffect(() => {
    void refreshList();
  }, []);

  useEffect(() => {
    if (items.length === 0) return;
    const nextId = selectedId ?? items[0]?.id ?? null;
    if (!nextId) return;
    if (!selectedId) {
      startTransition(() => {
        setSearchParams({ change: nextId }, { replace: true });
      });
      return;
    }
    void refreshDetail(nextId);
  }, [items, selectedId, setSearchParams]);

  async function refreshList() {
    setLoadingList(true);
    setErrorMessage(null);
    try {
      const nextItems = await fetchChangeUnits();
      setItems(nextItems);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to load inbox');
    } finally {
      setLoadingList(false);
    }
  }

  async function refreshDetail(id: string) {
    setLoadingDetail(true);
    setErrorMessage(null);
    try {
      setDetail(await fetchChangeUnitDetail(id));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to load change unit');
    } finally {
      setLoadingDetail(false);
    }
  }

  async function handleReseed() {
    setReseeding(true);
    setErrorMessage(null);
    try {
      await reseedDemo();
      const nextItems = await fetchChangeUnits();
      setItems(nextItems);
      const nextId = nextItems[0]?.id ?? null;
      if (nextId) {
        startTransition(() => {
          setSearchParams({ change: nextId }, { replace: true });
        });
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to reseed demo');
    } finally {
      setReseeding(false);
    }
  }

  async function handleRefreshFromCodex(sessionId: string) {
    if (!selectedId) return;
    setRefreshingSessionId(sessionId);
    try {
      await refreshSessionFromCodex(selectedId, sessionId);
      await refreshDetail(selectedId);
    } catch (error) {
      try {
        await refreshDetail(selectedId);
      } catch (refreshError) {
        setErrorMessage(
          refreshError instanceof Error ? refreshError.message : 'Failed to refresh session from Codex',
        );
      }
    } finally {
      setRefreshingSessionId(null);
    }
  }

  async function handleCreateLivePacket(input: CreateLiveChangeUnitRequest) {
    setCreatingLivePacket(true);
    setCreateErrorMessage(null);
    try {
      const response = await createLiveChangeUnit(input);
      const nextItems = await fetchChangeUnits();
      setItems(nextItems);
      setCreateModalOpen(false);
      startTransition(() => {
        setSearchParams({ change: response.imported });
      });
    } catch (error) {
      setCreateErrorMessage(error instanceof Error ? error.message : 'Failed to create live change unit');
    } finally {
      setCreatingLivePacket(false);
    }
  }

  const currentDetail = useMemo(() => {
    if (!detail) return null;
    if (selectedId && detail.change_unit.id !== selectedId) return null;
    return detail;
  }, [detail, selectedId]);

  const suggestedRepoPath =
    currentDetail?.project.worktree_path ?? items[0]?.project.worktree_path ?? '/Users/justin/code';

  return (
    <>
      <div className="app-shell">
        <InboxRail
          items={items}
          selectedId={selectedId}
          onSelect={(id) => {
            startTransition(() => {
              setSearchParams({ change: id });
            });
          }}
          onOpenCreate={() => setCreateModalOpen(true)}
          onReseed={() => void handleReseed()}
          reseeding={reseeding}
        />

        <div className="main-column">
          {errorMessage ? (
            <div className="banner banner-error">
              <strong>Loading failed.</strong>
              <span>{errorMessage}</span>
            </div>
          ) : null}

          {loadingList ? (
            <div className="empty-state">
              <h2>Loading inbox…</h2>
              <p>Reading persisted change units and assembling the queue.</p>
            </div>
          ) : currentDetail ? (
            <ChangeUnitSurface detail={currentDetail} />
          ) : (
            <div className="empty-state">
              <h2>No change unit selected</h2>
              <p>Pick a packet from the inbox to load the review surface.</p>
            </div>
          )}
        </div>

        <div className="right-column">
          {loadingDetail && !currentDetail ? (
            <div className="empty-panel">
              <p>Loading session replay…</p>
            </div>
          ) : currentDetail ? (
            <SessionReplayPanel
              detail={currentDetail}
              refreshingSessionId={refreshingSessionId}
              onRefreshFromCodex={(sessionId) => void handleRefreshFromCodex(sessionId)}
            />
          ) : (
            <div className="empty-panel">
              <p>Session replay will appear here once a change unit is selected.</p>
            </div>
          )}
        </div>
      </div>

      <CreateChangeUnitModal
        open={createModalOpen}
        pending={creatingLivePacket}
        errorMessage={createErrorMessage}
        suggestedRepoPath={suggestedRepoPath}
        onClose={() => {
          setCreateModalOpen(false);
          setCreateErrorMessage(null);
        }}
        onSubmit={(input) => void handleCreateLivePacket(input)}
      />
    </>
  );
}
