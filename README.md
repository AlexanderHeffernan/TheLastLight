# The Last Light

The Last Light is a small pixel-art top-down survival shooter about holding a failing floodlit outpost against an endless horde. It uses a deliberately limited asset set and leans on dynamic lighting, projected shadows, procedural ambience, reactive effects, and escalating encounter design to create spectacle.

Play at [thelastlight.alexheffernan.dev](https://thelastlight.alexheffernan.dev).

The game is open source, self-hostable, and deployed as a multi-architecture Docker image on a Raspberry Pi.

## Current Release

The current release is a complete score-attack survival game. Runs are intentionally short: learn the outpost, exploit its barrels and floodlights, use supplies and aerial flares, and survive long enough to place on the global leaderboard.

## Features

- Mouse-driven top-down shooting with responsive recoil, impacts, casings, blood, and explosions
- Dynamic darkness, directional floodlights, aerial crimson flares, occlusion, and projected shadows
- Four infected archetypes with distinct silhouettes, movement, health, and audio behavior
- A wave director that escalates pressure and introduces threats over time
- Generator-fabricated flares and delayed supply drops containing health or repairs
- Procedural monster vocals and combat audio with a rotating original soundtrack
- Persistent global deployment count, leaderboard, special skin access, and repository-driven changelog
- Private two-player WebRTC sessions with host-authoritative simulation
- Development-only collision visualization that is excluded from production builds

## Tech Stack

- [Phaser 3](https://phaser.io/) for gameplay and rendering
- TypeScript and Vite for the browser client
- Node.js for static hosting and the small persistence API
- JSON file persistence with atomic writes
- Docker, GHCR, and GitHub Actions for ARM64/AMD64 deployment

The browser owns the single-player simulation. In private duos, the host browser owns the authoritative simulation and sends snapshots and semantic events directly to the guest over peer-to-peer WebRTC. The server provides short-lived signaling, static hosting, and persistent aggregate and leaderboard records.

## Run Locally

```sh
npm install
npm run dev
```

The Vite client runs locally with graceful offline fallbacks for server-backed menu data. For the complete production stack:

```sh
npm run build
DATA_DIR=./data npm start
```

Open [http://localhost:3000](http://localhost:3000).

## Controls

- **WASD / arrow keys** — move
- **Mouse** — aim
- **Left mouse** — fire
- **Touch** — Twin Stick: tap anywhere on the left to place the move stick, then hold anywhere on the right to aim; push past the inner ring to fire, and release to stop firing
- **Mobile action buttons** — use the flare and open buttons; pause from the top-right
- **F** — fire an available aerial flare
- **E** — open a landed supply cache
- **P / Escape** — pause
- **R / click after defeat** — redeploy

During `npm run dev` only, press **F2** to toggle collision visualization. The renderer and key binding are excluded from production builds.

## Build And Start

```sh
npm run typecheck
npm run build
npm start
```

The client is emitted to `dist/client`, and the Node server is emitted to `dist/server`.

## Host With Docker

```sh
docker build --build-arg BUILD_TIMESTAMP="$(date +%s000)" -t the-last-light:latest .
THE_LAST_LIGHT_IMAGE=the-last-light:latest docker compose up -d
```

The Compose service binds to `127.0.0.1:3011` by default and persists data in the `the-last-light-data` volume. Override the host port with `HOST_PORT`.

Useful commands:

```sh
docker compose logs -f the-last-light
docker compose pull
docker compose up -d
docker compose down
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Internal HTTP server port |
| `DATA_DIR` | `/data` | Persistent scores, callsign claims, special skin access, and private-room recovery state |
| `TRUST_PROXY` | `false` | Trust `CF-Connecting-IP`/`X-Forwarded-For` only when the server is behind a trusted reverse proxy |
| `SKIN_ADMIN_TOKEN` | unset | Bearer token for the protected special-skin access management endpoint |
| `TURN_URLS` | unset | Comma-separated public self-hosted TURN URLs, for example `turn:game.example.com:3478?transport=udp,turn:game.example.com:3478?transport=tcp` |
| `TURN_SHARED_SECRET` | unset | Secret shared by the app server and coturn to mint short-lived TURN credentials; never expose this value in client configuration |
| `TURN_REALM` | `the-last-light` | Authentication realm used by the optional coturn service |
| `TURN_EXTERNAL_IP` | unset | Public IP advertised by coturn when it is behind NAT |
| `CHANGELOG_REPOSITORY` | `AlexanderHeffernan/TheLastLight` | Repository queried for recent changes |
| `GITHUB_TOKEN` | unset | Optional token for higher GitHub API limits |
| `BUILD_TIMESTAMP` | startup time | Millisecond build time shown on the menu |
| `LAST_UPDATE` | unset | Explicit ISO update time override |

See [`.env.example`](.env.example) for a local template.

### Optional self-hosted TURN relay

Direct STUN connections remain the default. To relay duo traffic for restrictive networks, point a public DNS name at the Docker host, forward TCP/UDP 3478 and UDP 49160–49200 through its firewall/router, and set `TURN_URLS`, `TURN_EXTERNAL_IP`, and a long random `TURN_SHARED_SECRET`. Then start the optional profile:

```sh
docker compose --profile turn up -d
```

The app server uses the shared secret to issue one-hour coturn REST credentials from `/api/ice-servers`; the secret itself is never built into or returned to the browser. The included service is plain TURN on 3478. Production operators may additionally terminate TURN/TLS on 5349 with their own coturn certificate configuration.

Cloudflare's standard HTTP Tunnel does **not** proxy arbitrary TURN UDP or the relay port range. The web app may remain behind a Cloudflare Tunnel, but coturn must be independently reachable on a public IP (or through a separately purchased/configured Cloudflare Spectrum product). If those ports cannot be exposed, leave TURN unset and the game continues using direct STUN only.

### Manage special skin access

On first startup, the server seeds the existing special-skin callsigns into `game-data.json` in `DATA_DIR`. After that, the file is the persistent source of truth and the client receives the matching skin IDs when it verifies a callsign. The server keeps this small access table in memory, so it does not add a database read to gameplay or menu rendering.

Set a long random `SKIN_ADMIN_TOKEN` in the server environment, then use the protected endpoint to add or remove access without editing the file by hand:

```sh
curl -X POST https://your-game-host.example/api/admin/skin-access \
  -H "Authorization: Bearer $SKIN_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"skinId":"alexander_heffernan","callsign":"NewSurvivor"}'
```

Use `GET` on the same endpoint to inspect the table, or `DELETE` with the same JSON body to revoke an entry. The endpoint is disabled unless `SKIN_ADMIN_TOKEN` is configured. The available skin IDs are `alexander_heffernan`, `galen_green`, `cara_lill`, and `oliver_heffernan`.

## Scripts

- `npm run dev` — run the Vite development client
- `npm run typecheck` — check browser and server TypeScript
- `npm run build:changelog` — generate the checked build fallback from GitHub
- `npm run build:client` — build the Phaser client
- `npm run build:server` — compile the Node server
- `npm run build` — run all checks and production builds
- `npm start` — serve the production build and API

## Project Layout

- `src/scenes/` — Phaser scene lifecycle and combat coordination
- `src/systems/` — lighting, audio, supplies, flares, and wave direction
- `src/ui/` — landing screen, modal, and leaderboard behavior
- `src/network/` — private-room WebRTC session, protocol, and launch state
- `src/assets/` — runtime-ready game assets and typed load manifest
- `server/` — static server, leaderboard persistence, and changelog API
- `public/menu/` — landing-screen hero and title artwork
- `scripts/` — build-time metadata generation

## Architecture Notes

- Gameplay is a fixed-resolution 960×540 Phaser scene scaled to the available desktop viewport.
- Darkness and light occlusion use cached render textures and bounded shadow-caster updates to preserve performance.
- A deployment is counted when a gameplay run starts, including redeployments.
- Leaderboard records rank by eliminations, then survival time, and retain one best solo run per anonymous browser profile and one best duo run per normalized callsign pair. A long-lived first-party cookie claims callsigns across both modes, so a callsign first used in a duo is protected just like one first used in solo. The public client submits these records, so the leaderboard is intended for friendly competition rather than cheat-proof verification.
- Duo gameplay remains direct browser-to-browser WebRTC; the server brokers signaling and reconnection offers but does not relay gameplay traffic. Networks that prohibit all direct peer paths require a separately configured relay service.
- Persistent JSON data, including special skin access, is loaded into memory and written through a serialized queue to a temporary file before being atomically renamed. This keeps Raspberry Pi reads fast while preserving the existing crash-safe storage approach.
- GitHub Actions publishes both ARM64 and AMD64 images to GHCR on pushes to `main`.

## Contributing

Contributions and issue reports are welcome. Before opening a pull request, run:

```sh
npm run typecheck
npm run build
```

## Credits

- **Alexander Heffernan** — creator, developer, game designer, and pixel-art pipeline direction
- **Galen Green** — Mobile Developer
- Original music generated with [Suno](https://suno.com/)
- Built with Phaser and open-source web tooling

The Last Light is not affiliated with or endorsed by Suno.

## License

The source code and documentation are available under the [MIT License](LICENSE) © 2026 Alexander Heffernan. The music in `src/assets/audio` is excluded from the MIT License; see [Asset Licensing](ASSET-LICENSES.md). The repository as a whole is therefore not offered under a single license. Bundled dependency notices are included in [Third-Party Notices](public/THIRD_PARTY_NOTICES.txt).
