// Off-by-default feedback sink — captures a thumbs up/down on each delivered
// plan together with the trace that produced it (the user turn, the final plan
// text, the tool calls, the model). This is NOT a session store: it persists
// nothing about conversations and carries no identity beyond an anonymous,
// client-generated id. Its single purpose is to close the evaluation loop —
// downvoted traces become candidate regression cases for the eval suite
// (see eval/feedback-report.ts and EVALUATION.md).
//
// Enabled ONLY when FEEDBACK_DB points at a SQLite file. Unset → a no-op store,
// so the core prototype stays dependency-free and the web UI shows no feedback
// controls. Storage is Node's built-in `node:sqlite` (no npm dependency); on a
// runtime without it (Node < 22.5) the factory degrades to the no-op store
// instead of failing — graceful degradation, same posture as the rest of the app.
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

// What the browser POSTs. The plan/tool trace is NOT trusted from the client —
// the server looks those up from its own per-turn buffer by turn_id, so a
// hostile client cannot forge what the system "said". Hence the submission
// carries only the rating, an optional reason, and the ids needed to join.
export const FeedbackSubmissionSchema = Type.Object({
  client_id: Type.String({ minLength: 1, maxLength: 128 }),
  turn_id: Type.String({ minLength: 1, maxLength: 128 }),
  rating: Type.Union([Type.Literal("up"), Type.Literal("down")]),
  comment: Type.Union([Type.String(), Type.Null()]),
});
export type FeedbackSubmission = Static<typeof FeedbackSubmissionSchema>;

// The server-side trace joined to a submission by turn_id (buffered in
// server.ts, never supplied by the client).
export interface TurnRecord {
  turn_text: string;
  plan_text: string;
  tool_calls: string[];
  model: string;
}

export interface FeedbackEntry extends FeedbackSubmission, TurnRecord {
  ts: string; // ISO 8601
}

export interface FeedbackStats {
  up: number;
  down: number;
  total: number;
}

const MAX_COMMENT = 1000;
// Bound stored trace size so a runaway plan can't bloat the DB row.
const MAX_TEXT = 20_000;

// Defensive normalization of the untrusted POST body, then schema enforcement —
// the same boundary discipline the intake gate applies to LLM output. Throws on
// an invalid rating or missing ids (the HTTP layer maps that to a 400); a junk
// comment is coerced to null rather than rejected.
export function normalizeSubmission(raw: any): FeedbackSubmission {
  const candidate: FeedbackSubmission = {
    client_id: typeof raw?.client_id === "string" ? raw.client_id.trim().slice(0, 128) : "",
    turn_id: typeof raw?.turn_id === "string" ? raw.turn_id.trim().slice(0, 128) : "",
    rating: raw?.rating === "up" || raw?.rating === "down" ? raw.rating : ("" as any),
    comment:
      typeof raw?.comment === "string" && raw.comment.trim() ? raw.comment.trim().slice(0, MAX_COMMENT) : null,
  };
  if (!Value.Check(FeedbackSubmissionSchema, candidate)) {
    const [first] = Value.Errors(FeedbackSubmissionSchema, candidate);
    throw new Error(`invalid feedback at ${first?.instancePath || "/"}: ${first?.message}`);
  }
  return candidate;
}

export interface FeedbackStore {
  readonly enabled: boolean;
  record(entry: FeedbackEntry): void;
  stats(): FeedbackStats;
  recent(limit: number): FeedbackEntry[];
  close(): void;
}

// Minimal structural view of node:sqlite, declared locally so the build does
// not depend on @types/node shipping these (they are recent and experimental).
interface SqliteStatement {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): any[];
}
interface SqliteDB {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

// No-op store used whenever feedback is disabled (FEEDBACK_DB unset) or the
// runtime lacks node:sqlite. The reason is surfaced by the factory's log line.
const nullStore = (): FeedbackStore => ({
  enabled: false,
  record: () => {},
  stats: () => ({ up: 0, down: 0, total: 0 }),
  recent: () => [],
  close: () => {},
});

class SqliteFeedbackStore implements FeedbackStore {
  readonly enabled = true;
  #db: SqliteDB;
  #insert: SqliteStatement;

  constructor(db: SqliteDB) {
    this.#db = db;
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS feedback (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        ts         TEXT NOT NULL,
        client_id  TEXT NOT NULL,
        turn_id    TEXT NOT NULL,
        rating     TEXT NOT NULL CHECK (rating IN ('up','down')),
        comment    TEXT,
        turn_text  TEXT,
        plan_text  TEXT,
        tool_calls TEXT,
        model      TEXT
      );
    `);
    this.#insert = this.#db.prepare(
      `INSERT INTO feedback (ts, client_id, turn_id, rating, comment, turn_text, plan_text, tool_calls, model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
  }

  record(entry: FeedbackEntry): void {
    this.#insert.run(
      entry.ts,
      entry.client_id,
      entry.turn_id,
      entry.rating,
      entry.comment,
      entry.turn_text.slice(0, MAX_TEXT),
      entry.plan_text.slice(0, MAX_TEXT),
      JSON.stringify(entry.tool_calls ?? []),
      entry.model,
    );
  }

  stats(): FeedbackStats {
    const rows = this.#db.prepare(`SELECT rating, COUNT(*) AS n FROM feedback GROUP BY rating`).all();
    const by: Record<string, number> = {};
    for (const r of rows) by[r.rating] = Number(r.n);
    const up = by.up ?? 0;
    const down = by.down ?? 0;
    return { up, down, total: up + down };
  }

  recent(limit: number): FeedbackEntry[] {
    const rows = this.#db
      .prepare(`SELECT * FROM feedback ORDER BY id DESC LIMIT ?`)
      .all(Math.max(1, Math.min(limit, 5000)));
    return rows.map((r) => ({
      ts: r.ts,
      client_id: r.client_id,
      turn_id: r.turn_id,
      rating: r.rating,
      comment: r.comment ?? null,
      turn_text: r.turn_text ?? "",
      plan_text: r.plan_text ?? "",
      tool_calls: safeParseArray(r.tool_calls),
      model: r.model ?? "",
    }));
  }

  close(): void {
    this.#db.close();
  }
}

function safeParseArray(s: unknown): string[] {
  if (typeof s !== "string") return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

// Factory. Async because node:sqlite is imported on demand — and only when
// feedback is actually enabled, so a disabled deployment never loads it.
export async function openFeedbackStore(dbPath: string | undefined): Promise<FeedbackStore> {
  if (!dbPath) {
    console.log("  feedback: disabled (set FEEDBACK_DB=<path> to capture thumbs up/down for the eval loop)");
    return nullStore();
  }
  try {
    const mod: any = await import("node:sqlite");
    const db: SqliteDB = new mod.DatabaseSync(dbPath);
    console.log(`  feedback: ENABLED → ${dbPath}`);
    return new SqliteFeedbackStore(db);
  } catch (err: any) {
    console.warn(
      `  feedback: requested (FEEDBACK_DB=${dbPath}) but node:sqlite is unavailable (${err.message}) — disabling. Needs Node 22.5+.`,
    );
    return nullStore();
  }
}