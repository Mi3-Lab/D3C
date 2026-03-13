# Always-On PC Deployment

This repo can run on an always-on Linux lab computer with Docker and Cloudflare Tunnel.

## Requirements

- Docker Engine with Docker Compose
- A Cloudflare account
- A domain managed in Cloudflare
- A Cloudflare Tunnel token
- Outbound internet access from the lab computer

## Files Added

- `Dockerfile`
- `docker-compose.yml`
- `.env.example`

## Runtime Persistence

The app now supports these environment overrides:

- `DATASETS_ROOT`
- `AUTH_STATE_PATH`

The compose file stores:

- datasets in Docker volume `d3c_datasets`
- join-code/auth state in Docker volume `d3c_auth`

## First Run

1. Copy `.env.example` to `.env`.
2. Set `TUNNEL_TOKEN` to your Cloudflare Tunnel token.
3. Start the stack:

```bash
docker compose up -d --build
```

4. Check logs:

```bash
docker compose logs -f
```

5. Open:

- `https://<your-cloudflare-hostname>/dashboard`
- `https://<your-cloudflare-hostname>/phone`

## Cloudflare Tunnel Setup

Create a named tunnel in Cloudflare and point a hostname at it.

The public hostname should forward to:

- service type: `HTTP`
- URL: `http://app:3000` if tunnel runs inside this compose stack

Then copy the tunnel token into `.env`.

## Updating

```bash
git pull
docker compose up -d --build
```

## Backups

Back up:

- Docker volume `d3c_datasets`
- Docker volume `d3c_auth`
- your Cloudflare DNS/tunnel configuration

## Notes

- This setup does not require inbound port forwarding on the school network.
- Cloudflare provides the public HTTPS endpoint.
- The lab machine only needs outbound connectivity.
