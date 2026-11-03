import { useEffect, useState } from 'react';
import { api, type AuditRow, type ReportRow } from './api';

const mins = (s: number) => `${Math.floor(s / 60)}m ${s % 60}s`;

export function Admin() {
  const [report, setReport] = useState<ReportRow[]>([]);
  const [audit, setAudit] = useState<Awaited<ReturnType<typeof api.audit>> | null>(null);
  const refresh = () => { api.report().then(setReport); api.audit().then(setAudit); };
  useEffect(refresh, []);

  return (
    <main className="admin">
      <div className="row">
        <h3>Progress by reviewer</h3>
        <span className="spacer" />
        <button className="ghost" onClick={refresh}>Refresh</button>
        <a className="primary link" href="/api/admin/sessions.csv">Export CSV</a>
      </div>
      <table>
        <thead>
          <tr><th>Reviewer</th><th>Assigned</th><th>Completed</th><th>Remaining</th><th>Completion</th><th>Watch time</th><th>Sessions</th><th>Flags</th></tr>
        </thead>
        <tbody>
          {report.map((r) => (
            <tr key={r.reviewer}>
              <td>{r.reviewer}</td><td>{r.assigned}</td><td>{r.completed}</td><td>{r.remaining}</td>
              <td>{r.completionRate}%</td><td>{mins(r.totalWatchSeconds)}</td><td>{r.sessions}</td><td>{r.anomalies}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="row">
        <h3>Audit log</h3>
        <span className="spacer" />
        {audit && (
          <span className={audit.chain.ok ? 'chip completed' : 'chip bad'}>
            {audit.chain.ok ? `Chain verified (${audit.chain.entries} entries)` : `Tampering detected at #${audit.chain.brokenAtSeq}`}
          </span>
        )}
      </div>
      <table className="audit">
        <thead><tr><th>#</th><th>Time</th><th>User</th><th>Video</th><th>Event</th><th>Detail</th></tr></thead>
        <tbody>
          {(audit?.entries ?? []).map((e: AuditRow) => (
            <tr key={e.seq}>
              <td>{e.seq}</td><td>{new Date(e.ts).toLocaleString()}</td><td>{e.user_id}</td><td>{e.video_id ?? ''}</td>
              <td>{e.event}</td><td>{e.detail !== '{}' && <code>{e.detail}</code>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
