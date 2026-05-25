# OpenConduit Relay Server

Self-hostable relay server for [OpenConduit](https://openconduit.ai). Implements the same HTTP + WebSocket API as the hosted `share.openconduit.ai` service so you can run live collaboration rooms and conversation sharing on your own infrastructure.

## Features

- **V1 — Shared conversations** `POST /share`, `GET /share/:id`, `DELETE /share/:id`  
  Snapshots stored in SQLite with a 30-day TTL.
- **V2 — Live collaboration rooms** `POST /rooms`, `WS /rooms/:id`  
  In-memory rooms backed by WebSocket (Node.js `ws`). State is ephemeral — rooms persist as long as at least one participant is connected.

## Quick start

### Docker (recommended)

```bash
BASE_URL=https://my-relay.example.com docker compose up -d
```

### Manual

```bash
npm install
npm run build
BASE_URL=https://my-relay.example.com PORT=3000 npm start
```

For development with live reload:

```bash
npm run dev
```

## Environment variables

| Variable   | Default                      | Description                                              |
|------------|------------------------------|----------------------------------------------------------|
| `PORT`     | `3000`                       | HTTP listen port                                         |
| `BASE_URL` | `http://localhost:<PORT>`    | Public base URL — used in generated share & room links   |
| `DB_PATH`  | `./data/relay.db`            | Path to SQLite database file                             |

Copy `.env.example` to `.env` and fill in `BASE_URL` before running.

## Connecting OpenConduit

1. Open OpenConduit → **Settings** → **Sharing** → **Self-Hosting**
2. Paste your `BASE_URL` (e.g. `https://my-relay.example.com`)
3. Save — all future share links and live rooms will use your server

## Deploying

Any host that can run Node.js 22+ works. The `data/` directory (or wherever `DB_PATH` points) needs to be on persistent storage.

Reverse proxy example (nginx):

```nginx
location / {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

The `Upgrade` / `Connection` headers are required for WebSocket connections to live rooms.

## License

AGPL-3.0 — same as OpenConduit. See [LICENSE](LICENSE).
