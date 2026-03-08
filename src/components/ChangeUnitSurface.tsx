import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import type { ChangeUnitDetail } from '../../shared/api.ts';
import { formatLongTimestamp, reviewVerdictMeta, statusMeta, validationMeta } from '../lib/format.ts';
import { DiffViewer } from './DiffViewer.tsx';

type ChangeUnitSurfaceProps = {
  detail: ChangeUnitDetail;
};

function VerdictSummary({ detail }: { detail: ChangeUnitDetail }) {
  return (
    <div className="verdict-summary-grid">
      {detail.review_verdicts.map((verdict) => (
        <article key={verdict.id} className={`verdict-summary tone-${reviewVerdictMeta[verdict.verdict].tone}`}>
          <div>
            <p className="section-label">{verdict.reviewer_role.replaceAll('_', ' ')}</p>
            <h4>{reviewVerdictMeta[verdict.verdict].label}</h4>
          </div>
          <p>{verdict.summary}</p>
        </article>
      ))}
    </div>
  );
}

export function ChangeUnitSurface({ detail }: ChangeUnitSurfaceProps) {
  const { change_unit: changeUnit } = detail;

  return (
    <main className="review-surface">
      <section className="hero-card">
        <div className="hero-heading">
          <div>
            <p className="eyebrow">Review Surface</p>
            <h2>{changeUnit.title}</h2>
            <p className="hero-meta">
              {detail.project.name} · updated {formatLongTimestamp(changeUnit.updated_at)} ·{' '}
              {detail.project.worktree_path}
            </p>
          </div>
          <div className="hero-statuses">
            <span className={`status-pill tone-${statusMeta[changeUnit.status].tone}`}>
              {statusMeta[changeUnit.status].label}
            </span>
            <span className={`status-pill tone-${validationMeta[changeUnit.validation.state].tone}`}>
              {validationMeta[changeUnit.validation.state].label}
            </span>
          </div>
        </div>

        <p className="hero-summary">{changeUnit.executive_summary}</p>

        <div className="hero-tags">
          {changeUnit.tags.map((tag) => (
            <span key={tag} className="meta-pill">
              {tag}
            </span>
          ))}
          {changeUnit.pr.branch_name ? <span className="meta-pill">{changeUnit.pr.branch_name}</span> : null}
        </div>
      </section>

      <section className="status-board">
        <article className="section-card status-card">
          <p className="section-label">PR</p>
          <h3>{changeUnit.pr.status}</h3>
          <p>{changeUnit.pr.number ? `PR #${changeUnit.pr.number}` : 'No live PR linked yet.'}</p>
          {changeUnit.pr.url ? (
            <a href={changeUnit.pr.url} target="_blank" rel="noreferrer">
              Open PR
            </a>
          ) : null}
        </article>

        <article className="section-card status-card">
          <p className="section-label">Validation</p>
          <h3>{changeUnit.validation.summary}</h3>
          <ul className="check-list">
            {changeUnit.validation.checks.map((check) => (
              <li key={check.id}>
                <span className={`status-pill compact tone-${validationMeta[check.state].tone}`}>
                  {validationMeta[check.state].label}
                </span>
                <div>
                  <strong>{check.label}</strong>
                  <p>{check.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        </article>

        <article className="section-card status-card">
          <p className="section-label">Next Proposed Chunk</p>
          <h3>Ready to hand off</h3>
          <pre className="prompt-block">{changeUnit.next_prompt}</pre>
        </article>
      </section>

      {detail.review_verdicts.length > 0 ? (
        <section className="section-card">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Review verdicts</p>
              <h3>Safety and landing posture</h3>
            </div>
          </div>
          <VerdictSummary detail={detail} />
        </section>
      ) : null}

      <section className="section-card narrative-card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Tutorial</p>
            <h3>What changed and how to review it</h3>
          </div>
        </div>
        <div className="markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{changeUnit.tutorial_markdown}</ReactMarkdown>
        </div>
      </section>

      {detail.artifacts.length > 0 ? (
        <section className="section-card">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Artifacts</p>
              <h3>Attached references</h3>
            </div>
          </div>
          <div className="artifact-grid">
            {detail.artifacts.map((artifact) => (
              <article key={artifact.id} className="artifact-card">
                <p className="section-label">{artifact.kind}</p>
                <strong>{artifact.label}</strong>
                <code>{artifact.path_or_blob_ref}</code>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <section className="section-card diff-card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Diff</p>
            <h3>Code changes</h3>
          </div>
        </div>
        <DiffViewer diffText={changeUnit.diff_text} />
      </section>
    </main>
  );
}
