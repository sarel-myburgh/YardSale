# YardSale

YardSale is a small, self-hosted storefront for selling second-hand goods.

## Quick start

Docker is the easiest path:

```bash
docker compose up -d --build
```

Open [http://localhost:3000](http://localhost:3000). The first launch goes
straight to the seller setup screen. Create the account and store there; no
`.env` file or environment-variable setup is required.

The `yardsale-data` volume persists the database and photos across container
restarts and replacements. The supplied Compose service also runs as the
unprivileged `node` user with a read-only root filesystem, a temporary `/tmp`,
no added capabilities, and `no-new-privileges`.

## Local development

Node.js 22.5 or newer is required because YardSale uses Node's built-in SQLite
support.

```bash
npm ci
npm run check
npm test
npm run dev
```

Local data is stored in `.yardsale/`. The app still starts with a first-run
setup screen when that directory is empty.

## What is included in v1

- First-run seller account and store setup with a simple 10-character minimum
  password rule.
- Password login/logout with Argon2id, HTTP-only sessions, CSRF protection,
  and login rate limiting.
- Store settings for currency, searchable city-based timezones, structured
  public location, contact methods, comments, hold timers, and federation.
- Listing create/edit/hide, public visibility, multi-photo galleries, mark
  reserved, mark sold, and deletion.
- JPG, PNG, and WebP uploads with magic-byte validation, bounded file sizes,
  browser resizing, and portrait/landscape-friendly galleries.
- Public storefront search, filters, item pages, seller contact details,
  buyer hold requests, private reservation links, moderation, and abuse limits.
- Versioned ZIP export/import containing settings, listings, photos,
  reservations, and comments. Seller login credentials remain local during an
  import.
- Optional public federation manifest/feed with public-only fields,
  structured location, ETag/Last-Modified caching, and optional signed
  managed control requests.
- Health/readiness endpoints and Docker/Podman deployment examples.

## Backups and restore

The simplest backup is the seller-only export flow:

1. Sign in and open **Export / import**.
2. Select **Download export** and keep the `.zip` somewhere safe.
3. On a new instance, create the first seller account, open the same page, and
   import the export.

For an infrastructure-level volume backup, stop the service first so SQLite's
WAL files are included consistently. Substitute the actual volume name shown
by `docker volume ls`:

```bash
docker compose stop
docker run --rm \
  -v garagesale_yardsale-data:/data:ro \
  -v "$PWD/backups":/backup \
  busybox tar czf /backup/yardsale-data-$(date +%Y%m%d-%H%M%S).tar.gz -C /data .
docker compose start
```

Keep at least one backup away from the host running YardSale. Never publish the
database or uploads directory directly through a web server.

## Upgrades

With the included Compose file:

```bash
docker compose pull
docker compose up -d
```

For a locally built checkout use `docker compose up -d --build`. Back up the
store before upgrades. Database migrations run automatically when the new
container starts; the included migration test covers the legacy reservation
and listing status changes.

Released images use immutable semantic-version tags, for example:

```bash
docker pull ghcr.io/sarel-myburgh/yardsale:1.0.0
```

## Podman

Podman Compose can use the same file:

```bash
podman compose up -d --build
```

For a direct rootless run:

```bash
podman volume create yardsale-data
podman build --tag yardsale:local .
podman run --detach --name yardsale \
  --publish 3000:3000 \
  --read-only --tmpfs /tmp --cap-drop=ALL \
  --security-opt no-new-privileges:true \
  --volume yardsale-data:/data:Z \
  yardsale:local
```

The first visit to port 3000 opens the setup screen; there are no required
Podman environment variables.

### Quadlet

`deploy/yardsale.container` is a rootless Quadlet example. Edit the image tag
if using a different registry, then run:

```bash
mkdir -p ~/.config/containers/systemd
cp deploy/yardsale.container ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user enable --now yardsale.service
```

Use `systemctl --user status yardsale.service` to inspect the service and
`journalctl --user -u yardsale.service` for logs.

## HTTPS and reverse proxy

Keep YardSale bound to localhost or a private network and terminate HTTPS at a
reverse proxy. `deploy/Caddyfile.example` is a minimal Caddy configuration:

```caddyfile
yardsale.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

The proxy should pass the original `Host` and `X-Forwarded-Proto` headers.

## Optional federation

The **Allow public marketplace indexing** setting controls the public manifest
and listing feed. Buyer names, contact details, reservation tokens, comments,
and seller-only metadata are never included. Location data is public only when
you choose to fill it in.

For a managed installation, an optional federation control secret can be set
in **Store settings**. A control-plane caller signs the exact request body with
HMAC-SHA256 over `unix_timestamp.body` and sends:

```text
X-YardSale-Timestamp: 1760000000
X-YardSale-Signature: sha256=<hex digest>
```

Requests outside the five-minute replay window or with a changed body are
rejected. Normal self-hosted users can leave this setting blank.

## Verification and benchmarks

Run the complete local checks with:

```bash
npm run check
npm test
```

The optional `deploy/benchmark.sh` builds a container, checks startup through
`/healthz`, and prints image size and current container memory. It accepts
`docker` (default) or `podman` as its first argument:

```bash
deploy/benchmark.sh docker yardsale:benchmark
```

## License

YardSale is released under the [MIT License](LICENSE).
