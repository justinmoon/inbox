import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import type {
  CodexFileChangeEntry,
  CodexThread,
  CodexThreadItem,
  CodexUserInput,
} from '../../shared/api.ts';

function humanizeToken(value: string): string {
  return value.replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2').replaceAll('_', ' ');
}

function titleCase(value: string): string {
  return humanizeToken(value).replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function stringifyUserContent(content: CodexUserInput[]): string {
  return content
    .map((item) => {
      if (item.type === 'text' && typeof item.text === 'string') return item.text;
      if (item.type === 'image' && typeof item.imageUrl === 'string') return `[image] ${item.imageUrl}`;
      if (typeof item.path === 'string') return `[${item.type}] ${item.path}`;
      if (typeof item.name === 'string') return `[${item.type}] ${item.name}`;
      return `[${item.type}]`;
    })
    .join('\n');
}

function stringifyUnknownArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => (typeof entry === 'string' ? entry : formatJson(entry)));
}

function summarizeCommandActions(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (entry && typeof entry === 'object') {
        const record = entry as Record<string, unknown>;
        return (
          (typeof record.kind === 'string' && titleCase(record.kind)) ||
          (typeof record.type === 'string' && titleCase(record.type)) ||
          formatJson(entry)
        );
      }
      return String(entry);
    })
    .join(' • ');
}

function renderPatchLines(diff: string) {
  return diff.split('\n').map((line, index) => {
    let className = 'thread-patch-line';
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git')) {
      className += ' thread-patch-line-meta';
    } else if (line.startsWith('@@')) {
      className += ' thread-patch-line-hunk';
    } else if (line.startsWith('+')) {
      className += ' thread-patch-line-add';
    } else if (line.startsWith('-')) {
      className += ' thread-patch-line-del';
    }

    return (
      <span key={`${index}-${line.slice(0, 24)}`} className={className}>
        {line || ' '}
      </span>
    );
  });
}

function renderFileChangeEntry(entry: CodexFileChangeEntry, index: number) {
  const hasHeader = entry.path || entry.kind;
  const hasDiff = typeof entry.diff === 'string' && entry.diff.trim();
  const hasNote = typeof entry.note === 'string' && entry.note.trim();

  return (
    <section key={`${entry.path ?? entry.kind ?? 'file'}-${index}`} className="thread-file-change-entry">
      {hasHeader ? (
        <header className="thread-file-change-header">
          <strong>{entry.path ?? 'Captured patch'}</strong>
          {entry.kind ? <span>{titleCase(entry.kind)}</span> : null}
        </header>
      ) : null}

      {hasNote ? <p className="thread-item-text thread-file-change-note">{entry.note}</p> : null}

      {hasDiff ? (
        <pre className="thread-code-block thread-patch-block">
          <code>{renderPatchLines(entry.diff!)}</code>
        </pre>
      ) : null}
    </section>
  );
}

function renderMetadataRows(entries: Array<[string, string | null | undefined]>) {
  const visibleEntries = entries.filter(([, value]) => value);
  if (visibleEntries.length === 0) return null;

  return (
    <dl className="thread-item-metadata">
      {visibleEntries.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ThreadItemBody({ item }: { item: CodexThreadItem }) {
  switch (item.type) {
    case 'userMessage': {
      const userItem = item as Extract<CodexThreadItem, { type: 'userMessage' }>;
      return (
        <div className="thread-item-body markdown-body thread-markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {stringifyUserContent(userItem.content)}
          </ReactMarkdown>
        </div>
      );
    }
    case 'agentMessage': {
      const agentItem = item as Extract<CodexThreadItem, { type: 'agentMessage' }>;
      return (
        <div className="thread-item-body markdown-body thread-markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{agentItem.text}</ReactMarkdown>
        </div>
      );
    }
    case 'plan': {
      const planItem = item as Extract<CodexThreadItem, { type: 'plan' }>;
      return (
        <div className="thread-item-body markdown-body thread-markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{planItem.text}</ReactMarkdown>
        </div>
      );
    }
    case 'reasoning': {
      const reasoningItem = item as Extract<CodexThreadItem, { type: 'reasoning' }>;
      const summary = stringifyUnknownArray(reasoningItem.summary);
      const content = stringifyUnknownArray(reasoningItem.content);

      return (
        <div className="thread-item-stack">
          {summary.length > 0 ? (
            <div className="thread-item-callout">
              <p className="thread-item-callout-label">Summary</p>
              <ul className="thread-inline-list">
                {summary.map((entry, index) => (
                  <li key={`${item.id}-summary-${index}`}>{entry}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {content.length > 0 ? (
            <pre className="thread-code-block">
              <code>{content.join('\n\n')}</code>
            </pre>
          ) : null}
        </div>
      );
    }
    case 'commandExecution': {
      const commandItem = item as Extract<CodexThreadItem, { type: 'commandExecution' }>;
      return (
        <div className="thread-item-stack">
          <pre className="thread-code-block">
            <code>{commandItem.command}</code>
          </pre>
          {renderMetadataRows([
            ['cwd', commandItem.cwd],
            ['status', commandItem.status],
            ['process', commandItem.processId ?? null],
            ['actions', summarizeCommandActions(commandItem.commandActions)],
            [
              'result',
              typeof commandItem.exitCode === 'number'
                ? `exit ${commandItem.exitCode}${typeof commandItem.durationMs === 'number' ? ` • ${commandItem.durationMs} ms` : ''}`
                : typeof commandItem.durationMs === 'number'
                  ? `${commandItem.durationMs} ms`
                  : null,
            ],
          ])}
          {commandItem.aggregatedOutput ? (
            <pre className="thread-code-block thread-command-output">
              <code>{commandItem.aggregatedOutput}</code>
            </pre>
          ) : null}
        </div>
      );
    }
    case 'fileChange': {
      const fileChangeItem = item as Extract<CodexThreadItem, { type: 'fileChange' }>;
      return (
        <div className="thread-item-stack">
          {renderMetadataRows([['status', fileChangeItem.status]])}
          <div className="thread-file-change-list">
            {fileChangeItem.changes.length > 0 ? (
              fileChangeItem.changes.map((entry, index) => renderFileChangeEntry(entry, index))
            ) : (
              <p className="thread-item-text">No structured file-change entries were captured.</p>
            )}
          </div>
          {fileChangeItem.rawOutput ? (
            <details className="thread-raw-details">
              <summary>Tool output</summary>
              <pre className="thread-code-block thread-command-output">
                <code>{fileChangeItem.rawOutput}</code>
              </pre>
            </details>
          ) : null}
        </div>
      );
    }
    case 'mcpToolCall': {
      const mcpItem = item as Extract<CodexThreadItem, { type: 'mcpToolCall' }>;
      return (
        <div className="thread-item-stack">
          {renderMetadataRows([
            ['server', mcpItem.server],
            ['tool', mcpItem.tool],
            ['status', mcpItem.status],
            ['duration', typeof mcpItem.durationMs === 'number' ? `${mcpItem.durationMs} ms` : null],
          ])}
          <pre className="thread-code-block">
            <code>{formatJson(mcpItem.arguments)}</code>
          </pre>
          {mcpItem.result ? (
            <pre className="thread-code-block">
              <code>{formatJson(mcpItem.result)}</code>
            </pre>
          ) : null}
          {mcpItem.error ? (
            <pre className="thread-code-block thread-code-error">
              <code>{formatJson(mcpItem.error)}</code>
            </pre>
          ) : null}
        </div>
      );
    }
    case 'dynamicToolCall': {
      const dynamicItem = item as Extract<CodexThreadItem, { type: 'dynamicToolCall' }>;
      return (
        <div className="thread-item-stack">
          {renderMetadataRows([
            ['tool', dynamicItem.tool],
            ['status', dynamicItem.status],
            ['success', typeof dynamicItem.success === 'boolean' ? String(dynamicItem.success) : null],
            ['duration', typeof dynamicItem.durationMs === 'number' ? `${dynamicItem.durationMs} ms` : null],
          ])}
          <pre className="thread-code-block">
            <code>{formatJson(dynamicItem.arguments)}</code>
          </pre>
          {Array.isArray(dynamicItem.contentItems) && dynamicItem.contentItems.length > 0 ? (
            <pre className="thread-code-block">
              <code>{formatJson(dynamicItem.contentItems)}</code>
            </pre>
          ) : null}
        </div>
      );
    }
    case 'collabAgentToolCall': {
      const collabItem = item as Extract<CodexThreadItem, { type: 'collabAgentToolCall' }>;
      return (
        <div className="thread-item-stack">
          {renderMetadataRows([
            ['tool', collabItem.tool],
            ['status', collabItem.status],
            ['sender', collabItem.senderThreadId],
            ['receivers', collabItem.receiverThreadIds.join(', ')],
          ])}
          {collabItem.prompt ? (
            <div className="thread-item-body markdown-body thread-markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{collabItem.prompt}</ReactMarkdown>
            </div>
          ) : null}
          {Object.keys(collabItem.agentsStates ?? {}).length > 0 ? (
            <pre className="thread-code-block">
              <code>{formatJson(collabItem.agentsStates)}</code>
            </pre>
          ) : null}
        </div>
      );
    }
    case 'webSearch': {
      const webSearchItem = item as Extract<CodexThreadItem, { type: 'webSearch' }>;
      return (
        <div className="thread-item-stack">
          {renderMetadataRows([['query', webSearchItem.query]])}
          {webSearchItem.action ? (
            <pre className="thread-code-block">
              <code>{formatJson(webSearchItem.action)}</code>
            </pre>
          ) : null}
        </div>
      );
    }
    case 'imageView': {
      const imageViewItem = item as Extract<CodexThreadItem, { type: 'imageView' }>;
      return renderMetadataRows([['path', imageViewItem.path]]);
    }
    case 'enteredReviewMode':
    case 'exitedReviewMode': {
      const reviewModeItem = item as Extract<
        CodexThreadItem,
        { type: 'enteredReviewMode' | 'exitedReviewMode' }
      >;
      return (
        <div className="thread-item-stack">
          {renderMetadataRows([
            ['mode', reviewModeItem.type === 'enteredReviewMode' ? 'entered' : 'exited'],
            ['review', reviewModeItem.review],
          ])}
        </div>
      );
    }
    case 'contextCompaction':
      return <p className="thread-item-text">Context was compacted for this thread.</p>;
    default:
      if (item.type === 'capturedRecord') {
        const fallbackItem = item as CodexThreadItem & {
          source?: unknown;
          rawType?: unknown;
          note?: unknown;
          payload?: unknown;
        };
        return (
          <div className="thread-item-stack">
            {renderMetadataRows([
              ['source', typeof fallbackItem.source === 'string' ? fallbackItem.source : 'captured'],
              ['raw type', typeof fallbackItem.rawType === 'string' ? fallbackItem.rawType : item.type],
            ])}
            {typeof fallbackItem.note === 'string' ? (
              <p className="thread-item-text">{fallbackItem.note}</p>
            ) : null}
            <pre className="thread-code-block">
              <code>{formatJson(fallbackItem.payload ?? fallbackItem)}</code>
            </pre>
          </div>
        );
      }

      return (
        <div className="thread-item-stack">
          <pre className="thread-code-block">
            <code>{formatJson(item)}</code>
          </pre>
        </div>
      );
  }
}

export function CodexThreadViewer({ thread }: { thread: CodexThread }) {
  return (
    <div className="codex-thread-viewer" data-thread-id={thread.id} data-thread-viewer-model="codex-native">
      {thread.turns.length > 0 ? (
        thread.turns.map((turn, index) => (
          <section key={turn.id} className="codex-turn">
            <header className="codex-turn-header">
              <div>
                <p className="section-label">Turn {index + 1}</p>
                <h4>{titleCase(turn.status || 'completed')}</h4>
              </div>
              <code className="turn-id">{turn.id}</code>
            </header>

            {turn.error ? (
              <pre className="thread-code-block thread-code-error">
                <code>{formatJson(turn.error)}</code>
              </pre>
            ) : null}

            <div className="codex-turn-items">
              {turn.items.map((item) => (
                <article
                  key={item.id}
                  className={`thread-item thread-item-${item.type}`}
                  data-item-type={item.type}
                >
                  <header className="thread-item-header">
                    <span className="thread-item-kind">{titleCase(item.type)}</span>
                    <code className="thread-item-id">{item.id}</code>
                  </header>
                  <ThreadItemBody item={item} />
                </article>
              ))}
            </div>
          </section>
        ))
      ) : (
        <div className="empty-panel inset-empty">
          <p>No Codex turns were persisted for this thread yet.</p>
        </div>
      )}
    </div>
  );
}
