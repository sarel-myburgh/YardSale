# YardSale Cloud incident response

This is the minimum response loop for a one-operator deployment. Keep the incident notes outside the application data directory so a restore does not erase them.

## Triage

1. Run `deploy/monitor.sh` and capture `/readyz`, `/metrics`, recent service logs, and the current image tag.
2. If the host or disk is unhealthy, stop new provisioning and promotion purchases at the reverse proxy, then preserve the database and instance directories.
3. If abuse or prohibited content is involved, de-index the store, suspend the store or account, and record the report ID and operator action in the admin audit trail.

## Recovery

- Restore only to a stopped, empty data directory with `deploy/restore-backup.sh`.
- Run a restore drill on a separate temporary directory before using a snapshot for production recovery.
- Start the service, verify `/healthz` and `/readyz`, inspect one canary store, then run the marketplace reconciliation and review open reports.
- For a failed release, use the admin upgrade rollback behavior and keep the failed image tag plus audit events for follow-up.

## Payment discrepancies

Do not grant an entitlement from a browser redirect alone. Reconcile the provider transaction reference, signed callback, payment status, amount, and local payment row before correcting access. Record refunds and manual corrections as audited entitlements.

## Closeout

Record impact, start/end time, affected stores, root cause, data loss (if any), recovery snapshot, customer communication, and the follow-up owner. Review the public-beta gates before reopening signups or paid checkout.
