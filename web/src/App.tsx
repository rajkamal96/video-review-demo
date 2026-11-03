import { useCallback, useEffect, useState } from 'react';
import { api, type Me, type VideoItem } from './api';
import { Admin } from './Admin';
import { Player } from './Player';

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

function Login({ onDone }: { onDone: (m: Me) => void }) {
  const [username, setUsername] = useState('reviewer1');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  return (
    <main className="login">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            onDone(await api.login(username, password));
          } catch {
            setError('Wrong username or password.');
          }
        }}
      >
        <h1>Video Review Portal</h1>
        <label>Username<input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" /></label>
        <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></label>
        {error && <p className="error">{error}</p>}
        <button className="primary" type="submit">Sign in</button>
        <p className="hint">
          Demo accounts: <code>reviewer1</code> / <code>demo-reviewer-1</code>, <code>reviewer2</code> / <code>demo-reviewer-2</code>,
          <code>admin</code> / <code>demo-admin</code>
        </p>
      </form>
    </main>
  );
}

function Videos({ onOpen }: { onOpen: (v: VideoItem) => void }) {
  const [videos, setVideos] = useState<VideoItem[]>([]);
  useEffect(() => { api.videos().then(setVideos); }, []);
  const done = videos.filter((v) => v.status === 'completed').length;
  return (
    <>
      <p className="progress-line">{done} of {videos.length} videos completed</p>
      <section className="cards">
        {videos.map((v) => (
          <button key={v.id} className="card" disabled={v.status === 'completed'} onClick={() => onOpen(v)}>
            <img src={v.thumb} alt="" />
            <span className="card-title">{v.title}</span>
            <span className="card-meta">{fmt(v.duration)}</span>
            <span className={`chip ${v.status}`}>{v.status === 'completed' ? 'Completed ✓' : v.status === 'in_progress' ? 'Not finished' : 'Not started'}</span>
          </button>
        ))}
      </section>
    </>
  );
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState<VideoItem | null>(null);

  useEffect(() => { api.me().then(setMe).catch(() => undefined).finally(() => setReady(true)); }, []);
  const back = useCallback(() => setPlaying(null), []);

  if (!ready) return <div className="center">Loading…</div>;
  if (!me) return <Login onDone={setMe} />;

  return (
    <div className="shell">
      <header className="top">
        <h2>Video Review Portal</h2>
        <nav>
          <span className="who">{me.name}</span>
          <button className="ghost" onClick={async () => { await api.logout(); setMe(null); setPlaying(null); }}>Sign out</button>
        </nav>
      </header>
      {me.role === 'admin' ? (
        <Admin />
      ) : playing ? (
        <Player video={playing} onExit={back} />
      ) : (
        <Videos onOpen={setPlaying} />
      )}
    </div>
  );
}
