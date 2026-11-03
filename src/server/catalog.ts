import type { Db } from './db.ts';
import { hashPassword } from './auth.ts';

// Demo accounts only. A real deployment replaces these with the client's
// identity provider (e.g. Microsoft sign-in over OIDC).
export const DEMO_USERS = [
  { id: 'admin', name: 'Alex Admin', role: 'admin', password: 'demo-admin' },
  { id: 'reviewer1', name: 'Riya Reviewer', role: 'reviewer', password: 'demo-reviewer-1' },
  { id: 'reviewer2', name: 'Sam Reviewer', role: 'reviewer', password: 'demo-reviewer-2' },
] as const;

// Durations are known up front here; a real import reads them from each file.
export const DEMO_VIDEOS = [
  { id: 'v1', title: 'Video_001', file: 'Video_001.mp4', duration: 12 },
  { id: 'v2', title: 'Video_002', file: 'Video_002.mp4', duration: 25 },
  { id: 'v3', title: 'Video_003', file: 'Video_003.mp4', duration: 40 },
  { id: 'v4', title: 'Video_004', file: 'Video_004.mp4', duration: 30 },
] as const;

const ASSIGNMENTS: Record<string, string[]> = {
  reviewer1: ['v1', 'v2', 'v3'],
  reviewer2: ['v2', 'v3', 'v4'],
};

export function seed(db: Db): void {
  const hasUsers = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  if (hasUsers.n > 0) return;
  const addUser = db.prepare('INSERT INTO users (id, name, role, password_hash) VALUES (?,?,?,?)');
  for (const u of DEMO_USERS) addUser.run(u.id, u.name, u.role, hashPassword(u.password));
  const addVideo = db.prepare('INSERT INTO videos (id, title, file, thumb, duration) VALUES (?,?,?,?,?)');
  for (const v of DEMO_VIDEOS) addVideo.run(v.id, v.title, v.file, `/thumbs/${v.title}.jpg`, v.duration);
  const assign = db.prepare('INSERT INTO assignments (user_id, video_id) VALUES (?,?)');
  for (const [user, videos] of Object.entries(ASSIGNMENTS)) for (const v of videos) assign.run(user, v);
}
