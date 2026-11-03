import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.ts';
import { seed } from './catalog.ts';
import { openDb } from './db.ts';
import { verifyChain } from './audit.ts';

const mediaDir = resolve(fileURLToPath(import.meta.url), '../../../media');

function setup() {
  const db = openDb();
  seed(db);
  let clock = 1_800_000_000_000;
  const app = buildApp({ db, secret: 'test-secret', mediaDir, now: () => clock });
  return { db, app, tick: (ms: number) => (clock += ms), now: () => clock };
}

async function login(app: ReturnType<typeof setup>['app'], username: string, password: string) {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { username, password } });
  const set = res.headers['set-cookie'];
  const cookie = (Array.isArray(set) ? set[0] : set)?.split(';')[0] ?? '';
  return { status: res.statusCode, cookie };
}

const post = (app: ReturnType<typeof setup>['app'], cookie: string, url: string, payload?: unknown) =>
  app.inject({ method: 'POST', url, payload: payload as object, headers: { cookie } });

// Plays `seconds` of video at 1.0x with a heartbeat every 2s of server time.
async function playThrough(ctx: ReturnType<typeof setup>, cookie: string, sessionId: string, from: number, to: number) {
  let pos = from;
  while (pos < to) {
    ctx.tick(2000);
    pos = Math.min(to, pos + 2);
    await post(ctx.app, cookie, `/api/sessions/${sessionId}/beat`, { position: pos, playing: true, rate: 1, visible: true });
  }
  return pos;
}

describe('review portal', () => {
  it('requires sign-in and rejects bad passwords', async () => {
    const { app } = setup();
    assert.equal((await app.inject({ url: '/api/videos' })).statusCode, 401);
    assert.equal((await login(app, 'reviewer1', 'wrong')).status, 401);
  });

  it('accepts an empty JSON body on start and rejects malformed JSON', async () => {
    const { app } = setup();
    const { cookie } = await login(app, 'reviewer1', 'demo-reviewer-1');
    const empty = await app.inject({ method: 'POST', url: '/api/videos/v1/start', headers: { cookie, 'content-type': 'application/json' }, payload: '' });
    assert.equal(empty.statusCode, 200);
    const bad = await app.inject({ method: 'POST', url: '/api/login', headers: { 'content-type': 'application/json' }, payload: '{nope' });
    assert.equal(bad.statusCode, 400);
  });

  it('shows a reviewer only their assigned videos and blocks others', async () => {
    const { app } = setup();
    const { cookie } = await login(app, 'reviewer1', 'demo-reviewer-1');
    const list = (await app.inject({ url: '/api/videos', headers: { cookie } })).json() as Array<{ id: string }>;
    assert.deepEqual(list.map((v) => v.id), ['v1', 'v2', 'v3']);
    assert.equal((await post(app, cookie, '/api/videos/v4/start')).statusCode, 403);
  });

  it('completes a video only after verified real-time viewing, then blocks replay', async () => {
    const ctx = setup();
    const { cookie } = await login(ctx.app, 'reviewer1', 'demo-reviewer-1');
    const start = (await post(ctx.app, cookie, '/api/videos/v1/start')).json() as { sessionId: string; duration: number };
    const end = await playThrough(ctx, cookie, start.sessionId, 0, start.duration);
    ctx.tick(500);
    const done = (await post(ctx.app, cookie, `/api/sessions/${start.sessionId}/complete`, { position: end, playing: false, rate: 1, visible: true })).json();
    assert.equal(done.completed, true);
    assert.equal((await post(ctx.app, cookie, '/api/videos/v1/start')).statusCode, 409);
  });

  it('completes a realistic viewing: late start, resync beat, partial last interval', async () => {
    const ctx = setup();
    const { cookie } = await login(ctx.app, 'reviewer1', 'demo-reviewer-1');
    const start = (await post(ctx.app, cookie, '/api/videos/v1/start')).json() as { sessionId: string; duration: number };
    ctx.tick(30_000); // reader sits on the page before pressing play
    const resync = (await post(ctx.app, cookie, `/api/sessions/${start.sessionId}/beat`, { position: 0, playing: true, rate: 1, visible: true })).json();
    assert.deepEqual(resync.flags, ['gap']);
    const reached = await playThrough(ctx, cookie, start.sessionId, 0, 10);
    ctx.tick(1900); // video ends between two heartbeats; the page reports "ended" with playing=false
    const done = (await post(ctx.app, cookie, `/api/sessions/${start.sessionId}/complete`, { position: start.duration, playing: false, rate: 1, visible: true })).json();
    assert.equal(reached, 10);
    assert.equal(done.completed, true);
    const flags = (ctx.db.prepare('SELECT anomalies FROM sessions WHERE id = ?').get(start.sessionId) as { anomalies: number }).anomalies;
    assert.equal(flags, 0);
  });

  it('still rejects a completion call that jumps to the end', async () => {
    const ctx = setup();
    const { cookie } = await login(ctx.app, 'reviewer1', 'demo-reviewer-1');
    const start = (await post(ctx.app, cookie, '/api/videos/v2/start')).json() as { sessionId: string };
    await playThrough(ctx, cookie, start.sessionId, 0, 4);
    ctx.tick(2000);
    const done = (await post(ctx.app, cookie, `/api/sessions/${start.sessionId}/complete`, { position: 25, playing: true, rate: 1, visible: true })).json();
    assert.equal(done.completed, false);
  });

  it('rejects completion when the viewer skipped ahead, even if the video "ended"', async () => {
    const ctx = setup();
    const { cookie } = await login(ctx.app, 'reviewer1', 'demo-reviewer-1');
    const start = (await post(ctx.app, cookie, '/api/videos/v2/start')).json() as { sessionId: string };
    await playThrough(ctx, cookie, start.sessionId, 0, 6);
    ctx.tick(2000);
    const beat = (await post(ctx.app, cookie, `/api/sessions/${start.sessionId}/beat`, { position: 24, playing: true, rate: 1, visible: true })).json();
    assert.ok(beat.flags.includes('forward_skip'));
    ctx.tick(2000);
    const done = (await post(ctx.app, cookie, `/api/sessions/${start.sessionId}/complete`, { position: 25, playing: false, rate: 1, visible: true })).json();
    assert.equal(done.completed, false);
    assert.ok(done.reasons.length > 0);
    const list = (await ctx.app.inject({ url: '/api/videos', headers: { cookie } })).json() as Array<{ id: string; status: string }>;
    assert.equal(list.find((v) => v.id === 'v2')?.status, 'in_progress');
  });

  it("does not let one reviewer touch another's session", async () => {
    const ctx = setup();
    const a = await login(ctx.app, 'reviewer1', 'demo-reviewer-1');
    const b = await login(ctx.app, 'reviewer2', 'demo-reviewer-2');
    const start = (await post(ctx.app, a.cookie, '/api/videos/v2/start')).json() as { sessionId: string };
    const res = await post(ctx.app, b.cookie, `/api/sessions/${start.sessionId}/beat`, { position: 2, playing: true, rate: 1, visible: true });
    assert.equal(res.statusCode, 404);
  });

  it('serves media only with a valid short-lived link, with byte ranges', async () => {
    const ctx = setup();
    const { cookie } = await login(ctx.app, 'reviewer1', 'demo-reviewer-1');
    const start = (await post(ctx.app, cookie, '/api/videos/v1/start')).json() as { mediaUrl: string };
    assert.equal((await ctx.app.inject({ url: '/media/Video_001.mp4', headers: { cookie } })).statusCode, 403);
    const ranged = await ctx.app.inject({ url: start.mediaUrl, headers: { cookie, range: 'bytes=0-99' } });
    assert.equal(ranged.statusCode, 206);
    assert.match(String(ranged.headers['content-range']), /^bytes 0-99\//);
    const other = await login(ctx.app, 'reviewer2', 'demo-reviewer-2');
    assert.equal((await ctx.app.inject({ url: start.mediaUrl, headers: { cookie: other.cookie } })).statusCode, 403);
    ctx.tick(16 * 60_000);
    assert.equal((await ctx.app.inject({ url: start.mediaUrl, headers: { cookie } })).statusCode, 403);
  });

  it('keeps reports and audit data admin-only, and exports csv', async () => {
    const ctx = setup();
    const rev = await login(ctx.app, 'reviewer1', 'demo-reviewer-1');
    assert.equal((await ctx.app.inject({ url: '/api/admin/report', headers: { cookie: rev.cookie } })).statusCode, 403);
    assert.equal((await ctx.app.inject({ url: '/api/admin/sessions.csv', headers: { cookie: rev.cookie } })).statusCode, 403);
    await post(ctx.app, rev.cookie, '/api/videos/v1/start');
    const admin = await login(ctx.app, 'admin', 'demo-admin');
    const csv = (await ctx.app.inject({ url: '/api/admin/sessions.csv', headers: { cookie: admin.cookie } })).body;
    assert.match(csv, /^reviewer,video,start_time,end_time,watched_seconds,video_seconds,status,anomalies/);
    assert.match(csv, /"Riya Reviewer","Video_001"/);
    const report = (await ctx.app.inject({ url: '/api/admin/report', headers: { cookie: admin.cookie } })).json() as Array<{ reviewer: string; assigned: number }>;
    assert.equal(report.find((r) => r.reviewer === 'Riya Reviewer')?.assigned, 3);
  });

  it('keeps a hash-chained audit log that detects tampering', async () => {
    const ctx = setup();
    const { cookie } = await login(ctx.app, 'reviewer1', 'demo-reviewer-1');
    await post(ctx.app, cookie, '/api/videos/v1/start');
    assert.equal(verifyChain(ctx.db).ok, true);
    ctx.db.prepare("UPDATE audit SET event = 'session_completed' WHERE event = 'session_start'").run();
    const check = verifyChain(ctx.db);
    assert.equal(check.ok, false);
    assert.ok(check.brokenAtSeq);
  });
});
