export interface Me { id: string; name: string; role: 'admin' | 'reviewer' }
export interface VideoItem { id: string; title: string; thumb: string; duration: number; status: 'not_started' | 'in_progress' | 'completed' }
export interface BeatPayload { position: number; playing: boolean; rate: number; visible: boolean }

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status, data });
  return data as T;
}

export const api = {
  me: () => call<Me>('GET', '/api/me'),
  login: (username: string, password: string) => call<Me>('POST', '/api/login', { username, password }),
  logout: () => call<{ ok: boolean }>('POST', '/api/logout'),
  videos: () => call<VideoItem[]>('GET', '/api/videos'),
  start: (id: string) => call<{ sessionId: string; duration: number; mediaUrl: string }>('POST', `/api/videos/${id}/start`),
  beat: (sid: string, b: BeatPayload) => call<{ watched: number; flags: string[] }>('POST', `/api/sessions/${sid}/beat`, b),
  complete: (sid: string, b: BeatPayload) =>
    call<{ completed: boolean; reasons: string[]; watched: number }>('POST', `/api/sessions/${sid}/complete`, b),
  report: () => call<ReportRow[]>('GET', '/api/admin/report'),
  audit: () => call<{ chain: { ok: boolean; entries: number; brokenAtSeq?: number }; entries: AuditRow[] }>('GET', '/api/admin/audit'),
};

export interface ReportRow {
  reviewer: string; assigned: number; completed: number; remaining: number;
  completionRate: number; totalWatchSeconds: number; sessions: number; anomalies: number;
}
export interface AuditRow { seq: number; ts: number; user_id: string; video_id: string | null; event: string; detail: string }
