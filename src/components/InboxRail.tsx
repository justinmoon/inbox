import type { ChangeUnitListItem } from '../../shared/api.ts';
import { formatTimestamp, statusMeta, summarizeInbox, validationMeta } from '../lib/format.ts';

type InboxRailProps = {
  items: ChangeUnitListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenCreate: () => void;
  onReseed: () => void;
  reseeding: boolean;
};

export function InboxRail({ items, selectedId, onSelect, onOpenCreate, onReseed, reseeding }: InboxRailProps) {
  const counts = summarizeInbox(items);

  return (
    <aside className="inbox-rail">
      <div className="rail-header">
        <div>
          <p className="eyebrow">Queue</p>
          <h1>Inbox Control Room</h1>
          <p className="rail-copy">
            Review small multi-agent changes as coherent packets instead of chasing raw threads.
          </p>
        </div>
        <div className="rail-actions">
          <button className="solid-button" onClick={onOpenCreate} type="button">
            Create Live Packet
          </button>
          <button className="ghost-button" onClick={onReseed} disabled={reseeding} type="button">
            {reseeding ? 'Reseeding…' : 'Reseed Demo'}
          </button>
        </div>
      </div>

      <div className="queue-summary">
        <div className="summary-stat">
          <strong>{items.length}</strong>
          <span>queued change units</span>
        </div>
        <div className="summary-stat">
          <strong>{counts.awaiting_review + counts.needs_revision}</strong>
          <span>need attention</span>
        </div>
      </div>

      <div className="status-strip">
        {Object.entries(counts)
          .filter(([, count]) => count > 0)
          .map(([status, count]) => (
            <div key={status} className={`status-chip tone-${statusMeta[status as keyof typeof counts].tone}`}>
              <span>{statusMeta[status as keyof typeof counts].label}</span>
              <strong>{count}</strong>
            </div>
          ))}
      </div>

      <div className="queue-list" aria-label="Change unit inbox">
        {items.map((item) => {
          const selected = item.id === selectedId;
          return (
            <button
              key={item.id}
              className={`queue-card${selected ? ' is-selected' : ''}`}
              onClick={() => onSelect(item.id)}
              type="button"
            >
              <div className="queue-card-top">
                <span className={`status-pill tone-${statusMeta[item.status].tone}`}>
                  {statusMeta[item.status].label}
                </span>
                <span className="queue-score">attention {item.attention_score}</span>
              </div>

              <h2>{item.title}</h2>
              <p className="queue-summary-copy">{item.executive_summary}</p>

              <div className="queue-meta">
                <span>{item.project.name}</span>
                <span>{formatTimestamp(item.updated_at)}</span>
              </div>

              <div className="queue-tags">
                {item.tags.map((tag) => (
                  <span key={tag} className="meta-pill">
                    {tag}
                  </span>
                ))}
                {item.session_roles.map((role) => (
                  <span key={role} className="meta-pill role-pill">
                    {role.replaceAll('_', ' ')}
                  </span>
                ))}
              </div>

              <div className="queue-footer">
                <span>{item.session_count} linked sessions</span>
                <span className={`status-pill compact tone-${validationMeta[item.validation.state].tone}`}>
                  {validationMeta[item.validation.state].label}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
