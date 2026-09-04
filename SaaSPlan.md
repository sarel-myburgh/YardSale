# YardSale — SaaS Platform Project and Build Plan

**Project:** YardSale Cloud  
**Role:** Managed hosting, billing, lifecycle control, local marketplace search, promotions, and operations  
**Initial infrastructure philosophy:** One inexpensive server, boring technology, low OPEX  
**Hosted container runtime:** Rootless Podman + systemd/Quadlet  
**Store image:** Same FOSS OCI image as self-hosted YardSale

---

# 1. Goal

YardSale Cloud should make the FOSS YardSale Store effortless to use for non-technical sellers.

The commercial service sells:

- managed hosting
- continuity
- retained URL/data
- automatic HTTPS
- backups
- upgrades
- central local marketplace discovery
- optional promotions

It does **not** process payments between buyers and sellers.

The initial system should be able to run economically on a single low-cost Hetzner/Netcup-class VPS or auction server and migrate to additional hosts only when actual usage requires it.

---

# 2. Commercial Model

## Renewable free-store model

The free offering is intentionally renewable, not a one-time trial.

Normal default policy:

```text
1 free active store per account
14 days free per newly-created free store
no central marketplace indexing
```

When the free store expires, the user has two choices.

### Option A — Pay

Pay the configured store extension price.

Default:

```text
$5 -> +30 days
```

Result:

- same store
- same URL
- same listings/photos
- same comments/reservation history
- central marketplace indexing becomes eligible
- no need to repost links

### Option B — Start another free store

User may immediately create a new free store, but:

- it gets a new store identity/URL
- it starts empty
- listings are not automatically cloned
- hosted restore/import from the expired store is not a free one-click bypass
- seller must upload/recreate items and reshare the URL

This friction is intentional.

The platform is competing with free marketplaces. The paid value proposition is continuity and discovery, not a crippled storefront.

## Expired data grace period

Default:

```text
14 days
```

During grace:

- expired store is offline
- data remains retained
- paying can reactivate the same store

After grace:

- store may be deleted according to retention policy

All durations are configuration/policy values, not constants.

---

# 3. Commercial Rules Must Be Configurable

Do not hardcode:

- free duration
- paid duration
- price
- grace period
- marketplace eligibility
- quotas
- simultaneous free stores
- promotion windows
- free campaigns

Use a policy/entitlement system.

## Precedence

Recommended resolution order:

```text
Global defaults
    ↓
Active campaign/promotion
    ↓
Coupon entitlement
    ↓
Account/store entitlement
    ↓
Explicit admin override
```

The effective result is what controls the instance.

## Examples

Admin should be able to run:

- everyone gets 30 days free this month
- new Cambodia accounts get 60 days
- coupon `PHNOMPENH30` gives 30 days
- comp Store X for 90 days
- give a friend permanent premium access
- temporarily enable marketplace indexing for a specific store
- increase storage for a specific account
- set $3 pricing for a promotion
- set $0 pricing for a campaign

No redeployment should be required.

---

# 4. Policy and Entitlement Data Model

## PlatformPolicy

Fields:

- key
- value
- scope
- effective_from
- effective_until
- updated_by
- updated_at

Examples:

```text
default_free_days = 14
default_paid_days = 30
default_store_price_minor = 500
default_grace_days = 14
free_active_store_limit = 1
paid_marketplace_enabled = true
```

## Campaign

Fields:

- id
- name
- status
- starts_at
- ends_at
- eligibility_rule
- free_days_override nullable
- price_override nullable
- paid_days_override nullable
- marketplace_override nullable
- quota_overrides
- created_by
- created_at

## Coupon

Fields:

- id
- code
- starts_at
- ends_at
- max_redemptions
- per_account_limit
- eligibility_rule
- entitlement_payload
- status

## StoreEntitlement

Fields:

- id
- store_id
- source
- key
- value
- starts_at
- ends_at nullable
- reason
- created_by
- created_at

Possible sources:

```text
campaign
coupon
payment
admin_comp
manual_override
migration
```

## EntitlementAudit

Record:

- actor
- store/account
- change
- previous value
- new value
- reason
- timestamp

All manual comps and overrides must be auditable.

---

# 5. Initial Infrastructure

## Single-server target

Start with:

```text
Linux server
|
+-- Caddy
|
+-- YardSale Cloud control plane
|
+-- PostgreSQL
|
+-- Rootless Podman
|    +-- Store A
|    +-- Store B
|    +-- Store C
|    +-- ...
|
+-- background workers inside control-plane process or small worker
|
+-- Restic
     +-- offsite backup target
```

Avoid initially:

- Kubernetes
- Redis
- RabbitMQ
- Kafka
- managed PostgreSQL
- separate search cluster
- service mesh
- multiple microservices unless necessary
- paid cloud services without clear benefit

## Search

Use PostgreSQL initially.

Capabilities:

- PostgreSQL full-text search
- `pg_trgm`
- structured filters
- local/location filters
- promotion ranking fields

Do not add Meilisearch/Typesense until PostgreSQL is demonstrably inadequate.

---

# 6. Rootless Podman Runtime

Hosted instances run as rootless Podman containers.

Goals:

- daemonless/runtime simplicity
- non-root tenancy
- systemd integration
- clean process supervision
- OCI portability

Use Quadlet/systemd units for managed instance lifecycle where practical.

The FOSS store remains runtime-agnostic.

## Runtime abstraction

The control plane should use an internal interface:

```text
createInstance()
startInstance()
stopInstance()
suspendInstance()
resumeInstance()
deleteInstance()
inspectInstance()
upgradeInstance()
```

Initial implementation:

```text
PodmanRuntime
```

A Docker/Kubernetes implementation could be added later without changing commercial logic.

---

# 7. Control Plane Components

The initial control plane may be a modular monolith.

Responsibilities:

- authentication
- account dashboard
- store provisioning
- runtime orchestration
- billing
- policy resolution
- promotions/coupons
- search ingestion
- marketplace
- moderation
- admin console
- backups
- operational jobs

Prefer one deployable application over microservices initially.

---

# 8. Core SaaS Data Model

## User

- id
- email
- email_verified_at
- password_hash or auth reference
- status
- created_at

## HostedStore

- id
- user_id
- public_id
- slug
- hostname
- deployment_host_id
- runtime_instance_id
- image_version
- state
- mode
- created_at
- current_period_ends_at
- grace_ends_at
- deletion_scheduled_at
- storage_bytes
- updated_at

Modes:

```text
free
paid
comped
```

States:

```text
provisioning
running
expired
suspended
failed
deleting
deleted
```

## DeploymentHost

- id
- hostname
- region
- CPU capacity
- memory capacity
- disk capacity
- instance count
- status
- last heartbeat

## Payment

- id
- user_id
- store_id
- provider
- amount_minor
- currency
- status
- provider_reference
- entitlement_days
- created_at

## SearchListing

- id
- store_id
- remote_listing_id
- store_name
- title
- description_excerpt
- price_minor
- currency
- category
- tags
- condition
- status
- country_code
- region
- city
- area
- display_location
- latitude nullable
- longitude nullable
- canonical_url
- thumbnail_url
- source_updated_at
- indexed_at
- promotion_score

## PromotionPurchase

- id
- store_id
- listing_id nullable
- promotion_type
- amount_minor
- starts_at
- ends_at
- status
- payment_id

## AuditEvent

- id
- actor
- user_id nullable
- store_id nullable
- action
- metadata
- created_at

---

# 9. Provisioning Workflow

User creates a store.

Control plane:

1. resolves effective policy
2. verifies active-free-store rules
3. allocates store ID
4. allocates unique hostname
5. chooses deployment host
6. creates persistent directory
7. generates instance secrets
8. creates rootless Podman container/Quadlet
9. registers Caddy route
10. waits for `/readyz`
11. bootstraps store
12. applies commercial entitlement state
13. marks Running
14. records audit event

Provisioning must be idempotent.

Retries may not create:

- duplicate store rows
- duplicate directories
- duplicate hostnames
- duplicate free entitlements
- duplicate containers

---

# 10. Multiple Store Rules

Default:

```text
one free active store per account
```

User may have:

- one active free store
- any number of paid/comped stores, subject to policy

Each store is billed independently.

Example:

```text
Account
  Store A — free
  Store B — paid $5/30 days
  Store C — paid $5/30 days
```

If Store A expires, the user may:

- pay to reactivate Store A
- create a new free Store D

Store D is new and empty.

---

# 11. Expiry State Machine

```text
FREE RUNNING
    |
    | free period ends
    v
EXPIRED / GRACE
    |
    +---- payment/comp ----> RUNNING
    |
    +---- grace ends ------> DELETE SCHEDULED
                                  |
                                  v
                               DELETED
```

Paid stores use the same model based on `current_period_ends_at`.

At expiry:

- public store returns expiry page
- marketplace listing is removed
- data remains during grace
- dashboard remains accessible
- payment can restore same URL/data

---

# 12. Marketplace Eligibility

Default policy:

```text
Free stores:       not indexed
Paid stores:       indexed
Comped premium:    indexed
```

This is configurable.

Eligibility requires:

- store Running
- effective entitlement allows marketplace
- seller has not opted out
- listing is public
- listing is not Sold
- listing passes moderation rules

Admin/campaign policy may override this.

Marketplace indexing is a commercial benefit and a spam barrier.

---

# 13. Location Model

YardSale discovery is primarily local.

Store container supplies structured public location.

Central search should support:

- country
- region/state/province
- city
- area/neighborhood
- free-text display location

Future:

- latitude/longitude
- radius filtering
- map UI

Do not require precise address.

Launch can begin Cambodia-first while the schema remains global.

---

# 14. Search Ingestion

Do not query tenant containers live for user searches.

Maintain a central copy of public metadata.

Recommended flow:

```text
Store change
   |
   +--> signed webhook to control plane
             |
             v
        PostgreSQL index
```

Also run periodic reconciliation against:

```text
/api/federation/v1/listings
```

Webhook gives speed.

Reconciliation gives correctness.

Do not ingest buyer/private data.

---

# 15. Search Ranking

Initial organic ranking can consider:

1. textual relevance
2. exact/local location relevance
3. availability
4. freshness
5. promotion score
6. deterministic rotation for otherwise equal results

Search should support:

- query
- country
- city
- area
- category
- condition
- min/max price
- currency
- newest
- price order

---

# 16. Promotions

Do not build auction bidding first.

Initial promotion primitive:

- fixed-price
- time-based
- clearly labelled sponsored placement

Possible products:

```text
Feature listing for 24 hours
Feature store for 24 hours
Category boost
Local-area boost
```

If no paid promotion occupies a featured slot:

- rotate eligible paid marketplace listings
- use deterministic hourly/randomized rotation

Auction-style ranking can be added when there is enough demand for bidding to be meaningful.

Promotion pricing must be policy-configurable.

---

# 17. Payment Architecture

Buyer-to-seller payments remain entirely external.

YardSale Cloud only charges for:

- hosted store time
- promotions
- future optional commercial features

## Billing abstraction

Define:

```text
createCheckout()
verifyWebhook()
recordPayment()
grantEntitlement()
refundPayment()
getPaymentStatus()
```

Do not embed one provider into core business logic.

## Initial provider strategy

The initial gateway must support a Cambodia-operated business and international customers.

Treat ABA PayWay as the first provider candidate to validate/implement, behind the provider abstraction.

Future providers can be added without changing store lifecycle logic.

Payment success creates an entitlement, e.g.:

```text
$5 -> +30 days
```

Paid days stack from the later of:

- current effective expiry
- current time

Webhook processing must be idempotent.

---

# 18. Admin Console

Admin UI is a first-class operational feature.

## User/store actions

- search users
- search stores
- inspect state
- suspend/resume
- de-index
- delete
- restore during grace
- move store to another host
- trigger backup
- trigger upgrade

## Commercial actions

Admin can:

- extend free time
- add paid-equivalent time
- set explicit expiry
- comp store
- comp premium permanently
- enable/disable marketplace
- override quotas
- alter price entitlement
- attach campaign/coupon
- revoke entitlement

Suggested quick actions:

```text
+7 days
+14 days
+30 days
+90 days
Custom date
Comp premium
Lifetime comp
```

Every action requires:

- actor
- reason/note
- old value
- new value
- timestamp

## Policy/campaign management

Admin can:

- edit global defaults
- create campaign
- schedule campaign
- pause campaign
- create coupon
- set redemption limits
- set eligibility
- override free days
- override paid days
- override price
- override marketplace access
- override quotas

Example:

```text
Campaign: Launch Month
Starts: 2026-10-01
Ends:   2026-10-31
Free days: 30
```

No code deployment required.

---

# 19. Trial/Free Abuse Controls

Because free stores are renewable, abuse controls matter.

Use minimally invasive controls initially:

- verified email
- one active free store/account
- rate-limit store creation
- CAPTCHA when suspicious
- disposable-email checks
- signup/IP velocity limits
- moderation/reporting

Do not defeat the free model by making it painful for legitimate users.

Marketplace indexing remains paid-only by default, reducing the incentive for spam farms.

---

# 20. Storage and Resource Limits

Avoid marketing "unlimited."

Initial hosted defaults should be configurable.

Example starting hypotheses:

```text
Store memory limit:       64–128 MB initially, benchmark first
CPU limit:                low shared quota
Storage:                  1 GB
Listings:                 generous
Images:                   generous within storage quota
```

Because the store application is designed for very low idle RAM, benchmark real density.

Create a capacity test that provisions:

```text
10 stores
50 stores
100 stores
200 stores
```

and measures:

- idle RAM
- CPU
- disk
- startup time
- simultaneous page requests
- simultaneous image requests

---

# 21. Reverse Proxy and TLS

Use:

- Caddy initially
- wildcard DNS
- wildcard TLS where practical

Example:

```text
*.yardsale.example -> server
```

Routes:

```text
yardsale.example            -> control plane
<store>.yardsale.example    -> Podman store instance
```

Keep proxy configuration generated/managed by the control plane.

---

# 22. Backups

Keep backups off the production server.

Low-cost initial strategy:

```text
Restic
  -> inexpensive S3-compatible/B2/R2 storage
```

Back up:

- PostgreSQL
- each store `/data`
- critical configuration

Suggested defaults:

- nightly store backup
- nightly PostgreSQL backup
- 7–14 day retention initially

Test restores.

A backup that has never been restored is not considered operationally validated.

---

# 23. Host Migration / Scaling

Design for one server first, but avoid painting the system into a corner.

A store is movable because its state is:

```text
OCI image + /data + configuration
```

Host migration workflow:

1. stop/suspend store
2. copy `/data`
3. provision same image on destination
4. update proxy routing
5. verify readiness
6. resume
7. remove old instance

When one server becomes insufficient:

- add DeploymentHost B
- new stores can be placed there
- migrate selected stores

Do not introduce Kubernetes just because a second server exists.

---

# 24. Security

The control plane is the highest-value target.

Requirements:

- admin MFA
- rootless Podman
- no public container runtime socket
- no arbitrary image execution
- no arbitrary host mounts
- no privileged containers
- strict runtime abstraction
- per-store secrets
- signed control-plane/store requests
- encrypted offsite backups
- least privilege
- audit logs
- rate limiting
- dependency scanning
- image signing where practical
- immutable release tags
- restore drills
- incident runbook

Do not rely on source secrecy for security.

The control plane may remain proprietary for commercial/product reasons, but architecture must assume attackers can discover how it works.

---

# 25. Source Strategy

Current working model:

```text
yardsale-store      FOSS
yardsale-protocol   public/open specification
yardsale-cloud      proprietary initially
yardsale-host-agent proprietary initially if separated
```

The store must not be crippled relative to hosted operation.

Cloud value comes from:

- convenience
- continuity
- backups
- operations
- discovery
- promotion

Whether the control plane becomes open source later remains a business decision.

---

# 26. Observability

Measure:

- active stores
- free stores
- paid stores
- comped stores
- expiry/reactivation
- free -> paid conversion
- repeat free-store creation
- marketplace searches
- listing clickthrough
- reservations
- sold items
- provisioning failures
- container restart rate
- RAM/store
- disk/store
- host resource usage
- backup success
- payment success/failure
- promotion revenue

Alerts:

- host unavailable
- disk threshold
- PostgreSQL failure
- backup failure
- provisioning error spike
- payment webhook failures
- search ingest backlog
- suspicious signup/store creation spike

---

# 27. Delivery Plan

## Milestone 0 — Single-Server Foundation

- [ ] Provision inexpensive Linux server.
- [ ] Install rootless Podman.
- [ ] Configure Quadlet/systemd.
- [ ] Configure Caddy.
- [ ] Deploy PostgreSQL.
- [ ] Deploy control-plane skeleton.
- [ ] Configure Restic/offsite backup.
- [ ] Configure staging domain.
- [ ] Add monitoring.

## Milestone 1 — Accounts and Policy Engine

- [ ] User signup/login.
- [ ] Email verification.
- [ ] User model.
- [ ] PlatformPolicy model.
- [ ] Campaign model.
- [ ] Coupon model.
- [ ] StoreEntitlement model.
- [ ] Entitlement audit.
- [ ] Policy precedence resolver.
- [ ] Admin global settings UI.

## Milestone 2 — Podman Provisioning

- [ ] HostedStore model.
- [ ] Podman runtime adapter.
- [ ] persistent store directory.
- [ ] generated Quadlet.
- [ ] hostname allocator.
- [ ] Caddy route.
- [ ] health/readiness checks.
- [ ] bootstrap call.
- [ ] idempotency.
- [ ] failure cleanup.

## Milestone 3 — Renewable Free Store Lifecycle

- [ ] one-active-free-store rule.
- [ ] configurable free duration.
- [ ] expiry job.
- [ ] grace period.
- [ ] expired landing page.
- [ ] immediate new free-store creation after expiry.
- [ ] prevent one-click free clone bypass.
- [ ] paid reactivation of original store.
- [ ] deletion after grace.

## Milestone 4 — Dashboard

Seller sees:

- [ ] store URL.
- [ ] Free/Paid/Comped status.
- [ ] days remaining.
- [ ] expiry.
- [ ] marketplace eligibility.
- [ ] storage use.
- [ ] Open Store.
- [ ] Open Admin.
- [ ] Pay/Extend.
- [ ] Delete.

## Milestone 5 — Billing

- [ ] Billing provider interface.
- [ ] initial Cambodia-compatible provider.
- [ ] checkout.
- [ ] webhook verification.
- [ ] idempotent payment.
- [ ] +N-day entitlement.
- [ ] price from policy engine.
- [ ] payment history.
- [ ] admin manual entitlement.

## Milestone 6 — Admin Commercial Controls

- [ ] change default free days.
- [ ] change default price.
- [ ] change paid duration.
- [ ] change grace period.
- [ ] campaign CRUD.
- [ ] coupon CRUD.
- [ ] comp store.
- [ ] lifetime comp.
- [ ] marketplace override.
- [ ] quota override.
- [ ] audit trail.

## Milestone 7 — Search Ingestion

- [ ] SearchListing model.
- [ ] signed webhook ingest.
- [ ] federation reconciliation.
- [ ] PostgreSQL FTS.
- [ ] pg_trgm.
- [ ] structured location.
- [ ] remove expired stores.
- [ ] remove Sold listings.
- [ ] paid-only eligibility policy.

## Milestone 8 — Local Marketplace

- [ ] search page.
- [ ] country/city/area filters.
- [ ] price.
- [ ] category.
- [ ] condition.
- [ ] organic ranking.
- [ ] rotation.
- [ ] deep link to tenant store.
- [ ] analytics.

## Milestone 9 — Moderation

- [ ] report listing/store.
- [ ] moderation queue.
- [ ] de-index.
- [ ] suspend store.
- [ ] suspend account.
- [ ] blocklist.
- [ ] moderation audit.

## Milestone 10 — Promotions

- [ ] fixed-price promotion products.
- [ ] policy-configurable pricing.
- [ ] promotion checkout.
- [ ] promotion expiry.
- [ ] sponsored label.
- [ ] featured rotation fallback.
- [ ] admin comp promotion.

## Milestone 11 — Backups, Upgrades, Migration

- [ ] nightly PostgreSQL backup.
- [ ] nightly store backup.
- [ ] offsite retention.
- [ ] restore function.
- [ ] image rollout.
- [ ] canary upgrade.
- [ ] rollback.
- [ ] host migration.
- [ ] restore drills.

## Milestone 12 — Public Beta

- [ ] Terms.
- [ ] Privacy Policy.
- [ ] Acceptable Use Policy.
- [ ] prohibited-items policy.
- [ ] abuse process.
- [ ] incident response.
- [ ] security review.
- [ ] load/capacity tests.
- [ ] billing reconciliation.
- [ ] production deployment.

---

# 28. Decisions Locked for v1

| Topic | Decision |
|---|---|
| Hosted runtime | Rootless Podman |
| Image format | OCI/runtime-agnostic |
| Store stack | Go + SQLite + lightweight web UI |
| Control plane style | Modular monolith |
| Initial hosting | One cheap server |
| Reverse proxy | Caddy |
| Central database | PostgreSQL |
| Search | PostgreSQL FTS + pg_trgm |
| Kubernetes | No |
| Redis/message queue | No initially |
| Free model | Renewable 14-day free store |
| Free concurrent stores | 1/account by default |
| Free central search | No |
| Paid extension | $5 / 30 days default |
| Paid stores | Per-store billing |
| Grace period | 14 days default |
| Rules | Admin-configurable |
| Campaigns/coupons | Supported |
| Manual comp | Supported and audited |
| Marketplace | Local-first, global schema |
| Promotions | Fixed-price first |
| Buyer/seller payment | External |
| Cloud source | Proprietary initially |
| Store source | FOSS |
