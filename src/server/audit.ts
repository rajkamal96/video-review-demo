import { createHash } from 'node:crypto';
import type { Db } from './db.ts';

export interface AuditEvent {
  userId: string;
  videoId?: string;
  sessionId?: string;
  event: string;
  detail?: unknown;
}

const GENESIS = 'GENESIS';

const digest = (prev: string, ts: number, e: AuditEvent, detail: string) =>
  createHash('sha256')
    .update(prev)
    .update(JSON.stringify([ts, e.userId, e.videoId ?? null, e.sessionId ?? null, e.event, detail]))
    .digest('hex');

// Append-only, hash-chained: each row commits to the one before it, so editing
// or deleting a past row breaks every hash after it.
export function appendAudit(db: Db, now: number, e: AuditEvent): void {
  const last = db.prepare('SELECT hash FROM audit ORDER BY seq DESC LIMIT 1').get() as { hash: string } | undefined;
  const prev = last?.hash ?? GENESIS;
  const detail = JSON.stringify(e.detail ?? {});
  db.prepare(
    'INSERT INTO audit (ts, user_id, video_id, session_id, event, detail, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?)',
  ).run(now, e.userId, e.videoId ?? null, e.sessionId ?? null, e.event, detail, prev, digest(prev, now, e, detail));
}

export interface ChainCheck {
  ok: boolean;
  entries: number;
  brokenAtSeq?: number;
}

export function verifyChain(db: Db): ChainCheck {
  const rows = db.prepare('SELECT * FROM audit ORDER BY seq').all() as Array<Record<string, any>>;
  let prev = GENESIS;
  for (const r of rows) {
    const e: AuditEvent = { userId: r.user_id, videoId: r.video_id ?? undefined, sessionId: r.session_id ?? undefined, event: r.event };
    if (r.prev_hash !== prev || r.hash !== digest(prev, r.ts, e, r.detail)) {
      return { ok: false, entries: rows.length, brokenAtSeq: r.seq };
    }
    prev = r.hash;
  }
  return { ok: true, entries: rows.length };
}
