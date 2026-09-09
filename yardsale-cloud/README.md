# YardSale Cloud

A dependency-free control-plane prototype for the YardSale Cloud SaaS plan. It is a small Node.js modular monolith designed to run economically on one server and keep the seams clear for production adapters.

Implemented slices:

- scrypt accounts, HTTP-only sessions, CSRF, email verification links, signup/login limits, and blocklist checks;
- policy, campaign, coupon, entitlement precedence, manual comps, quota overrides, and audit history;
- renewable free stores, paid reactivation, grace/deletion lifecycle, persistent runtime directories, and retries;
- local runtime plus rootless Podman/Quadlet adapter with host ports, resource-safe container defaults, and an explicit migration seam;
- seller dashboard with URL, plan, expiry, storage, runtime, marketplace opt-in, billing, and delete controls;
- billing provider contract, mock checkout/webhook, idempotent payment grants, refunds, and an ABA PayWay hosted checkout/callback adapter;
- signed federation ingestion, reconciliation, SQLite FTS5 search, location/condition/price filters, ranking, deep-link click tracking, and marketplace metrics;
- listing/store reports, moderation queue, phrase/email/domain/IP blocklist, de-indexing, account/store suspension, and audit events;
- fixed-price sponsored promotions, promotion expiry, score refresh, and sponsored labels;
- local backups with manifests/retention, restore guardrails, canary-style upgrade rollback, guarded migration seams, health/readiness/Prometheus endpoints, legal pages, and operations scripts.

The default development runtime uses native Node SQLite and writes tenant instance data under `.yardsale-cloud/instances/`. Production deployment assets target a rootless Podman control-plane container behind Caddy; wildcard seller-host routing is intentionally left disabled until a tenant-aware gateway is installed. PostgreSQL, an actual payment gateway callback, offsite Restic storage, and host provisioning should be swapped in before public launch.

## Run it

```bash
cd yardsale-cloud
npm test
npm run check
npm run dev
```

Open [http://localhost:3010](http://localhost:3010). The first account becomes the local operator account so the admin console is immediately testable. The development verification URL is printed in the server log.

Useful configuration is documented in [`.env.example`](.env.example). Set `YARDSALE_CLOUD_BASE_DOMAIN` and `YARDSALE_CLOUD_PUBLIC_ORIGIN` for a real domain, `YARDSALE_CLOUD_DATA_DIR` for persistent data, `YARDSALE_CLOUD_RUNTIME=podman` to generate Quadlet units, and `YARDSALE_CLOUD_RUNTIME_EXECUTE=true` only on a host where rootless systemd is configured. Set `YARDSALE_CLOUD_TRUST_PROXY=true` only when the listed proxy addresses are the direct peers. Set `YARDSALE_CLOUD_BILLING_PROVIDER=aba-payway` with merchant credentials only after sandbox callback and return-URL validation.

Operational procedures are in [`OPERATIONS.md`](OPERATIONS.md); deployment examples live under [`deploy/`](deploy/).
