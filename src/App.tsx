import {
  startTransition,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import type { ChangeUnitDetail, ChangeUnitListItem } from '../shared/api.ts';
import { ChangeUnitSurface } from './components/ChangeUnitSurface.tsx';
import { HotkeyOverlay } from './components/HotkeyOverlay.tsx';
import { InboxRail } from './components/InboxRail.tsx';
import { SessionReplayPanel } from './components/SessionReplayPanel.tsx';
import { SessionWall } from './components/SessionWall.tsx';
import { ThemeSwitcher } from './components/ThemeSwitcher.tsx';
import {
  RequestError,
  fetchChangeUnitDetail,
  fetchChangeUnits,
  respondToLiveApproval,
} from './lib/api.ts';
import { getSidebarState } from './lib/format.ts';
import { orderSessions } from './lib/sessionOrder.ts';

type LiveSessionUpdates = {
  mode: 'idle' | 'events' | 'polling';
  threadId: string | null;
  eventCount: number;
  lastEventAt: string | null;
  lastMethod: string | null;
};

const REPLAY_PANE_STORAGE_KEY = 'inbox.replayPaneWidth';
const THEME_STORAGE_KEY = 'inbox.theme';
const DEFAULT_REPLAY_PANE_WIDTH = 420;
const MIN_REPLAY_PANE_WIDTH = 320;
const REPLAY_PANE_STEP = 48;
const THEMES = [
  {
    id: 'tokyo-night',
    label: 'Tokyo Night',
    description: 'Deep navy review cockpit with bright blue accents.',
  },
  {
    id: 'nord',
    label: 'Nord',
    description: 'Muted arctic contrast with cooler edges and calmer highlights.',
  },
  {
    id: 'catppuccin',
    label: 'Catppuccin',
    description: 'Warm dark surfaces with softer mauve and teal contrast.',
  },
  {
    id: 'pika-night',
    label: 'Pika Night',
    description: 'Dark editorial palette closer to a reading-first briefing.',
  },
] as const;
type ThemeId = (typeof THEMES)[number]['id'];

function clampReplayPaneWidth(width: number): number {
  const minWidth = MIN_REPLAY_PANE_WIDTH;
  const viewportWidth = typeof window === 'undefined' ? 1440 : window.innerWidth;
  const maxWidth = Math.max(minWidth, Math.min(960, Math.floor(viewportWidth * 0.72)));
  return Math.min(Math.max(Math.round(width), minWidth), maxWidth);
}

function readReplayPaneWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_REPLAY_PANE_WIDTH;

  const raw = window.localStorage.getItem(REPLAY_PANE_STORAGE_KEY);
  const parsed = raw ? Number(raw) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return clampReplayPaneWidth(DEFAULT_REPLAY_PANE_WIDTH);
  }

  return clampReplayPaneWidth(parsed);
}

function readSelectedChangeId(): string | null {
  return new URLSearchParams(window.location.search).get('change');
}

function isThemeId(value: string | null): value is ThemeId {
  return Boolean(value && THEMES.some((theme) => theme.id === value));
}

function readThemeId(): ThemeId {
  if (typeof window === 'undefined') return 'tokyo-night';
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return isThemeId(stored) ? stored : 'tokyo-night';
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

function hasReservedModifier(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey || event.altKey;
}

export function App() {
  const [items, setItems] = useState<ChangeUnitListItem[]>([]);
  const [detail, setDetail] = useState<ChangeUnitDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(() => readSelectedChangeId());
  const [themeId, setThemeId] = useState<ThemeId>(() => readThemeId());
  const [defaultChangeId, setDefaultChangeId] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const [preferredSessionId, setPreferredSessionId] = useState<string | null>(null);
  const [sessionWallOpen, setSessionWallOpen] = useState(false);
  const [replayPaneWidth, setReplayPaneWidth] = useState<number>(() => readReplayPaneWidth());
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [emptyMessage, setEmptyMessage] = useState<string | null>(null);
  const [approvalErrorMessage, setApprovalErrorMessage] = useState<string | null>(null);
  const [respondingApprovalIds, setRespondingApprovalIds] = useState<number[]>([]);
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
  const wallColumnRefs = useRef(new Map<string, HTMLDivElement>());
  const replayDragStateRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(
    null,
  );

  const mainQueueItems = useMemo(
    () => items.filter((item) => getSidebarState(item.status) !== 'landed'),
    [items],
  );
  const landedItems = useMemo(
    () => items.filter((item) => getSidebarState(item.status) === 'landed'),
    [items],
  );
  const currentDetail = useMemo(() => {
    if (!detail || !selectedId) return null;
    return detail.change_unit.id === selectedId ? detail : null;
  }, [detail, selectedId]);
  const orderedSessionIds = useMemo(
    () => (currentDetail ? orderSessions(currentDetail.session_views).map((session) => session.id) : []),
    [currentDetail],
  );
  const activeSessionId =
    orderedSessionIds.find((sessionId) => sessionId === preferredSessionId) ??
    orderedSessionIds[0] ??
    null;
  const appShellStyle = useMemo(
    () =>
      ({
        ['--replay-pane-width' as '--replay-pane-width']: `${replayPaneWidth}px`,
      }) as CSSProperties,
    [replayPaneWidth],
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
    window.localStorage.setItem(REPLAY_PANE_STORAGE_KEY, String(replayPaneWidth));
  }, [replayPaneWidth]);

  useEffect(() => {
    window.localStorage.setItem(THEME_STORAGE_KEY, themeId);
    document.documentElement.dataset.theme = themeId;
  }, [themeId]);

  useEffect(() => {
    const onResize = () => {
      setReplayPaneWidth((current) => clampReplayPaneWidth(current));
    };

    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const dragState = replayDragStateRef.current;
      if (!dragState) return;

      setReplayPaneWidth(clampReplayPaneWidth(dragState.startWidth + (dragState.startX - event.clientX)));
    };

    const stopDragging = (event: PointerEvent) => {
      const dragState = replayDragStateRef.current;
      if (!dragState) return;
      if (event.type !== 'pointercancel' && dragState.pointerId !== event.pointerId) return;

      replayDragStateRef.current = null;
      document.body.classList.remove('is-resizing-replay');
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stopDragging);
    window.addEventListener('pointercancel', stopDragging);

    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', stopDragging);
      window.removeEventListener('pointercancel', stopDragging);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target) && event.key !== 'Escape') return;
      if (hasReservedModifier(event)) return;

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

      if (event.key === 'Escape' && themePickerOpen) {
        event.preventDefault();
        setThemePickerOpen(false);
        return;
      }

      if (helpOpen || themePickerOpen) return;

      if (sessionWallOpen) {
        switch (event.key) {
          case 'Escape':
          case 'r':
            event.preventDefault();
            setSessionWallOpen(false);
            return;
          case 'h':
            event.preventDefault();
            moveSessionSelection(-1);
            return;
          case 'l':
            event.preventDefault();
            moveSessionSelection(1);
            return;
          case 'j':
            event.preventDefault();
            scrollActiveWallColumn(220);
            return;
          case 'k':
            event.preventDefault();
            scrollActiveWallColumn(-220);
            return;
          case 'g':
            event.preventDefault();
            jumpActiveWallColumn('top');
            return;
          case 'G':
            if (event.shiftKey) {
              event.preventDefault();
              jumpActiveWallColumn('bottom');
              return;
            }
            break;
        }
      }

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
        case 'r':
          event.preventDefault();
          setSessionWallOpen(true);
          break;
        case '[':
          event.preventDefault();
          moveSessionSelection(-1);
          break;
        case ']':
          event.preventDefault();
          moveSessionSelection(1);
          break;
        case 'H':
          if (event.shiftKey) {
            event.preventDefault();
            resizeReplayPane(-REPLAY_PANE_STEP);
          }
          break;
        case 'L':
          if (event.shiftKey) {
            event.preventDefault();
            resizeReplayPane(REPLAY_PANE_STEP);
          }
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    activeSessionId,
    helpOpen,
    mainQueueItems,
    orderedSessionIds,
    selectedId,
    sessionWallOpen,
    themePickerOpen,
  ]);

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

  function moveSessionSelection(delta: 1 | -1) {
    if (orderedSessionIds.length === 0) return;

    const currentIndex = activeSessionId ? orderedSessionIds.indexOf(activeSessionId) : -1;
    const startIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = (startIndex + delta + orderedSessionIds.length) % orderedSessionIds.length;
    setPreferredSessionId(orderedSessionIds[nextIndex]);
    if (sessionWallOpen) {
      wallColumnRefs.current.get(orderedSessionIds[nextIndex])?.focus();
      return;
    }

    replayPanelRef.current?.focus();
  }

  function resizeReplayPane(delta: number) {
    setReplayPaneWidth((current) => clampReplayPaneWidth(current + delta));
  }

  function scrollActiveWallColumn(delta: number) {
    if (!activeSessionId) return;
    wallColumnRefs.current.get(activeSessionId)?.scrollBy({ top: delta, behavior: 'smooth' });
  }

  function jumpActiveWallColumn(position: 'top' | 'bottom') {
    if (!activeSessionId) return;

    const node = wallColumnRefs.current.get(activeSessionId);
    if (!node) return;
    node.scrollTo({
      top: position === 'top' ? 0 : node.scrollHeight,
      behavior: 'smooth',
    });
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

  useEffect(() => {
    if (!currentDetail) {
      setPreferredSessionId(null);
      return;
    }

    const availableSessionIds = new Set(currentDetail.session_views.map((session) => session.id));
    const fallbackSessionId = currentDetail.live_session_id ?? orderedSessionIds[0] ?? null;

    setPreferredSessionId((current) => {
      if (current && availableSessionIds.has(current)) {
        return current;
      }

      return fallbackSessionId;
    });
  }, [
    currentDetail?.change_unit.id,
    currentDetail?.live_session_id,
    currentDetail?.session_views,
    orderedSessionIds,
  ]);

  useEffect(() => {
    if (!sessionWallOpen || !activeSessionId) return;
    wallColumnRefs.current.get(activeSessionId)?.focus();
  }, [activeSessionId, sessionWallOpen]);

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

  function startReplayResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (window.innerWidth <= 980) return;

    replayDragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: replayPaneWidth,
    };
    document.body.classList.add('is-resizing-replay');
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  async function refreshCurrentDetail() {
    if (!selectedId) return;
    await refreshDetail(selectedId);
  }

  async function handleApprovalResponse(
    threadId: string,
    requestId: number,
    decision: 'accept' | 'decline',
  ) {
    setApprovalErrorMessage(null);
    setRespondingApprovalIds((current) =>
      current.includes(requestId) ? current : [...current, requestId],
    );

    try {
      await respondToLiveApproval(threadId, requestId, decision);
      await refreshCurrentDetail();
    } catch (error) {
      setApprovalErrorMessage(
        error instanceof Error ? error.message : 'Failed to answer approval request.',
      );
    } finally {
      setRespondingApprovalIds((current) => current.filter((id) => id !== requestId));
    }
  }

  return (
    <>
      {sessionWallOpen && currentDetail ? (
        <SessionWall
          detail={currentDetail}
          activeSessionId={activeSessionId}
          liveSessionUpdates={liveSessionUpdates}
          onColumnRef={(sessionId, node) => {
            if (node) {
              wallColumnRefs.current.set(sessionId, node);
              return;
            }

            wallColumnRefs.current.delete(sessionId);
          }}
          onSelectSession={(sessionId) => setPreferredSessionId(sessionId)}
          onRespondApproval={handleApprovalResponse}
          respondingApprovalIds={respondingApprovalIds}
          approvalErrorMessage={approvalErrorMessage}
          onExit={() => setSessionWallOpen(false)}
        />
      ) : (
        <div
          className="app-shell"
          data-replay-pane-width={String(replayPaneWidth)}
          style={appShellStyle}
        >
          <div className="queue-column">
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
          </div>

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

          <div className="splitter-column">
            <div
              aria-controls="replay-panel"
              aria-label="Resize replay pane"
              aria-orientation="vertical"
              aria-valuemax={960}
              aria-valuemin={MIN_REPLAY_PANE_WIDTH}
              aria-valuenow={replayPaneWidth}
              className="replay-splitter"
              data-replay-splitter="true"
              onPointerDown={startReplayResize}
              role="separator"
            />
          </div>

          <div className="right-column">
            {loadingDetail && !currentDetail ? (
              <div className="empty-panel">
                <p>Loading replay…</p>
              </div>
            ) : currentDetail ? (
              <SessionReplayPanel
                detail={currentDetail}
                panelId="replay-panel"
                focusRef={replayPanelRef}
                preferredSessionId={activeSessionId}
                liveSessionUpdates={liveSessionUpdates}
                onSelectSession={(sessionId) => setPreferredSessionId(sessionId)}
                onRespondApproval={handleApprovalResponse}
                respondingApprovalIds={respondingApprovalIds}
                approvalErrorMessage={approvalErrorMessage}
              />
            ) : (
              <div className="empty-panel">
                <p>Replay will appear here for the selected change unit.</p>
              </div>
            )}
          </div>
        </div>
      )}

      {!sessionWallOpen ? (
        <>
          <ThemeSwitcher
            activeThemeId={themeId}
            open={themePickerOpen}
            themes={[...THEMES]}
            onSelect={(nextThemeId) => {
              setThemeId(nextThemeId as ThemeId);
              setThemePickerOpen(false);
            }}
            onToggle={() => setThemePickerOpen((current) => !current)}
          />

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
        </>
      ) : null}

      <HotkeyOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />
    </>
  );
}
