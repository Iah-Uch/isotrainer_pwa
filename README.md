# CardioMax Web

A Progressive Web App (PWA) for cardiovascular training periodization. CardioMax connects to Bluetooth Heart Rate (HR) monitors via Web Bluetooth, guides structured training sessions with live charts and stage targets, and exports rich session data for analysis.

The UI is currently in Brazilian Portuguese (pt-BR). This README documents architecture, setup, operations, and deployment in English for engineering and operations teams.


## Highlights
- Web Bluetooth HR: Connects to devices exposing the `heart_rate` GATT service; subscribes to `heart_rate_measurement` notifications.
- Session engine: Load a training plan (CSV or QR), edit targets, start/pause, and navigate stages.
- Live analytics: Real‑time stage chart with target bounds and full‑session chart with stage bands (ECharts).
- QR import: Scan a QR that contains the CSV plan and populate the editor automatically.
- PWA/Installable: App manifest, service worker, link capture, update prompts, and screen wake‑lock.
- CSV export: One normalized CSV with session summary, per‑stage stats, and time series.
- Containerized deploy: Nginx static serving with strict routing, cache headers, and Traefik labels via docker‑compose.


## Repository Structure
- `index.html`: Landing + PWA install surface; links into the app (`app.html`).
- `app.html`: Main application shell and UI (connect, plan, edit, plot, complete screens).
- `styles.css`: Global styles (Tailwind via CDN, plus custom styles).
- `icons/`: App icons and logo assets used by the PWA.
- `manifest.webmanifest`: PWA metadata (start URL `app.html`, icons, shortcuts).
- `sw.js`: Network‑only service worker with cache clearing and update flow.
- `js/` (ES modules):
  - `main.js`: App bootstrap and UI wiring.
  - `ble.js`: Web Bluetooth connect/disconnect and HR measurement handling.
  - `session.js`: CSV parsing, session state machine, timers, stats, and CSV export.
  - `charts.js`: ECharts stage/session charts, bounds, and bands.
  - `state.js`: Central shared state container.
  - `utils.js`: Time and formatting helpers.
  - `ui-fab.js`: Floating action button and quick actions.
  - `qr.js`: QR scanner integration (QrScanner UMD).
  - `pwa.js`: Install prompt UI and client‑side update prompts.
  - `wake-lock.js`: Screen wake‑lock support during sessions.
- Deployment:
  - `Dockerfile`, `docker-compose.yml`, `nginx.conf`.


## Requirements
- Browser: Chrome or Edge (Desktop/Android) with Web Bluetooth support.
- Transport: HTTPS or `http://localhost` (required by Web Bluetooth).
- Hardware: Bluetooth HR monitor supporting the standard Heart Rate service.


## Run Locally
No build step is required; this is a static site.

- Serve the folder (needed for Web Bluetooth):
  - Any static server works if it serves from project root.
- Open `index.html` (landing) or `app.html` directly.
- Allow Bluetooth permissions when prompted and ensure your OS Bluetooth adapter is enabled.


## Using the App
1. Connect HR monitor
   - From the Connect screen, click “Conectar ao dispositivo”. Choose a device that exposes the `heart_rate` service.
2. Load plan
   - Paste CSV into the plan textarea or scan a QR containing the CSV (button “Ler QR”).
   - Optionally open the Edit screen to adjust per‑stage targets.
3. Start session
   - Start and wait for the first HR reading to kick off timers and charts.
   - Use the floating action button (FAB) for Play/Pause, Stage Controls (Prev/Next), or navigate back.
4. Review and export
   - At completion, review session stats and export CSV.


## Training Plan CSV Format
A minimal, semicolon‑separated format is used.

Header (single line):
- `ignored;ignored;date;athlete`

Stages (one per line):
- `index;HH:MM:SS;lower;upper`

Example:
```
ignored;ignored;2025-09-03;Fulano da Silva
1;00:10:00;120;140
2;00:05:00;130;150
3;00:08:00;110;130
```

Notes:
- `upper` must be strictly greater than `lower` per stage.
- Total duration is computed as the sum of `durationSec` across stages.


## Exported CSV Format
Exports a normalized, semicolon‑separated CSV with a `type` discriminator:
- Header columns: `type;date;athlete;stage_index;duration_sec;lower;upper;avg_bpm;min_bpm;max_bpm;in_target_pct;samples;elapsed_sec;stage_elapsed_sec;hr;in_target`
- Rows:
  - `summary`: One row summarizing the overall session.
  - `stage`: One row per stage with per‑stage stats and sample counts.
  - `series`: Full time series points, aligned to global elapsed seconds and per‑stage elapsed, with `in_target` flag.


## Architecture Overview
- Web Bluetooth (`js/ble.js`):
  - Checks availability, requests device filtered by `heart_rate`, subscribes to `characteristicvaluechanged` events, and derives bpm values.
  - Starts timers and updates charts on the first HR value; handles disconnects gracefully.
- Session engine (`js/session.js`):
  - Parses CSV, controls stage transitions, handles pause/resume, and computes session and per‑stage statistics.
  - Emits a completion UI with key metrics and supports CSV export.
- Charts (`js/charts.js`):
  - Stage chart: live HR with target bounds and dynamic highlight when above/below range.
  - Session chart: global HR trace with per‑stage bands; responsive resizing and heart marker positioning.
- PWA (`manifest.webmanifest`, `sw.js`, `js/pwa.js`):
  - Install prompt, link capture, update prompt when a new SW is available; network‑only SW with cache clearing.
- Wake Lock (`js/wake-lock.js`): Keeps the screen awake during sessions.


## Coding Standards
- Formatting: 2 spaces, single quotes, semicolons, max line length 100.
- Imports: external first, then internal (`js/*.js`), then styles; group with a blank line between groups.
- Naming: `camelCase` for vars/functions, `PascalCase` for classes, `UPPER_SNAKE_CASE` for constants.
- Errors: wrap async Web Bluetooth calls with `try/catch`; update visible status text and rethrow with context when appropriate.
- Logging: prefer user‑visible status updates; guard debug logs behind a `DEBUG` flag if added later.


## Testing
- No automated tests are configured. Prefer manual verification on Chrome/Edge with a Bluetooth HR device.
- If adding tests: place in `tests/`, name `*.spec.js`, and focus on critical flows (BLE connect/disconnect, session lifecycle, chart updates).


## Deployment
### Docker (Nginx)
- Build image: `docker build -t cardiomax-web:latest .`
- Run locally: `docker run --rm -p 8080:80 cardiomax-web:latest` then visit `http://localhost:8080`.

### Docker Compose (Traefik example)
The included `docker-compose.yml` is configured for Traefik with TLS and a production hostname in the`cstera` environment.
- Ensure a Traefik `proxy` network exists and certificates are configured.
- Start: `docker compose up -d`.

### Nginx behavior
- Strict routing for only public files and directories; denies hidden files (`/.…`).
- Cache headers for static assets; `sw.js` and the manifest are served with `no-cache`.


## Security & Privacy
- Web Bluetooth requires HTTPS (or `localhost`), user gesture, and permission.
- The app stores session state in memory; no PII is persisted by default.
- Service worker is network‑only and clears caches on install/activate.
- Nginx blocks hidden files and only exposes intended static paths.


## Browser Support & Known Limitations
- Chrome/Edge desktop and Android: Supported for Web Bluetooth.
- iOS/Safari: Web Bluetooth support is limited/experimental; functionality may not work.
- Some devices may require OS‑level pairing before appearing in the chooser.


## Troubleshooting
- “Web Bluetooth unavailable” or disabled Connect button:
  - Use a supported browser, serve over HTTPS or `localhost`, and ensure Bluetooth is enabled on the host.
- No devices shown:
  - The HR monitor must expose the standard `heart_rate` GATT service; wake or pair the device.
- Charts don’t resize:
  - Ensure the app is on the Plot screen; resizing is scheduled on route/viewport changes.
- Update not applied:
  - The app prompts for updates when a new service worker is installed. Click “Atualizar agora” or reload.
