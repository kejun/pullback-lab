import type Database from "better-sqlite3";
import type { ServerResponse } from "node:http";
import type {
  DecisionEventSummary,
  EventCounts,
  EventFeedBatch,
  EventPage,
} from "../../packages/contracts/index.js";

const immutableSummarySql = `json_object('id',e.id,'planId',json_extract(e.json,'$.planId'),
  'attemptId',e.attempt_id,'type',e.type,'time',json_extract(e.json,'$.time'),
  'receivedAt',json_extract(e.json,'$.receivedAt'),'message',json_extract(e.json,'$.message'),
  'reasons',json_extract(e.json,'$.reasons'),'quantity',json_extract(e.json,'$.quantity'),
  'historical',json_extract(e.json,'$.historical'))`;
const immutableRecordableSql = `(e.type='ENTRY_TRIGGERED' OR (e.type='HISTORICAL_TRIGGERED' AND json_extract(e.json,'$.historical')=1 AND json_extract(e.json,'$.snapshot.synthetic')=1))`;
/** Applied by the versioned migration, including existing notifications. */
export const EVENT_FEED_SCHEMA_SQL = `
  CREATE TABLE event_summaries(
    id TEXT PRIMARY KEY REFERENCES decision_events(id),
    seq INTEGER NOT NULL UNIQUE,
    json TEXT NOT NULL,
    synthetic INTEGER NOT NULL,
    recordable INTEGER NOT NULL
  );
  INSERT INTO event_summaries
    SELECT e.id,e.seq,${immutableSummarySql},coalesce(json_extract(e.json,'$.snapshot.synthetic')=1,0),coalesce(${immutableRecordableSql},0)
    FROM decision_events e JOIN notifications n ON n.event_id=e.id;
  CREATE TABLE event_feed_changes(
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL REFERENCES decision_events(id),
    kind TEXT NOT NULL CHECK(kind IN ('EVENT','READ','FEEDBACK'))
  );
  CREATE INDEX event_feed_by_event ON event_feed_changes(event_id,seq);
  INSERT INTO event_feed_changes(event_id,kind)
    SELECT e.id,'EVENT' FROM decision_events e JOIN notifications n ON n.event_id=e.id ORDER BY e.seq;
  INSERT OR IGNORE INTO settings(key,value) VALUES('event_feed_epoch',lower(hex(randomblob(16))));
  CREATE TRIGGER feed_notification_insert AFTER INSERT ON notifications
    BEGIN
      INSERT INTO event_summaries
        SELECT e.id,e.seq,${immutableSummarySql},coalesce(json_extract(e.json,'$.snapshot.synthetic')=1,0),coalesce(${immutableRecordableSql},0)
        FROM decision_events e WHERE e.id=NEW.event_id;
      INSERT INTO event_feed_changes(event_id,kind) VALUES(NEW.event_id,'EVENT');
    END;
  CREATE TRIGGER feed_read_insert AFTER INSERT ON notification_ack
    BEGIN INSERT INTO event_feed_changes(event_id,kind) VALUES(NEW.event_id,'READ'); END;
  CREATE TRIGGER feed_feedback_insert AFTER INSERT ON record_revisions
    BEGIN INSERT INTO event_feed_changes(event_id,kind) VALUES(NEW.event_id,'FEEDBACK'); END;
  CREATE TRIGGER event_summaries_immutable_update BEFORE UPDATE ON event_summaries
    BEGIN SELECT RAISE(ABORT,'event_summaries is append-only'); END;
  CREATE TRIGGER event_summaries_immutable_delete BEFORE DELETE ON event_summaries
    BEGIN SELECT RAISE(ABORT,'event_summaries is append-only'); END;
  CREATE TRIGGER event_summaries_immutable_replace BEFORE INSERT ON event_summaries
    WHEN EXISTS(SELECT 1 FROM event_summaries WHERE id=NEW.id OR seq=NEW.seq)
    BEGIN SELECT RAISE(ABORT,'event_summaries is append-only'); END;
  CREATE TRIGGER event_feed_immutable_update BEFORE UPDATE ON event_feed_changes
    BEGIN SELECT RAISE(ABORT,'event_feed_changes is append-only'); END;
  CREATE TRIGGER event_feed_immutable_delete BEFORE DELETE ON event_feed_changes
    BEGIN SELECT RAISE(ABORT,'event_feed_changes is append-only'); END;
  CREATE TRIGGER event_feed_immutable_replace BEFORE INSERT ON event_feed_changes
    WHEN EXISTS(SELECT 1 FROM event_feed_changes WHERE seq=NEW.seq)
    BEGIN SELECT RAISE(ABORT,'event_feed_changes is append-only'); END;
`;

export class EventCursorError extends Error {
  readonly statusCode = 409;
  readonly code = "CURSOR_EXPIRED";
  constructor() {
    super("事件游标不可用，请重新获取最新事件页后恢复连接");
  }
}

export const EVENT_PAGE_LIMIT = 50;
export const EVENT_STREAM_MAX_BYTES = 256_000;
const EVENT_STREAM_BATCH_LIMIT = 10;
export const EVENT_STREAM_MAX_BLOCKED_MS = 10_000;

type DB = Database.Database;
type CursorKind = "e1" | "f1";
const epoch = (db: DB): string =>
  (
    db
      .prepare("SELECT value FROM settings WHERE key='event_feed_epoch'")
      .get() as { value: string }
  ).value;
function cursor(db: DB, kind: CursorKind, seq: number): string {
  if (!seq) return `${kind}.${epoch(db)}.0.-`;
  const table = kind === "e1" ? "decision_events" : "event_feed_changes";
  const key = kind === "e1" ? "id" : "event_id";
  const row = db
    .prepare(`SELECT ${key} id FROM ${table} WHERE seq=?`)
    .get(seq) as { id: string } | undefined;
  if (!row) throw new EventCursorError();
  return `${kind}.${epoch(db)}.${seq}.${Buffer.from(row.id).toString("base64url")}`;
}
function cursorSeq(db: DB, value: string, kind: CursorKind): number {
  if (value.length > 300) throw new EventCursorError();
  const [prefix, token, number, id, extra] = value.split(".");
  if (
    prefix !== kind ||
    token !== epoch(db) ||
    extra !== undefined ||
    !/^(0|[1-9]\d*)$/.test(number ?? "")
  )
    throw new EventCursorError();
  const seq = Number(number);
  if (!Number.isSafeInteger(seq) || cursor(db, kind, seq) !== value || !id)
    throw new EventCursorError();
  return seq;
}
function maxFeed(db: DB): number {
  return (
    db
      .prepare("SELECT coalesce(max(seq),0) n FROM event_feed_changes")
      .get() as { n: number }
  ).n;
}
const recordableSql = "e.recordable=1";
const latestFeedbackSql = `(SELECT r.json FROM record_revisions r WHERE r.event_id=e.id ORDER BY r.rowid DESC LIMIT 1)`;
function counts(db: DB): EventCounts {
  const row = db
    .prepare(
      `SELECT count(*) total,
    coalesce(sum(a.event_id IS NULL),0) unread,
    coalesce(sum(${recordableSql} AND ${latestFeedbackSql} IS NULL),0) pending,
    coalesce(sum(json_extract(${latestFeedbackSql},'$.kind')='TAKEN'),0) taken,
    coalesce(sum(json_extract(${latestFeedbackSql},'$.kind')='SKIPPED'),0) skipped
    FROM event_summaries e LEFT JOIN notification_ack a ON a.event_id=e.id`,
    )
    .get() as EventCounts;
  return row;
}
function summaries(
  db: DB,
  where: string,
  args: (string | number)[],
  order: "ASC" | "DESC",
  limit: number,
): DecisionEventSummary[] {
  // JSON projection executes in SQLite: giant immutable snapshots never cross into
  // JavaScript or list/SSE responses. Full evidence remains available by event ID.
  const rows = db
    .prepare(
      `SELECT e.seq,
    coalesce((SELECT max(f.seq) FROM event_feed_changes f WHERE f.event_id=e.id),0) change_seq,
    e.json summary_json,
    e.synthetic,
    e.recordable,a.read_at,
    (SELECT r.id FROM record_revisions r WHERE r.event_id=e.id ORDER BY r.rowid DESC LIMIT 1) feedback_id,
    json_extract(${latestFeedbackSql},'$.kind') feedback
    FROM event_summaries e LEFT JOIN notification_ack a ON a.event_id=e.id
    WHERE ${where} ORDER BY e.seq ${order} LIMIT ?`,
    )
    .all(...args, limit) as {
    seq: number;
    change_seq: number;
    summary_json: string;
    synthetic: number | null;
    recordable: number;
    read_at: number | null;
    feedback_id: string | null;
    feedback: "TAKEN" | "SKIPPED" | null;
  }[];
  return rows.map((row) => {
    const summary = JSON.parse(row.summary_json) as DecisionEventSummary;
    return {
      ...summary,
      historical: Boolean(summary.historical),
      message: summary.message.slice(0, 1000),
      reasons: summary.reasons
        .slice(0, 10)
        .map((reason) => reason.slice(0, 150)),
      seq: row.seq,
      changeSeq: row.change_seq,
      synthetic: row.synthetic === 1,
      recordable: row.recordable === 1,
      read: row.read_at !== null,
      feedback: row.feedback,
      feedbackRevisionId: row.feedback_id,
    };
  });
}
export interface EventPageQuery {
  before?: string;
  after?: string;
  limit?: number;
}
export function eventPage(db: DB, query: EventPageQuery = {}): EventPage {
  return db.transaction(() => {
    const limit = query.limit ?? EVENT_PAGE_LIMIT;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > EVENT_PAGE_LIMIT ||
      (query.before && query.after)
    )
      throw new EventCursorError();
    const boundary = query.before ?? query.after;
    const seq = boundary ? cursorSeq(db, boundary, "e1") : undefined;
    const items = summaries(
      db,
      seq === undefined ? "1=1" : `e.seq${query.after ? ">" : "<"}?`,
      seq === undefined ? [] : [seq],
      query.after ? "ASC" : "DESC",
      limit + 1,
    );
    const events = items.slice(0, limit);
    const ids = events.map((item) => item.seq);
    const revision = maxFeed(db);
    return {
      events,
      beforeCursor: ids.length ? cursor(db, "e1", Math.min(...ids)) : null,
      afterCursor: ids.length ? cursor(db, "e1", Math.max(...ids)) : null,
      feedCursor: cursor(db, "f1", revision),
      feedEpoch: epoch(db),
      feedRevision: revision,
      hasMore: items.length > limit,
      counts: counts(db),
    };
  })();
}
export function eventFeed(db: DB, after?: string): EventFeedBatch {
  return db.transaction(() => {
    const seq = after ? cursorSeq(db, after, "f1") : 0;
    const changes = db
      .prepare(
        "SELECT seq,event_id FROM event_feed_changes WHERE seq>? ORDER BY seq LIMIT ?",
      )
      .all(seq, EVENT_STREAM_BATCH_LIMIT + 1) as {
      seq: number;
      event_id: string;
    }[];
    const page = changes.slice(0, EVENT_STREAM_BATCH_LIMIT);
    const ids = [...new Set(page.map((change) => change.event_id))];
    const events = ids.length
      ? summaries(
          db,
          `e.id IN (${ids.map(() => "?").join(",")})`,
          ids,
          "ASC",
          EVENT_STREAM_BATCH_LIMIT,
        )
      : [];
    const revision = page.at(-1)?.seq ?? seq;
    return {
      events,
      feedCursor: cursor(db, "f1", revision),
      feedEpoch: epoch(db),
      feedRevision: revision,
      hasMore: changes.length > EVENT_STREAM_BATCH_LIMIT,
      counts: counts(db),
    };
  })();
}

/** Stop producing as soon as Node applies backpressure; never queue another batch. */
export class BoundedEventWriter {
  private blockedAt: number | null = null;
  private closed = false;
  constructor(
    private response: Pick<
      ServerResponse,
      | "write"
      | "end"
      | "writableLength"
      | "writableNeedDrain"
      | "destroyed"
      | "destroy"
    >,
    private now = Date.now,
  ) {}
  get ready(): boolean {
    if (this.closed || this.response.destroyed) return false;
    if (
      this.response.writableLength > EVENT_STREAM_MAX_BYTES ||
      (this.blockedAt !== null &&
        this.now() - this.blockedAt >= EVENT_STREAM_MAX_BLOCKED_MS)
    ) {
      this.closed = true;
      this.response.destroy();
      return false;
    }
    if (this.response.writableNeedDrain) return false;
    this.blockedAt = null;
    return true;
  }
  write(frame: string): boolean {
    if (!this.ready) return false;
    if (
      Buffer.byteLength(frame) > EVENT_STREAM_MAX_BYTES ||
      this.response.writableLength + Buffer.byteLength(frame) >
        EVENT_STREAM_MAX_BYTES
    ) {
      this.closed = true;
      this.response.destroy();
      return false;
    }
    if (!this.response.write(frame)) this.blockedAt = this.now();
    // false from ServerResponse.write still means the frame was accepted once.
    return true;
  }
}
