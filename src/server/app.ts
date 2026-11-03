import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { appendAudit, verifyChain } from './audit.ts';
import { makeToken, readToken, verifyPassword } from './auth.ts';
import type { Db } from './db.ts';
import { applyBeat, evaluateCompletion, newTrackState, type Beat, type TrackState } from './tracking.ts';

export interface AppOptions {
  db: Db;
  secret: string;
  mediaDir: string;
  webDir?: string;
  now?: () => number;
  secureCookies?: boolean;
}

interface User { id: string; name: string; role: 'admin' | 'reviewer' }
interface VideoRow { id: string; title: string; file: string; thumb: string; duration: number }
interface SessionRow {
  id: string; user_id: string; video_id: string; started_at: number; last_beat_at: number; last_pos: number;
  watched: number; covered: string; anomalies: number; status: 'active' | 'completed' | 'incomplete'; ended_at: number | null;
}

const SESSION_TTL_MS = 8 * 3600_000;
const MEDIA_TTL_MS = 15 * 60_000;
const STALE_MS = 30_000; // an "active" session silent this long is reported as incomplete
const csvCell = (v: unknown) => `"${String(v ?? '').replaceAll('"', '""')}"`;

export function buildApp(opts: AppOptions) {
  const { db, secret, mediaDir } = opts;
  const now = opts.now ?? Date.now;
  const app = Fastify({ trustProxy: true });
  app.register(cookie);
  // Accept an empty JSON body (e.g. POST /start) instead of rejecting it; bad JSON is still a 400.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch {
      done(Object.assign(new Error('invalid_json'), { statusCode: 400 }), undefined);
    }
  });
  app.register(fastifyStatic, { root: mediaDir, serve: false });
  if (opts.webDir && existsSync(opts.webDir)) {
    app.register(fastifyStatic, { root: opts.webDir, prefix: '/', decorateReply: false });
  }

  const getUser = (id: string) => db.prepare('SELECT id, name, role FROM users WHERE id = ?').get(id) as User | undefined;
  const getVideo = (id: string) => db.prepare('SELECT * FROM videos WHERE id = ?').get(id) as VideoRow | undefined;
  const isAssigned = (userId: string, videoId: string) =>
    !!db.prepare('SELECT 1 FROM assignments WHERE user_id = ? AND video_id = ?').get(userId, videoId);

  function currentUser(req: FastifyRequest): User | null {
    const id = readToken(secret, req.cookies.auth, now());
    return id ? (getUser(id) ?? null) : null;
  }
  const requireUser = (req: FastifyRequest, reply: FastifyReply): User | null => {
    const user = currentUser(req);
    if (!user) reply.code(401).send({ error: 'not_signed_in' });
    return user;
  };
  const requireAdmin = (req: FastifyRequest, reply: FastifyReply): User | null => {
    const user = requireUser(req, reply);
    if (user && user.role !== 'admin') {
      reply.code(403).send({ error: 'admin_only' });
      return null;
    }
    return user;
  };

  const loadTrack = (s: SessionRow): TrackState => ({
    lastBeatAt: s.last_beat_at, lastPos: s.last_pos, watched: s.watched, covered: JSON.parse(s.covered), anomalies: s.anomalies,
  });
  const saveTrack = (id: string, t: TrackState) =>
    db.prepare('UPDATE sessions SET last_beat_at=?, last_pos=?, watched=?, covered=?, anomalies=? WHERE id=?')
      .run(t.lastBeatAt, t.lastPos, t.watched, JSON.stringify(t.covered), t.anomalies, id);

  // The caller must own the session and it must still be running.
  function ownedActiveSession(req: FastifyRequest, reply: FastifyReply, user: User) {
    const s = db.prepare('SELECT * FROM sessions WHERE id = ?').get((req.params as { id: string }).id) as SessionRow | undefined;
    if (!s || s.user_id !== user.id) {
      reply.code(404).send({ error: 'no_such_session' });
      return null;
    }
    if (s.status !== 'active') {
      reply.code(409).send({ error: 'session_closed', status: s.status });
      return null;
    }
    return s;
  }

  const parseBeat = (body: unknown): Beat | null => {
    const b = body as Partial<Beat> | undefined;
    if (!b || typeof b.position !== 'number' || !Number.isFinite(b.position) || typeof b.rate !== 'number') return null;
    return { position: b.position, playing: b.playing === true, rate: b.rate, visible: b.visible !== false };
  };

  // ---- auth ----
  app.post('/api/login', async (req, reply) => {
    const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(String(username ?? '')) as (User & { password_hash: string }) | undefined;
    if (!row || !verifyPassword(String(password ?? ''), row.password_hash)) {
      appendAudit(db, now(), { userId: String(username ?? 'unknown').slice(0, 40), event: 'login_failed' });
      return reply.code(401).send({ error: 'bad_credentials' });
    }
    reply.setCookie('auth', makeToken(secret, row.id, now() + SESSION_TTL_MS), {
      httpOnly: true, sameSite: 'lax', path: '/', maxAge: SESSION_TTL_MS / 1000, secure: opts.secureCookies ?? false,
    });
    appendAudit(db, now(), { userId: row.id, event: 'login' });
    return { id: row.id, name: row.name, role: row.role };
  });

  app.post('/api/logout', async (req, reply) => {
    const user = currentUser(req);
    if (user) appendAudit(db, now(), { userId: user.id, event: 'logout' });
    reply.clearCookie('auth', { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req, reply) => {
    const user = requireUser(req, reply);
    return user ?? reply;
  });

  // ---- reviewer: list, start, heartbeat, complete ----
  app.get('/api/videos', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    const rows = db.prepare(
      user.role === 'admin'
        ? 'SELECT v.* FROM videos v ORDER BY v.id'
        : 'SELECT v.* FROM videos v JOIN assignments a ON a.video_id = v.id WHERE a.user_id = ? ORDER BY v.id',
    ).all(...(user.role === 'admin' ? [] : [user.id])) as unknown as VideoRow[];
    return rows.map((v) => {
      const done = db.prepare("SELECT 1 FROM sessions WHERE user_id=? AND video_id=? AND status='completed'").get(user.id, v.id);
      const any = db.prepare('SELECT 1 FROM sessions WHERE user_id=? AND video_id=?').get(user.id, v.id);
      return { id: v.id, title: v.title, thumb: v.thumb, duration: v.duration, status: done ? 'completed' : any ? 'in_progress' : 'not_started' };
    });
  });

  app.post('/api/videos/:id/start', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    const video = getVideo((req.params as { id: string }).id);
    if (!video || !isAssigned(user.id, video.id)) return reply.code(403).send({ error: 'not_assigned' });
    if (db.prepare("SELECT 1 FROM sessions WHERE user_id=? AND video_id=? AND status='completed'").get(user.id, video.id)) {
      return reply.code(409).send({ error: 'already_completed' });
    }
    const t = now();
    // A new attempt supersedes any unfinished one for the same video.
    db.prepare("UPDATE sessions SET status='incomplete', ended_at=last_beat_at WHERE user_id=? AND video_id=? AND status='active'").run(user.id, video.id);
    const id = randomUUID();
    const st = newTrackState(t, video.duration);
    db.prepare('INSERT INTO sessions (id, user_id, video_id, started_at, last_beat_at, covered) VALUES (?,?,?,?,?,?)')
      .run(id, user.id, video.id, t, t, JSON.stringify(st.covered));
    appendAudit(db, t, { userId: user.id, videoId: video.id, sessionId: id, event: 'session_start' });
    const token = makeToken(secret, `${user.id}|${video.file}`, t + MEDIA_TTL_MS);
    return { sessionId: id, duration: video.duration, mediaUrl: `/media/${encodeURIComponent(video.file)}?t=${token}` };
  });

  app.post('/api/sessions/:id/beat', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    const s = ownedActiveSession(req, reply, user);
    if (!s) return reply;
    const beat = parseBeat(req.body);
    if (!beat) return reply.code(400).send({ error: 'bad_beat' });
    const video = getVideo(s.video_id)!;
    const t = loadTrack(s);
    const result = applyBeat(t, beat, now(), video.duration);
    saveTrack(s.id, t);
    for (const flag of result.flags) {
      if (flag !== 'hidden') appendAudit(db, now(), { userId: user.id, videoId: s.video_id, sessionId: s.id, event: `flag:${flag}`, detail: { position: beat.position, rate: beat.rate } });
    }
    return { watched: Number(t.watched.toFixed(1)), flags: result.flags };
  });

  app.post('/api/sessions/:id/complete', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    const s = ownedActiveSession(req, reply, user);
    if (!s) return reply;
    const beat = parseBeat(req.body);
    if (!beat) return reply.code(400).send({ error: 'bad_beat' });
    const video = getVideo(s.video_id)!;
    const t = loadTrack(s);
    // "ended" fires with playing=false, but the video was playing up to that moment. Credit is
    // still capped by the pace check, so reporting the end position early earns nothing.
    applyBeat(t, { ...beat, playing: true }, now(), video.duration);
    saveTrack(s.id, t);
    const verdict = evaluateCompletion(t, video.duration);
    db.prepare('UPDATE sessions SET status=?, ended_at=? WHERE id=?').run(verdict.ok ? 'completed' : 'incomplete', now(), s.id);
    appendAudit(db, now(), {
      userId: user.id, videoId: s.video_id, sessionId: s.id,
      event: verdict.ok ? 'session_completed' : 'completion_rejected',
      detail: { watched: Number(t.watched.toFixed(1)), reasons: verdict.reasons },
    });
    return { completed: verdict.ok, reasons: verdict.reasons, watched: Number(t.watched.toFixed(1)) };
  });

  // Sent from pagehide via sendBeacon: records that the viewer left early.
  app.post('/api/sessions/:id/end', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return reply;
    const s = ownedActiveSession(req, reply, user);
    if (!s) return reply;
    db.prepare("UPDATE sessions SET status='incomplete', ended_at=? WHERE id=?").run(now(), s.id);
    appendAudit(db, now(), { userId: user.id, videoId: s.video_id, sessionId: s.id, event: 'session_left', detail: { watched: Number(s.watched.toFixed(1)) } });
    return { ok: true };
  });

  // ---- media: short-lived signed link, byte ranges served by fastify-static ----
  app.get('/media/:file', async (req, reply) => {
    const user = currentUser(req);
    const file = (req.params as { file: string }).file;
    const payload = readToken(secret, (req.query as { t?: string }).t, now());
    if (!user || !payload || payload !== `${user.id}|${file}`) return reply.code(403).send({ error: 'bad_media_token' });
    if (!db.prepare('SELECT 1 FROM videos WHERE file = ?').get(file)) return reply.code(404).send({ error: 'unknown_file' });
    reply.header('Cache-Control', 'private, no-store');
    reply.header('Content-Disposition', 'inline');
    return reply.sendFile(file);
  });

  app.get('/thumbs/:file', async (req, reply) => {
    const file = (req.params as { file: string }).file;
    if (!/^[\w.-]+\.jpg$/.test(file)) return reply.code(404).send();
    return reply.sendFile(`thumbs/${file}`);
  });

  // ---- admin: reports, csv, audit ----
  const sessionRows = () =>
    db.prepare(
      `SELECT s.*, u.name AS reviewer, v.title AS video, v.duration AS duration
       FROM sessions s JOIN users u ON u.id = s.user_id JOIN videos v ON v.id = s.video_id ORDER BY s.started_at`,
    ).all() as unknown as Array<SessionRow & { reviewer: string; video: string; duration: number }>;
  const effective = (s: SessionRow) =>
    s.status === 'active' && now() - s.last_beat_at > STALE_MS ? ('incomplete' as const) : s.status;

  app.get('/api/admin/report', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const reviewers = db.prepare("SELECT id, name FROM users WHERE role='reviewer' ORDER BY id").all() as unknown as Array<{ id: string; name: string }>;
    const sessions = sessionRows();
    return reviewers.map((r) => {
      const assigned = (db.prepare('SELECT COUNT(*) AS n FROM assignments WHERE user_id=?').get(r.id) as { n: number }).n;
      const mine = sessions.filter((s) => s.user_id === r.id);
      const completed = new Set(mine.filter((s) => effective(s) === 'completed').map((s) => s.video_id)).size;
      return {
        reviewer: r.name, assigned, completed, remaining: assigned - completed,
        completionRate: assigned ? Math.round((completed / assigned) * 100) : 0,
        totalWatchSeconds: Math.round(mine.reduce((n, s) => n + s.watched, 0)),
        sessions: mine.length, anomalies: mine.reduce((n, s) => n + s.anomalies, 0),
      };
    });
  });

  app.get('/api/admin/sessions.csv', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : '');
    const lines = [['reviewer', 'video', 'start_time', 'end_time', 'watched_seconds', 'video_seconds', 'status', 'anomalies'].join(',')];
    for (const s of sessionRows()) {
      const status = effective(s);
      const end = s.ended_at ?? (status === 'active' ? null : s.last_beat_at);
      lines.push([s.reviewer, s.video, iso(s.started_at), iso(end), s.watched.toFixed(1), s.duration, status, s.anomalies].map(csvCell).join(','));
    }
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="review-sessions.csv"');
    return lines.join('\n') + '\n';
  });

  app.get('/api/admin/audit', async (req, reply) => {
    if (!requireAdmin(req, reply)) return reply;
    const entries = db.prepare('SELECT seq, ts, user_id, video_id, session_id, event, detail, hash FROM audit ORDER BY seq DESC LIMIT 100').all();
    return { chain: verifyChain(db), entries };
  });

  return app;
}
