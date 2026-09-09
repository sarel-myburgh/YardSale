# YardSale Cloud operations

This project is intentionally deployable as one control-plane process. The local runtime and mock billing provider make the workflows testable without pretending that a production host or gateway is already configured.

## Health and monitoring

- `GET /healthz` is a process liveness check.
- `GET /readyz` verifies that the control-plane database is queryable and reports the selected runtime/billing adapters.
- `GET /metrics` emits Prometheus text. Set `YARDSALE_CLOUD_METRICS_TOKEN` to require `Authorization: Bearer …`.
- Run `deploy/capacity-test.sh` against staging before increasing the host density. The script reports health, readiness, metrics, and optional request timing for 10/50/100/200-store target runs.
- Run `deploy/monitor.sh` from a scheduled check to fail on unhealthy readiness or high data-volume usage; see [`INCIDENT_RESPONSE.md`](INCIDENT_RESPONSE.md) for the recovery loop.
- The control-plane job loop reconciles lifecycle/search/promotions every minute and writes a local backup on the interval set by `YARDSALE_CLOUD_BACKUP_INTERVAL_HOURS` (24 hours by default).

## Backups and restores

The admin Backup action creates a local SQLite/instance snapshot with a manifest. `deploy/backup.sh` then sends the configured data directory to Restic when `RESTIC_REPOSITORY` and the Restic credentials are present. Test a restore on a separate data directory before relying on it.

```bash
./deploy/restore-backup.sh /srv/yardsale-cloud/backups/20260908120000000-ab12cd34 /srv/yardsale-cloud-data
```

The restore script refuses to overwrite an existing database. Stop the service first, verify the snapshot, then start the service and check `/readyz`.

## Releases and migration

Use immutable OCI image tags. The admin upgrade action upgrades stores in order and attempts to roll back completed stores if a later runtime upgrade fails while preserving suspended stores as stopped. Podman migration is currently rejected because the runtime adapter does not transfer tenant data; do not treat a host allocation change as a migration. Install a real data-transfer adapter before enabling that operation.

Keep `YARDSALE_CLOUD_RUNTIME_EXECUTE=false` in development. On a real rootless Podman host, install Quadlet/systemd user services, set the runtime to `podman`, and test one canary store before enabling broad upgrades. Set `YARDSALE_CLOUD_TRUST_PROXY=true` only when Caddy is the direct peer and its address is listed in `YARDSALE_CLOUD_TRUSTED_PROXY_ADDRESSES`. The example Caddy file leaves wildcard seller routing disabled until a tenant-aware gateway is configured.

## Public-beta gates

Before accepting real sellers, complete these external checks:

1. configure a tenant-aware gateway plus DNS/TLS; keep wildcard seller routing disabled until that gateway is in place;
2. replace local SQLite/off-server backup assumptions with the chosen production database and encrypted offsite backup target;
3. validate ABA PayWay merchant signing, callback replay protection, reconciliation, refunds, and settlement handling;
4. run a security review, restore drill, capacity benchmark, abuse escalation drill, and legal review;
5. set a long random webhook secret, secure cookies, verified email, metrics authentication, immutable image tags, and an incident contact.
