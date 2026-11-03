import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyBeat, evaluateCompletion, newTrackState, type Beat } from './tracking.ts';

const DURATION = 60;
const play = (position: number, extra: Partial<Beat> = {}): Beat => ({ position, playing: true, rate: 1, visible: true, ...extra });

// Simulates a viewer: one heartbeat every 2s of wall-clock time.
function watch(state: ReturnType<typeof newTrackState>, from: number, to: number, startMs: number, rate = 1) {
  let now = startMs;
  let pos = from;
  const flags: string[] = [];
  while (pos < to) {
    now += 2000;
    pos = Math.min(to, pos + 2 * rate);
    flags.push(...applyBeat(state, play(pos, { rate }), now, DURATION).flags);
  }
  return { now, flags };
}

describe('tracking', () => {
  it('credits honest real-time playback and allows completion', () => {
    const s = newTrackState(0, DURATION);
    const { flags } = watch(s, 0, DURATION, 0);
    assert.deepEqual(flags, []);
    assert.ok(s.watched >= 59);
    assert.equal(evaluateCompletion(s, DURATION).ok, true);
  });

  it('refuses completion when the viewer jumps ahead', () => {
    const s = newTrackState(0, DURATION);
    let { now } = watch(s, 0, 10, 0);
    now += 2000;
    const jump = applyBeat(s, play(50), now, DURATION);
    assert.ok(jump.flags.includes('forward_skip'));
    assert.equal(jump.credited, 0);
    watch(s, 50, DURATION, now);
    const result = evaluateCompletion(s, DURATION);
    assert.equal(result.ok, false);
    assert.ok(result.reasons.includes('not_enough_verified_coverage'));
  });

  it('flags a playhead racing ahead of real time (speed-up) and gives no credit', () => {
    const s = newTrackState(0, DURATION);
    const { flags } = watch(s, 0, DURATION, 0, 2);
    assert.ok(flags.includes('rate_changed'));
    assert.ok(s.watched < 1);
    assert.equal(evaluateCompletion(s, DURATION).ok, false);
  });

  it('flags a backward seek', () => {
    const s = newTrackState(0, DURATION);
    const { now } = watch(s, 0, 20, 0);
    const back = applyBeat(s, play(5), now + 2000, DURATION);
    assert.ok(back.flags.includes('backward_seek'));
  });

  it('gives no credit when the tab is hidden', () => {
    const s = newTrackState(0, DURATION);
    const r = applyBeat(s, play(2, { visible: false }), 2000, DURATION);
    assert.ok(r.flags.includes('hidden'));
    assert.equal(r.credited, 0);
  });

  it('gives no credit when paused', () => {
    const s = newTrackState(0, DURATION);
    const r = applyBeat(s, play(0, { playing: false }), 2000, DURATION);
    assert.equal(r.credited, 0);
    assert.deepEqual(r.flags, []);
  });

  it('gives no credit for a long silent gap (closed laptop, lost connection)', () => {
    const s = newTrackState(0, DURATION);
    const r = applyBeat(s, play(30), 120_000, DURATION);
    assert.ok(r.flags.includes('gap'));
    assert.equal(r.credited, 0);
  });

  it('does not trust "ended" without verified coverage', () => {
    const s = newTrackState(0, DURATION);
    applyBeat(s, play(DURATION), 2000, DURATION);
    const result = evaluateCompletion(s, DURATION);
    assert.equal(result.ok, false);
    assert.ok(result.reasons.includes('not_enough_watch_time'));
  });
});
