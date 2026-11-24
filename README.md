# Robot Line Assistant (web UI)

Static site: `index.html`, `style.css`, `app.js`. No build step, no backend.

## Views
- `#operator` (default): operator window only (status banner, robot camera, controls, order, rack, attention card).
- `#manager`: the same operator window plus a calendar and the daily log. Pick a day to see parts placed, times the operator was needed, stops, and the event timeline. "Yesterday" jumps to the previous day.

Send operators `https://<your-site>/#operator` and managers `https://<your-site>/#manager`. There is no login yet, so the manager view is hidden by link only, not secured.

## Run locally
Serve it over HTTP rather than double-clicking `index.html`, so the video files load reliably.

    cd UI/web && python3 -m http.server 8000     # then open http://localhost:8000

## Publish so anyone can open it (any network)
Any static host works; all give you HTTPS (needed later for camera streams).
- **GitHub Pages**: push the `UI/web` folder to a repo, Settings > Pages > deploy from branch.
- **Netlify / Cloudflare Pages**: drag the `UI/web` folder into the dashboard.

## What is simulated
- Robot, rack and order progress run in the browser (`tick()` in `app.js`).
- The camera is a playlist of six short egocentric clips (`video/`, about 30 s in total, each played once before any repeats) cropped from the Boston Dynamics video "Atlas Goes Hands On" (the picture-in-picture robot view). The first clip depends on the first part in the order, and the stream pauses whenever the robot is not running (STOP, E-STOP, idle, done); it keeps playing while the robot waits for the operator.
- Those clips are Boston Dynamics' footage. Fine for an internal/class demo; before publishing the site publicly, get their permission or replace the clips with your own G1 recordings.
- Past days in the calendar are generated sample data (marked "Sample data"). Today's log is real for the session but stored only in that browser (localStorage), so a manager on another computer will not see the operator's events.

## To make it real
1. Backend: a small service (Firebase/Supabase, or your own) that holds the order, robot state and event log, so operator and manager see the same data from anywhere. Replace the `S` state and `logEv()` / `eventsFor()` in `app.js`.
2. Live video: replace the `<video id="ego">` source with a stream the browser can play, e.g. WebRTC or HLS from the robot's camera via a relay (the robot sits behind NAT, so a relay such as MediaMTX, LiveKit or Cloudflare Stream is needed for viewers outside the same Wi-Fi).
3. Access control for the manager view.
