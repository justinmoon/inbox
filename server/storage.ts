import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import type { ChangeUnitDetail, ChangeUnitListItem, ReviewSummary } from '../shared/api.ts';
import type { ChangeUnitBundle, ReviewVerdict } from '../shared/changeUnitBundle.ts';

type ChangeUnitRow = {
  id: string;
  project_id: string;
  title: string;
  status: ChangeUnitBundle['change_unit']['status'];
  attention_score: number;
  tags_json: string;
  executive_summary: string;
  tutorial_markdown: string;
  next_prompt: string;
  diff_text: string;
  pr_json: string;
  validation_json: string;
  created_at: string;
  updated_at: string;
  project_name: string;
  project_worktree_path: string;
  project_repo_path: string;
  project_created_at: string;
};

type SessionRow = {
  id: string;
  change_unit_id: string;
  role: string;
  runtime: string;
  thread_id: string | null;
  status: string;
  summary: string | null;
  milestones_json: string;
  transcript_json: string;
  codex_sync_json: string | null;
  created_at: string;
  updated_at: string;
};

type SessionIdentityRow = {
  id: string;
  change_unit_id: string;
  role: string;
  runtime: string;
  thread_id: string | null;
  status: string;
  summary: string | null;
  milestones_json: string;
  transcript_json: string;
  codex_sync_json: string | null;
  created_at: string;
  updated_at: string;
};

type ArtifactRow = {
  id: string;
  change_unit_id: string;
  kind: string;
  label: string;
  path_or_blob_ref: string;
  metadata_json: string;
  created_at: string;
};

type VerdictRow = {
  id: string;
  change_unit_id: string;
  reviewer_role: string;
  verdict: ReviewVerdict;
  summary: string;
  details_markdown: string | null;
  created_at: string;
};

type ListRow = {
  id: string;
  title: string;
  status: ChangeUnitBundle['change_unit']['status'];
  attention_score: number;
  executive_summary: string;
  updated_at: string;
  created_at: string;
  tags_json: string;
  pr_json: string;
  validation_json: string;
  project_id: string;
  project_name: string;
  project_worktree_path: string;
  project_repo_path: string;
  session_count: number;
  session_roles: string | null;
  approve_count: number;
  needs_revision_count: number;
  comment_count: number;
  blocked_count: number;
};

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  return JSON.parse(raw) as T;
}

function emptyReviewSummary(): ReviewSummary {
  return {
    approve: 0,
    needs_revision: 0,
    comment: 0,
    blocked: 0,
  };
}

function statusRank(status: ChangeUnitBundle['change_unit']['status']): number {
  switch (status) {
    case 'awaiting_review':
      return 0;
    case 'needs_revision':
      return 1;
    case 'validating':
      return 2;
    case 'ready_to_land':
      return 3;
    case 'approved':
      return 4;
    case 'in_progress':
      return 5;
    case 'landed':
      return 6;
    default:
      return 99;
  }
}

export class InboxDatabase {
  readonly #db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.#db = new Database(dbPath);
    this.#db.pragma('journal_mode = WAL');
    this.#db.pragma('foreign_keys = ON');
    this.migrate();
  }

  migrate() {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS change_units (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        attention_score INTEGER NOT NULL,
        tags_json TEXT NOT NULL,
        executive_summary TEXT NOT NULL,
        tutorial_markdown TEXT NOT NULL,
        next_prompt TEXT NOT NULL,
        diff_text TEXT NOT NULL,
        pr_json TEXT NOT NULL,
        validation_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY,
        change_unit_id TEXT NOT NULL REFERENCES change_units(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        runtime TEXT NOT NULL,
        thread_id TEXT,
        status TEXT NOT NULL,
        summary TEXT,
        milestones_json TEXT NOT NULL,
        transcript_json TEXT NOT NULL,
        codex_sync_json TEXT NOT NULL DEFAULT '{"source":"bundle_import"}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        change_unit_id TEXT NOT NULL REFERENCES change_units(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        path_or_blob_ref TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS review_verdicts (
        id TEXT PRIMARY KEY,
        change_unit_id TEXT NOT NULL REFERENCES change_units(id) ON DELETE CASCADE,
        reviewer_role TEXT NOT NULL,
        verdict TEXT NOT NULL,
        summary TEXT NOT NULL,
        details_markdown TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_change_units_project_id ON change_units(project_id);
      CREATE INDEX IF NOT EXISTS idx_change_units_updated_at ON change_units(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_sessions_change_unit_id ON agent_sessions(change_unit_id);
      CREATE INDEX IF NOT EXISTS idx_review_verdicts_change_unit_id ON review_verdicts(change_unit_id);
      CREATE INDEX IF NOT EXISTS idx_artifacts_change_unit_id ON artifacts(change_unit_id);
    `);

    const agentSessionColumns = this.#db
      .prepare('PRAGMA table_info(agent_sessions)')
      .all() as Array<{ name: string }>;
    if (!agentSessionColumns.some((column) => column.name === 'codex_sync_json')) {
      this.#db.exec(
        `ALTER TABLE agent_sessions ADD COLUMN codex_sync_json TEXT NOT NULL DEFAULT '{"source":"bundle_import"}'`,
      );
    }
  }

  hasChangeUnits(): boolean {
    const row = this.#db.prepare('SELECT EXISTS(SELECT 1 FROM change_units) AS has_items').get() as {
      has_items: number;
    };
    return row.has_items === 1;
  }

  clearAll() {
    this.#db.exec(`
      DELETE FROM review_verdicts;
      DELETE FROM artifacts;
      DELETE FROM agent_sessions;
      DELETE FROM change_units;
      DELETE FROM projects;
    `);
  }

  importBundle(bundle: ChangeUnitBundle) {
    if (bundle.change_unit.project_id !== bundle.project.id) {
      throw new Error('change_unit.project_id must match project.id');
    }

    for (const session of bundle.agent_sessions) {
      if (session.change_unit_id !== bundle.change_unit.id) {
        throw new Error(`agent_session ${session.id} has mismatched change_unit_id`);
      }
    }

    for (const artifact of bundle.artifacts) {
      if (artifact.change_unit_id !== bundle.change_unit.id) {
        throw new Error(`artifact ${artifact.id} has mismatched change_unit_id`);
      }
    }

    for (const verdict of bundle.review_verdicts) {
      if (verdict.change_unit_id !== bundle.change_unit.id) {
        throw new Error(`review_verdict ${verdict.id} has mismatched change_unit_id`);
      }
    }

    const tx = this.#db.transaction((input: ChangeUnitBundle) => {
      this.#db
        .prepare(`
          INSERT INTO projects (id, name, worktree_path, repo_path, created_at)
          VALUES (@id, @name, @worktree_path, @repo_path, @created_at)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            worktree_path = excluded.worktree_path,
            repo_path = excluded.repo_path,
            created_at = excluded.created_at
        `)
        .run(input.project);

      this.#db
        .prepare(`
          INSERT INTO change_units (
            id, project_id, title, status, attention_score, tags_json, executive_summary,
            tutorial_markdown, next_prompt, diff_text, pr_json, validation_json, created_at, updated_at
          )
          VALUES (
            @id, @project_id, @title, @status, @attention_score, @tags_json, @executive_summary,
            @tutorial_markdown, @next_prompt, @diff_text, @pr_json, @validation_json, @created_at, @updated_at
          )
          ON CONFLICT(id) DO UPDATE SET
            project_id = excluded.project_id,
            title = excluded.title,
            status = excluded.status,
            attention_score = excluded.attention_score,
            tags_json = excluded.tags_json,
            executive_summary = excluded.executive_summary,
            tutorial_markdown = excluded.tutorial_markdown,
            next_prompt = excluded.next_prompt,
            diff_text = excluded.diff_text,
            pr_json = excluded.pr_json,
            validation_json = excluded.validation_json,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at
        `)
        .run({
          ...input.change_unit,
          tags_json: JSON.stringify(input.change_unit.tags),
          pr_json: JSON.stringify(input.change_unit.pr),
          validation_json: JSON.stringify(input.change_unit.validation),
        });

      this.#db.prepare('DELETE FROM agent_sessions WHERE change_unit_id = ?').run(input.change_unit.id);
      this.#db.prepare('DELETE FROM artifacts WHERE change_unit_id = ?').run(input.change_unit.id);
      this.#db.prepare('DELETE FROM review_verdicts WHERE change_unit_id = ?').run(input.change_unit.id);

      const insertSession = this.#db.prepare(`
        INSERT INTO agent_sessions (
          id, change_unit_id, role, runtime, thread_id, status, summary,
          milestones_json, transcript_json, codex_sync_json, created_at, updated_at
        )
        VALUES (
          @id, @change_unit_id, @role, @runtime, @thread_id, @status, @summary,
          @milestones_json, @transcript_json, @codex_sync_json, @created_at, @updated_at
        )
      `);

      for (const session of input.agent_sessions) {
        insertSession.run({
          ...session,
          milestones_json: JSON.stringify(session.milestones),
          transcript_json: JSON.stringify(session.transcript),
          codex_sync_json: JSON.stringify(session.codex_sync),
          summary: session.summary ?? null,
        });
      }

      const insertArtifact = this.#db.prepare(`
        INSERT INTO artifacts (id, change_unit_id, kind, label, path_or_blob_ref, metadata_json, created_at)
        VALUES (@id, @change_unit_id, @kind, @label, @path_or_blob_ref, @metadata_json, @created_at)
      `);

      for (const artifact of input.artifacts) {
        insertArtifact.run({
          ...artifact,
          metadata_json: JSON.stringify(artifact.metadata),
        });
      }

      const insertVerdict = this.#db.prepare(`
        INSERT INTO review_verdicts (
          id, change_unit_id, reviewer_role, verdict, summary, details_markdown, created_at
        )
        VALUES (@id, @change_unit_id, @reviewer_role, @verdict, @summary, @details_markdown, @created_at)
      `);

      for (const verdict of input.review_verdicts) {
        insertVerdict.run({
          ...verdict,
          details_markdown: verdict.details_markdown ?? null,
        });
      }
    });

    tx(bundle);
  }

  listChangeUnits(): ChangeUnitListItem[] {
    const rows = this.#db
      .prepare(`
        SELECT
          cu.id,
          cu.title,
          cu.status,
          cu.attention_score,
          cu.executive_summary,
          cu.updated_at,
          cu.created_at,
          cu.tags_json,
          cu.pr_json,
          cu.validation_json,
          cu.project_id,
          p.name AS project_name,
          p.worktree_path AS project_worktree_path,
          p.repo_path AS project_repo_path,
          COALESCE(session_counts.session_count, 0) AS session_count,
          session_counts.session_roles AS session_roles,
          COALESCE(verdict_counts.approve_count, 0) AS approve_count,
          COALESCE(verdict_counts.needs_revision_count, 0) AS needs_revision_count,
          COALESCE(verdict_counts.comment_count, 0) AS comment_count,
          COALESCE(verdict_counts.blocked_count, 0) AS blocked_count
        FROM change_units cu
        JOIN projects p ON p.id = cu.project_id
        LEFT JOIN (
          SELECT
            change_unit_id,
            COUNT(*) AS session_count,
            GROUP_CONCAT(role) AS session_roles
          FROM agent_sessions
          GROUP BY change_unit_id
        ) AS session_counts ON session_counts.change_unit_id = cu.id
        LEFT JOIN (
          SELECT
            change_unit_id,
            SUM(CASE WHEN verdict = 'approve' THEN 1 ELSE 0 END) AS approve_count,
            SUM(CASE WHEN verdict = 'needs_revision' THEN 1 ELSE 0 END) AS needs_revision_count,
            SUM(CASE WHEN verdict = 'comment' THEN 1 ELSE 0 END) AS comment_count,
            SUM(CASE WHEN verdict = 'blocked' THEN 1 ELSE 0 END) AS blocked_count
          FROM review_verdicts
          GROUP BY change_unit_id
        ) AS verdict_counts ON verdict_counts.change_unit_id = cu.id
      `)
      .all() as ListRow[];

    return rows
      .sort((a, b) => {
        const rankDelta = statusRank(a.status) - statusRank(b.status);
        if (rankDelta !== 0) return rankDelta;
        if (a.attention_score !== b.attention_score) return b.attention_score - a.attention_score;
        return b.updated_at.localeCompare(a.updated_at);
      })
      .map((row) => ({
        id: row.id,
        title: row.title,
        status: row.status,
        attention_score: row.attention_score,
        executive_summary: row.executive_summary,
        updated_at: row.updated_at,
        created_at: row.created_at,
        tags: parseJson(row.tags_json, []),
        session_count: row.session_count,
        session_roles: row.session_roles ? row.session_roles.split(',').filter(Boolean) : [],
        project: {
          id: row.project_id,
          name: row.project_name,
          worktree_path: row.project_worktree_path,
          repo_path: row.project_repo_path,
        },
        pr: parseJson(row.pr_json, {
          number: null,
          status: 'unlinked',
          url: null,
          branch_name: null,
        }),
        validation: parseJson(row.validation_json, {
          state: 'not_run',
          summary: 'Validation has not started yet.',
        }),
        review_summary: {
          approve: row.approve_count,
          needs_revision: row.needs_revision_count,
          comment: row.comment_count,
          blocked: row.blocked_count,
        },
      }));
  }

  getChangeUnitDetail(id: string): ChangeUnitDetail | null {
    const row = this.#db
      .prepare(`
        SELECT
          cu.*,
          p.name AS project_name,
          p.worktree_path AS project_worktree_path,
          p.repo_path AS project_repo_path,
          p.created_at AS project_created_at
        FROM change_units cu
        JOIN projects p ON p.id = cu.project_id
        WHERE cu.id = ?
      `)
      .get(id) as ChangeUnitRow | undefined;

    if (!row) return null;

    const sessions = this.#db
      .prepare(`
        SELECT *
        FROM agent_sessions
        WHERE change_unit_id = ?
        ORDER BY created_at ASC, id ASC
      `)
      .all(id) as SessionRow[];

    const artifacts = this.#db
      .prepare(`
        SELECT *
        FROM artifacts
        WHERE change_unit_id = ?
        ORDER BY created_at ASC, id ASC
      `)
      .all(id) as ArtifactRow[];

    const verdicts = this.#db
      .prepare(`
        SELECT *
        FROM review_verdicts
        WHERE change_unit_id = ?
        ORDER BY created_at ASC, id ASC
      `)
      .all(id) as VerdictRow[];

    return {
      bundle_version: 1,
      project: {
        id: row.project_id,
        name: row.project_name,
        worktree_path: row.project_worktree_path,
        repo_path: row.project_repo_path,
        created_at: row.project_created_at,
      },
      change_unit: {
        id: row.id,
        project_id: row.project_id,
        title: row.title,
        status: row.status,
        attention_score: row.attention_score,
        tags: parseJson(row.tags_json, []),
        executive_summary: row.executive_summary,
        tutorial_markdown: row.tutorial_markdown,
        next_prompt: row.next_prompt,
        diff_text: row.diff_text,
        pr: parseJson(row.pr_json, {
          number: null,
          status: 'unlinked',
          url: null,
          branch_name: null,
        }),
        validation: parseJson(row.validation_json, {
          state: 'not_run',
          summary: 'Validation has not started yet.',
          checks: [],
        }),
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
      agent_sessions: sessions.map((session) => ({
        id: session.id,
        change_unit_id: session.change_unit_id,
        role: session.role,
        runtime: session.runtime,
        thread_id: session.thread_id,
        status: session.status,
        summary: session.summary ?? undefined,
        milestones: parseJson(session.milestones_json, []),
        transcript: parseJson(session.transcript_json, { turns: [] }),
        codex_sync: parseJson(session.codex_sync_json, { source: 'bundle_import' }),
        created_at: session.created_at,
        updated_at: session.updated_at,
      })),
      artifacts: artifacts.map((artifact) => ({
        id: artifact.id,
        change_unit_id: artifact.change_unit_id,
        kind: artifact.kind,
        label: artifact.label,
        path_or_blob_ref: artifact.path_or_blob_ref,
        metadata: parseJson(artifact.metadata_json, {}),
        created_at: artifact.created_at,
      })),
      review_verdicts: verdicts.map((verdict) => ({
        id: verdict.id,
        change_unit_id: verdict.change_unit_id,
        reviewer_role: verdict.reviewer_role,
        verdict: verdict.verdict,
        summary: verdict.summary,
        details_markdown: verdict.details_markdown ?? undefined,
        created_at: verdict.created_at,
      })),
    };
  }

  getAgentSession(id: string): ChangeUnitDetail['agent_sessions'][number] | null {
    const row = this.#db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(id) as
      | SessionIdentityRow
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      change_unit_id: row.change_unit_id,
      role: row.role,
      runtime: row.runtime,
      thread_id: row.thread_id,
      status: row.status,
      summary: row.summary ?? undefined,
      milestones: parseJson(row.milestones_json, []),
      transcript: parseJson(row.transcript_json, { turns: [] }),
      codex_sync: parseJson(row.codex_sync_json, { source: 'bundle_import' }),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  updateAgentSessionFromCodex(
    id: string,
    update: {
      status: string;
      summary: string;
      transcript: unknown;
      codex_sync: unknown;
      updated_at: string;
    },
  ) {
    this.#db
      .prepare(`
        UPDATE agent_sessions
        SET status = @status,
            summary = @summary,
            transcript_json = @transcript_json,
            codex_sync_json = @codex_sync_json,
            updated_at = @updated_at
        WHERE id = @id
      `)
      .run({
        id,
        status: update.status,
        summary: update.summary,
        transcript_json: JSON.stringify(update.transcript),
        codex_sync_json: JSON.stringify(update.codex_sync),
        updated_at: update.updated_at,
      });
  }

  recordAgentSessionCodexRefreshFailure(
    id: string,
    update: {
      codex_sync: unknown;
      updated_at: string;
    },
  ) {
    this.#db
      .prepare(`
        UPDATE agent_sessions
        SET codex_sync_json = @codex_sync_json,
            updated_at = @updated_at
        WHERE id = @id
      `)
      .run({
        id,
        codex_sync_json: JSON.stringify(update.codex_sync),
        updated_at: update.updated_at,
      });
  }
}
