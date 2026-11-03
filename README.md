# Video review portal: server-verified viewing demo

A small working demo of a compliance video-review portal. Reviewers sign in, watch
assigned videos one at a time in a locked-down player, and every viewing is
recorded in a tamper-evident audit log. The point of the demo is **how completion
is decided**: the server decides, not the browser.

Placeholder videos only. It is not a production system (see "Not built yet").

## What it does
- Own login per reviewer (demo accounts below); reviewers see only their assigned videos.
- Custom thumbnails (images made from the file name, never a video frame).
- Player with no controls, speed locked to 1.0x, seeking blocked, no download or picture-in-picture, right-click disabled, pauses when the page is not in front.
- A video is marked complete **only after the server has verified the viewing** (below). Completed videos cannot be replayed.
- Per viewing, recorded: reviewer, video, start time, end time, verified watch seconds, status, flags.
- Admin dashboard: assigned / completed / remaining / completion rate / watch time per reviewer, CSV export, audit log with a chain-integrity check.
- Videos are served only through short-lived (15 min) signed links tied to one reviewer and one file, with byte-range support.

## How completion is verified
The page sends the playhead position every 2 seconds. The server compares each report with **its own clock**:

| Reported movement | Result |
|---|---|
| Playhead advanced about as much as real time, while playing, in front, at 1.0x | credited |
| Jumped ahead of real time (skip, speed-up) | flagged, **no credit** |
| Moved backwards | flagged, no credit |
| Page hidden or paused | no credit |
| No heartbeat for 15 s (closed laptop, lost connection) | no credit for the gap |

A viewing completes only if verified coverage reaches 98% of the video **and** verified watch time reaches 98% **and** the playhead finished within 1.5 s of the end. The browser's "ended" event alone is never trusted. A script that sends fake positions earns no coverage, so it cannot complete a video.

Audit rows are hash-chained: each row commits to the one before, so editing or deleting a past row is detected (the dashboard shows "Chain verified" or the first broken entry).

## Run it
Needs Node 22.18 or newer.
```bash
npm install
npm run build        # builds the web app into dist/web
npm start            # http://localhost:3000
npm test             # 19 tests: tracking rules, access control, signed media, audit chain
```
Demo accounts: `reviewer1` / `demo-reviewer-1`, `reviewer2` / `demo-reviewer-2`, `admin` / `demo-admin`.
The database is a file in `data/`. Delete that folder for a clean slate.
Set `SECRET` to a long random string in any shared deployment.

`npm run media` regenerates the placeholder videos (needs `pip install imageio-ffmpeg pillow`).

## Deploy (free, for a demo)
`Dockerfile` and `render.yaml` are included (the image was built and smoke-tested locally). On Render: New > Blueprint > pick the repo. The free plan has no disk, so the demo database resets when the service restarts or sleeps.

## Honest limits
No browser-based system can stop a determined technical user from tampering with their own machine. This design makes skipping **not count** and makes attempts visible in the log; it does not make them impossible. Fullscreen on iPhone hands playback to the native player, which cannot be locked, so reviewers should use a desktop or laptop browser.

## Not built yet (needed for the real system)
- Microsoft 365 / Entra ID sign-in (OIDC) in place of the demo accounts.
- Bulk copy of the ~600 videos from OneDrive into private storage, and reading durations from each file.
- Admin screens to assign videos and manage reviewers (assignment exists in the database and seed).
- Native Excel export (CSV opens in Excel) and a Power BI read-only view.
- Resume-after-interruption policy: today an interrupted viewing is recorded as incomplete and restarts from the beginning.
- Login rate limiting, HTTPS termination, backups, and a production database.
