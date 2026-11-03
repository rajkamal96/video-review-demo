import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type BeatPayload, type VideoItem } from './api';

const BEAT_MS = 2000;
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

type Phase = 'starting' | 'ready' | 'playing' | 'paused' | 'done' | 'rejected' | 'error';

export function Player({ video, onExit }: { video: VideoItem; onExit: () => void }) {
  const el = useRef<HTMLVideoElement>(null);
  const session = useRef<{ id: string; duration: number } | null>(null);
  const reached = useRef(0); // furthest point reached by normal playback
  const [src, setSrc] = useState('');
  const [phase, setPhase] = useState<Phase>('starting');
  const [pos, setPos] = useState(0);
  const [verified, setVerified] = useState(0);
  const [notice, setNotice] = useState('');
  const [reasons, setReasons] = useState<string[]>([]);

  const payload = useCallback((): BeatPayload => {
    const v = el.current!;
    return { position: v.currentTime, playing: !v.paused && !v.ended, rate: v.playbackRate, visible: document.visibilityState === 'visible' };
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.start(video.id).then((s) => {
      if (cancelled) return;
      session.current = { id: s.sessionId, duration: s.duration };
      setSrc(s.mediaUrl);
      setPhase('ready');
    }).catch(() => setPhase('error'));
    return () => { cancelled = true; };
  }, [video.id]);

  // Heartbeat: the server, not this page, decides what counts as watched.
  useEffect(() => {
    if (phase !== 'playing' && phase !== 'paused') return;
    const timer = window.setInterval(async () => {
      if (!session.current || !el.current) return;
      try {
        const r = await api.beat(session.current.id, payload());
        setVerified(r.watched);
        const flag = r.flags.find((f) => f !== 'hidden');
        if (flag) setNotice('Unusual playback was detected and logged. Please watch the video normally.');
      } catch { /* a missed beat only reduces credit; it never grants any */ }
    }, BEAT_MS);
    return () => window.clearInterval(timer);
  }, [phase, payload]);

  // Pause when the tab or window is not in front. Hidden time earns no credit anyway.
  useEffect(() => {
    const pause = () => { if (el.current && !el.current.paused) { el.current.pause(); setNotice('Paused because the page was not in front.'); } };
    const onVis = () => { if (document.visibilityState === 'hidden') pause(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('blur', pause);
    return () => { document.removeEventListener('visibilitychange', onVis); window.removeEventListener('blur', pause); };
  }, []);

  // Record an early exit when the tab is closed.
  useEffect(() => {
    const leave = () => {
      if (session.current && phase !== 'done' && phase !== 'rejected') navigator.sendBeacon(`/api/sessions/${session.current.id}/end`);
    };
    window.addEventListener('pagehide', leave);
    return () => window.removeEventListener('pagehide', leave);
  }, [phase]);

  const finish = async () => {
    if (!session.current || !el.current) return;
    try {
      const r = await api.complete(session.current.id, { ...payload(), playing: false });
      setVerified(r.watched);
      setReasons(r.reasons);
      setPhase(r.completed ? 'done' : 'rejected');
    } catch { setPhase('error'); }
  };

  const toggle = () => {
    const v = el.current;
    if (!v) return;
    if (v.paused) {
      // An immediate beat resyncs the server's clock, so time spent before pressing play is never counted as a gap.
      v.play().then(() => { if (session.current) api.beat(session.current.id, payload()).catch(() => undefined); });
      setNotice('');
      setPhase('playing');
    } else { v.pause(); setPhase('paused'); }
  };

  const duration = session.current?.duration ?? video.duration;

  return (
    <main className="player-page">
      <button className="ghost" onClick={onExit}>← Back to list</button>
      <h3>{video.title}</h3>
      <div className="stage" onContextMenu={(e) => e.preventDefault()}>
        {src && (
          <video
            ref={el}
            src={src}
            playsInline
            preload="auto"
            controls={false}
            disablePictureInPicture
            disableRemotePlayback
            controlsList="nodownload noplaybackrate noremoteplayback"
            onTimeUpdate={(e) => {
              const t = e.currentTarget.currentTime;
              if (!e.currentTarget.seeking && t <= reached.current + 1.5) reached.current = Math.max(reached.current, t);
              setPos(t);
            }}
            onSeeking={(e) => {
              const v = e.currentTarget;
              if (Math.abs(v.currentTime - reached.current) > 0.5) v.currentTime = reached.current; // seeking is disabled
            }}
            onRateChange={(e) => { if (e.currentTarget.playbackRate !== 1) e.currentTarget.playbackRate = 1; }}
            onEnded={finish}
          />
        )}
        {phase === 'done' && <div className="overlay good">✓ Completed. Your viewing has been recorded.</div>}
        {phase === 'rejected' && (
          <div className="overlay bad">
            This viewing could not be verified as complete, so it was not counted. Please watch the whole video without skipping.
            <small>{reasons.join(', ')}</small>
          </div>
        )}
        {phase === 'error' && <div className="overlay bad">Something went wrong. Go back and try again.</div>}
      </div>

      <div className="bar-row">
        <button className="primary" disabled={phase !== 'ready' && phase !== 'playing' && phase !== 'paused'} onClick={toggle}>
          {phase === 'playing' ? '❚❚ Pause' : '▶ Play'}
        </button>
        <div className="track" aria-label="Progress (read only)">
          <div className="fill" style={{ width: `${Math.min(100, (pos / duration) * 100)}%` }} />
        </div>
        <span className="time">{fmt(pos)} / {fmt(duration)}</span>
      </div>
      <p className="verified">Verified viewing: {fmt(verified)} of {fmt(duration)}</p>
      {notice && <p className="notice">{notice}</p>}
      {(phase === 'done' || phase === 'rejected') && <button className="primary" onClick={onExit}>Back to list</button>}
    </main>
  );
}
