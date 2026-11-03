// Server-side decision of what counts as "watched". The browser only reports
// where the playhead is; this module decides, using the server's own clock,
// whether that movement was real playback.

export const TOLERANCE_S = 0.75; // jitter allowed between two heartbeats
export const SPEED_SLACK = 1.25; // playhead may move at most 1.25x wall-clock
export const MAX_GAP_S = 15; // no heartbeat for this long: the gap earns no credit
export const COMPLETE_RATIO = 0.98; // share of the video that must be verified
export const END_SLACK_S = 1.5; // playhead must finish within this of the end

export interface TrackState {
  lastBeatAt: number; // ms, server clock
  lastPos: number; // seconds, last reported playhead
  watched: number; // seconds of verified real-time playback
  covered: number[]; // 1 per second bucket verified as played, else 0
  anomalies: number;
}

export interface Beat {
  position: number;
  playing: boolean;
  rate: number;
  visible: boolean;
}

export type Flag = 'rate_changed' | 'hidden' | 'gap' | 'backward_seek' | 'forward_skip';

export interface BeatResult {
  credited: number;
  flags: Flag[];
}

export function newTrackState(now: number, duration: number): TrackState {
  return { lastBeatAt: now, lastPos: 0, watched: 0, covered: new Array(Math.ceil(duration)).fill(0), anomalies: 0 };
}

export function applyBeat(state: TrackState, beat: Beat, now: number, duration: number): BeatResult {
  const flags: Flag[] = [];
  const dt = Math.max(0, (now - state.lastBeatAt) / 1000);
  const position = Math.min(Math.max(beat.position, 0), duration);
  const dp = position - state.lastPos;
  let credited = 0;

  if (beat.rate !== 1) flags.push('rate_changed');
  if (!beat.visible) flags.push('hidden');

  if (dt > MAX_GAP_S) flags.push('gap');
  else if (dp < -TOLERANCE_S) flags.push('backward_seek');
  else if (dp > dt * SPEED_SLACK + TOLERANCE_S) flags.push('forward_skip');
  else if (beat.playing && beat.rate === 1 && beat.visible && dp > 0) {
    credited = Math.min(dp, dt);
    const first = Math.floor(state.lastPos);
    const last = Math.min(state.covered.length - 1, Math.floor(position - 1e-6));
    for (let s = first; s <= last; s++) state.covered[s] = 1;
    state.watched += credited;
  }

  state.lastBeatAt = now;
  state.lastPos = position;
  // 'hidden' and 'gap' are informational (a gap earns no credit but is not suspicious on its own).
  if (flags.some((f) => f !== 'hidden' && f !== 'gap')) state.anomalies += 1;
  return { credited, flags };
}

export interface Completion {
  ok: boolean;
  reasons: string[];
}

// "ended" alone is never trusted: the verified coverage must reach the end.
export function evaluateCompletion(state: TrackState, duration: number): Completion {
  const reasons: string[] = [];
  const coveredCount = state.covered.reduce((n, v) => n + v, 0);
  if (coveredCount < COMPLETE_RATIO * state.covered.length) reasons.push('not_enough_verified_coverage');
  if (state.watched < COMPLETE_RATIO * duration) reasons.push('not_enough_watch_time');
  if (state.lastPos < duration - END_SLACK_S) reasons.push('did_not_reach_end');
  return { ok: reasons.length === 0, reasons };
}
