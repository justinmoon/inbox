import type { ChangeUnitListItem } from '../../shared/api.ts';
import { getSidebarState, getSidebarStateLabel } from '../lib/format.ts';

type InboxRailProps = {
  items: ChangeUnitListItem[];
  landedItems: ChangeUnitListItem[];
  selectedId: string | null;
  emptyMessage: string | null;
  onItemRef: (id: string, node: HTMLButtonElement | null) => void;
  onSelect: (id: string) => void;
};

export function InboxRail({
  items,
  landedItems,
  selectedId,
  emptyMessage,
  onItemRef,
  onSelect,
}: InboxRailProps) {
  return (
    <aside className="inbox-rail" aria-label="Change units">
      <div className="rail-header minimal-rail-header">
        <div>
          <p className="eyebrow">Units</p>
          <h1>Queue</h1>
        </div>
      </div>

      {items.length > 0 ? (
        <div className="queue-list" aria-label="Change unit inbox">
          {items.map((item) => {
            const selected = item.id === selectedId;
            const sidebarState = getSidebarState(item.status);

            return (
              <button
                key={item.id}
                ref={(node) => onItemRef(item.id, node)}
                className={`queue-card simple-queue-card${selected ? ' is-selected' : ''}`}
                onClick={() => onSelect(item.id)}
                type="button"
              >
                <span className={`simple-state simple-state-${sidebarState}`}>
                  {getSidebarStateLabel(item.status)}
                </span>
                <span className="simple-title">{item.title}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="rail-empty-state">
          <p>No queue items</p>
          <span>{emptyMessage ?? 'The canonical checkpoint did not load.'}</span>
        </div>
      )}

      {landedItems.length > 0 ? (
        <div className="landed-section">
          <p className="section-label">Landed</p>
          <div className="landed-list">
            {landedItems.map((item) => (
              <button
                key={item.id}
                ref={(node) => onItemRef(item.id, node)}
                className={`queue-card landed-queue-card${item.id === selectedId ? ' is-selected' : ''}`}
                onClick={() => onSelect(item.id)}
                type="button"
              >
                <span className="simple-title">{item.title}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </aside>
  );
}
