import { startTransition, useEffect, useMemo, useRef, useState } from 'react';

import type { ChangeUnitDetail, ChangeUnitListItem } from '../shared/api.ts';
import { ChangeUnitSurface } from './components/ChangeUnitSurface.tsx';
import { HotkeyOverlay } from './components/HotkeyOverlay.tsx';
import { InboxRail } from './components/InboxRail.tsx';
import { SessionReplayPanel } from './components/SessionReplayPanel.tsx';
import { RequestError, fetchChangeUnitDetail, fetchChangeUnits } from './lib/api.ts';
import { getSidebarState } from './lib/format.ts';

type LiveSessionUpdates = {
  mode: 'idle' | 'events' | 'polling';
  threadId: string | null;
  eventCount: number;
  lastEventAt: string | null;
  lastMethod: string | null;
};

function readSelectedChangeId(): string | null {
  return new URLSearchParams(window.location.search).get('change');
}

function writeSelectedChangeId(id: string, replace = false) {
  const url = new URL(window.location.href);
  url.searchParams.set('change', id);
  const nextUrl = `${url.pathname}?${url.searchParams.toString()}${url.hash}`;

  if (replace) {
    window.history.replaceState(null, '', nextUrl);
    return;
  }

  window.history.pushState(null, '', nextUrl);
}

function clearSelectedChangeId(replace = false) {
  const url = new URL(window.location.href);
  url.searchParams.delete('change');
  const search = url.searchParams.toString();
  const nextUrl = `${url.pathname}${search ? `?${search}` : ''}${url.hash}`;

  if (replace) {
    window.history.replaceState(null, '', nextUrl);
    return;
  }

  window.history.pushState(null, '', nextUrl);
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;

  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  );
}

export function App() {
  const [items, setItems] = useState<ChangeUnitListItem[]>([]);
  const [detail, setDetail] = useState<ChangeUnitDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(() => readSelectedChangeId());
  const [defaultChangeId, setDefaultChangeId] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [preferredSessionId, setPreferredSessionId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [emptyMessage, setEmptyMessage] = useState<string | null>(null);
  const [liveSessionUpdates, setLiveSessionUpdates] = useState<LiveSessionUpdates>({
    mode: 'idle',
    threadId: null,
    eventCount: 0,
    lastEventAt: null,
    lastMethod: null,
  });
  const itemButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const mainReviewRef = useRef<HTMLElement | null>(null);
  const replayPanelRef = useRef<HTMLElement | null>(null);

  const mainQueueItems = useMemo(
    () => items.filter((item) => getSidebarState(item.status) !== 'landed'),
    [items],
  );
  const landedItems = useMemo(
    () => items.filter((item) => getSidebarState(item.status) === 'landed'),
    [items],
  );

  useEffect(() => {
    const onPopState = () => setSelectedId(readSelectedChangeId());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    void refreshList();
  }, []);

  useEffect(() => {
    if (loadingList) {
      return;
    }

    if (items.length === 0) {
      setDetail(null);
      if (selectedId) {
        startTransition(() => {
          setSelectedId(null);
          clearSelectedChangeId(true);
        });
      }
      return;
    }

    const fallbackId =
      defaultChangeId ?? mainQueueItems[0]?.id ?? landedItems[0]?.id ?? items[0]?.id ?? null;
    const selectionStillExists = selectedId ? items.some((item) => item.id === selectedId) : false;
    const nextId = selectionStillExists ? selectedId : fallbackId;

    if (!nextId) {
      setDetail(null);
      return;
    }

    if (nextId !== selectedId) {
      startTransition(() => {
        setSelectedId(nextId);
        if (selectedId) {
          writeSelectedChangeId(nextId, true);
        }
      });
      setErrorMessage(null);
      return;
    }

    void refreshDetail(nextId);
  }, [defaultChangeId, items, landedItems, loadingList, mainQueueItems, selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    itemButtonRefs.current.get(selectedId)?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target) && event.key !== 'Escape') return;

      if (event.key === '?' || (event.key === '/' && event.shiftKey)) {
        event.preventDefault();
        setHelpOpen((current) => !current);
        return;
      }

      if (event.key === 'Escape' && helpOpen) {
        event.preventDefault();
        setHelpOpen(false);
        return;
      }

      if (helpOpen) return;

      switch (event.key) {
        case 'j':
          event.preventDefault();
          moveSelection(1);
          break;
        case 'k':
          event.preventDefault();
          moveSelection(-1);
          break;
        case 'm':
          event.preventDefault();
          mainReviewRef.current?.focus();
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [helpOpen, mainQueueItems, selectedId]);

  function selectChangeUnit(id: string, replace = false) {
    startTransition(() => {
      setSelectedId(id);
      writeSelectedChangeId(id, replace);
    });
  }

  function moveSelection(delta: 1 | -1) {
    if (mainQueueItems.length === 0) return;

    const currentIndex = selectedId ? mainQueueItems.findIndex((item) => item.id === selectedId) : -1;
    const startIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = (startIndex + delta + mainQueueItems.length) % mainQueueItems.length;
    selectChangeUnit(mainQueueItems[nextIndex].id);
  }

  async function refreshList() {
    setLoadingList(true);
    setErrorMessage(null);

    try {
      const response = await fetchChangeUnits();
      setItems(response.items);
      setDefaultChangeId(response.default_change_id);
      setEmptyMessage(response.empty_message);
    } catch (error) {
      setItems([]);
      setDetail(null);
      setDefaultChangeId(null);
      setEmptyMessage(null);
      setErrorMessage(error instanceof Error ? error.message : 'Failed to load inbox.');
    } finally {
      setLoadingList(false);
    }
  }

  async function refreshDetail(id: string) {
    setLoadingDetail(true);

    try {
      const nextDetail = await fetchChangeUnitDetail(id);
      setDetail(nextDetail);
      setErrorMessage(null);
    } catch (error) {
      if (error instanceof RequestError && error.status === 404) {
        setDetail(null);
        setErrorMessage(null);
        const fallbackId = defaultChangeId ?? mainQueueItems[0]?.id ?? landedItems[0]?.id ?? null;
        if (fallbackId && fallbackId !== id) {
          startTransition(() => {
            setSelectedId(fallbackId);
            writeSelectedChangeId(fallbackId, true);
          });
        } else {
          void refreshList();
        }
      } else {
        setErrorMessage(error instanceof Error ? error.message : 'Failed to load change unit.');
      }
    } finally {
      setLoadingDetail(false);
    }
  }

  const currentDetail = useMemo(() => {
    if (!detail || !selectedId) return null;
    return detail.change_unit.id === selectedId ? detail : null;
  }, [detail, selectedId]);

  useEffect(() => {
    if (!currentDetail) {
      setPreferredSessionId(null);
      return;
    }

    const availableSessionIds = new Set(currentDetail.session_views.map((session) => session.id));
    const fallbackSessionId =
      currentDetail.live_session_id ?? currentDetail.session_views[0]?.id ?? null;

    setPreferredSessionId((current) => {
      if (current && availableSessionIds.has(current)) {
        return current;
      }

      return fallbackSessionId;
    });
  }, [currentDetail?.change_unit.id, currentDetail?.live_session_id, currentDetail?.session_views]);

  useEffect(() => {
    if (!currentDetail || currentDetail.execution_state.status !== 'launched') {
      setLiveSessionUpdates({
        mode: 'idle',
        threadId: null,
        eventCount: 0,
        lastEventAt: null,
        lastMethod: null,
      });
      return;
    }

    const threadId = currentDetail.execution_state.thread_id;
    const detailId = currentDetail.change_unit.id;
    let refreshTimer: number | null = null;
    let pollingTimer: number | null = null;
    let source: EventSource | null = null;
    let disposed = false;

    function scheduleRefresh() {
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }

      refreshTimer = window.setTimeout(() => {
        if (!disposed) {
          void refreshDetail(detailId);
        }
      }, 200);
    }

    function beginPolling() {
      setLiveSessionUpdates((current) => ({
        mode: 'polling',
        threadId,
        eventCount: current.threadId === threadId ? current.eventCount : 0,
        lastEventAt: current.threadId === threadId ? current.lastEventAt : null,
        lastMethod: current.threadId === threadId ? current.lastMethod : null,
      }));

      if (pollingTimer !== null) return;
      pollingTimer = window.setInterval(() => {
        void refreshDetail(detailId);
      }, 2000);
    }

    setLiveSessionUpdates({
      mode: 'events',
      threadId,
      eventCount: 0,
      lastEventAt: null,
      lastMethod: null,
    });

    if (typeof EventSource !== 'undefined') {
      source = new EventSource(`/api/live-sessions/${encodeURIComponent(threadId)}/events`);
      source.onopen = () => {
        if (disposed) return;
        setLiveSessionUpdates((current) => ({ ...current, mode: 'events', threadId }));
      };
      source.onmessage = (event) => {
        if (disposed) return;

        let method: string | null = null;
        try {
          const payload = JSON.parse(event.data) as { method?: unknown };
          method = typeof payload.method === 'string' ? payload.method : null;
        } catch {
          method = null;
        }

        if (method === 'live/connected') {
          setLiveSessionUpdates((current) => ({ ...current, mode: 'events', threadId }));
          return;
        }

        setLiveSessionUpdates((current) => ({
          mode: 'events',
          threadId,
          eventCount: current.threadId === threadId ? current.eventCount + 1 : 1,
          lastEventAt: new Date().toISOString(),
          lastMethod: method,
        }));
        scheduleRefresh();
      };
      source.onerror = () => {
        source?.close();
        source = null;
        if (!disposed) {
          beginPolling();
        }
      };
    } else {
      beginPolling();
    }

    return () => {
      disposed = true;
      source?.close();
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
      if (pollingTimer !== null) {
        window.clearInterval(pollingTimer);
      }
    };
  }, [
    currentDetail?.change_unit.id,
    currentDetail?.execution_state.status,
    currentDetail?.execution_state.status === 'launched'
      ? currentDetail.execution_state.thread_id
      : null,
  ]);

  function openLiveSession() {
    setPreferredSessionId(currentDetail?.live_session_id ?? null);
    replayPanelRef.current?.focus();
  }

  async function refreshCurrentDetail() {
    if (!selectedId) return;
    await refreshDetail(selectedId);
  }

  return (
    <>
      <div className="app-shell">
        <InboxRail
          items={mainQueueItems}
          landedItems={landedItems}
          selectedId={selectedId}
          emptyMessage={errorMessage ?? emptyMessage}
          onItemRef={(id, node) => {
            if (node) {
              itemButtonRefs.current.set(id, node);
              return;
            }
            itemButtonRefs.current.delete(id);
          }}
          onSelect={(id) => selectChangeUnit(id)}
        />

        <div className="main-column">
          {errorMessage ? (
            <div className="banner banner-error">
              <strong>Request failed.</strong>
              <span>{errorMessage}</span>
            </div>
          ) : null}

          {loadingList ? (
            <div className="empty-state">
              <h2>Loading inbox</h2>
              <p>Reading seeded and imported change units.</p>
            </div>
          ) : items.length === 0 ? (
            <div className="empty-state">
              <h2>No change units available</h2>
              <p>
                {errorMessage ??
                  emptyMessage ??
                  'No seeded or imported change units are available right now.'}
              </p>
            </div>
          ) : currentDetail ? (
            <ChangeUnitSurface
              detail={currentDetail}
              focusRef={mainReviewRef}
              onExecutionStateChange={() => refreshCurrentDetail()}
              onOpenLiveSession={() => openLiveSession()}
            />
          ) : (
            <div className="empty-state">
              <h2>Recovering selection</h2>
              <p>Switching to the canonical checkpoint for this session.</p>
            </div>
          )}
        </div>

        <div className="right-column">
          {loadingDetail && !currentDetail ? (
            <div className="empty-panel">
              <p>Loading replay…</p>
            </div>
          ) : currentDetail ? (
            <SessionReplayPanel
              detail={currentDetail}
              focusRef={replayPanelRef}
              preferredSessionId={preferredSessionId}
              liveSessionUpdates={liveSessionUpdates}
              onSelectSession={(sessionId) => setPreferredSessionId(sessionId)}
            />
          ) : (
            <div className="empty-panel">
              <p>Replay will appear here for the selected change unit.</p>
            </div>
          )}
        </div>
      </div>

      <button
        className="floating-help-button"
        aria-label="Open keyboard shortcuts help"
        aria-haspopup="dialog"
        aria-expanded={helpOpen}
        onClick={() => setHelpOpen(true)}
        type="button"
      >
        <span className="floating-help-glyph" aria-hidden="true">
          ?
        </span>
        <span>Keys</span>
      </button>

      <HotkeyOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />
    </>
  );
}
