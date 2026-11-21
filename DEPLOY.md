# Deploying svelte-water3D as a systemd service + Caddy

This doc covers running `npm run preview` as a systemd service and fronting it with Caddy. Everything here is meant to be applied manually on your external server.

## Overview

```
Caddy (:443/:80) → reverse_proxy → vite preview (127.0.0.1:4173) → serves dist/
```

- `npm run preview` serves the **built** app from `dist/`, so always run `npm run build` first.
- Vite preview listens on `http://localhost:4173` by default. Keep it bound to localhost and let Caddy be the only public entry point.

## 1. Deploy the app on the server

```bash
# copy the project (exclude node_modules, rebuild on the server)
scp -r svelte-water3D user@server:/srv/svelte-water3d
# on the server:
cd /srv/svelte-water3d
npm install
npm run build
```

Deployment path used below: **`/srv/svelte-water3d`** (adjust to taste, keep it consistent in the unit file).

## 2. systemd service

**Location:** `/etc/systemd/system/svelte-water3d.service`

```ini
[Unit]
Description=svelte-water3D (vite preview server)
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/srv/svelte-water3d
ExecStart=/usr/bin/npm run preview -- --host 127.0.0.1 --port 4173
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

Notes:
- `/usr/bin/npm` — adjust if your Node install lives elsewhere (`which npm`). If you use nvm, point `ExecStart` at the absolute path, e.g. `/home/user/.nvm/versions/node/v22.x/bin/npm`.
- `--host 127.0.0.1` keeps the server private; only Caddy should expose it.
- Run `npm run build` manually after each deploy; the service only serves `dist/`.

### Enable / manage

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now svelte-water3d.service
systemctl status svelte-water3d.service
journalctl -u svelte-water3d.service -f        # live logs
sudo systemctl restart svelte-water3d.service  # after rebuilds (usually not needed)
```

## 3. Caddyfile fragment

**Location:** `/etc/caddy/Caddyfile` (system-wide) or `~/.config/caddy/Caddyfile` (user-run Caddy). Append this site block:

```caddy
water.yourdomain.com {
  reverse_proxy 127.0.0.1:4173 {
    # optional: pass through headers / health checks
    health_check /index.html
  }

  # security headers (cyberpunk app, why not)
  header {
    X-Content-Type-Options nosniff
    X-Frame-Options DENY
    Referrer-Policy strict-origin-when-cross-origin
  }
}
```

- With a real domain, Caddy handles Let's Encrypt TLS automatically — no extra config.
- No DNS yet? Use `localhost:8080 { reverse_proxy 127.0.0.1:4173 }` for a plain-HTTP test on the server.

### Reload Caddy

```bash
sudo caddy validate --config /etc/caddy/Caddyfile   # check syntax first
sudo systemctl reload caddy
# or: sudo caddy reload --config /etc/caddy/Caddyfile
```

## 4. Redeploy workflow

```bash
cd /srv/svelte-water3d
git pull            # or re-copy the folder
npm install         # only if deps changed
npm run build       # regenerates dist/ — picked up live, no restart needed
```

## Troubleshooting

| Symptom | Check |
|---|---|
| 502 from Caddy | `systemctl status svelte-water3d` and `curl -s http://127.0.0.1:4173` |
| Service fails on start | `journalctl -u svelte-water3d -b` — usually wrong npm path or missing `dist/` |
| Permission denied on `dist/` | `chown -R www-data:www-data /srv/svelte-water3d` |
| Firewall | open 80/443 only: `sudo ufw allow 80,443/tcp` |
