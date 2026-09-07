# YardSale — Self-Hostable Container Plan

**Project:** YardSale Store  
**Edition:** FOSS / self-hosted  
**Deployment format:** OCI container image  
**Primary hosted runtime:** Rootless Podman  
**Supported self-host runtimes:** Podman and Docker  
**Shared with SaaS:** Yes — the managed service runs this same application image

---

# 1. Product Goal

YardSale Store is a lightweight temporary storefront for selling second-hand goods.

The store application must work completely independently of the commercial YardSale SaaS. A self-hosted user should be able to run a store indefinitely without:

- a YardSale cloud account
- a payment gateway
- a buyer account system
- an external database
- Redis
- a message queue
- marketplace integration
- third-party authentication

The application should be easy to deploy, cheap to run, easy to back up, and portable.

Core principle:

> One store is one self-contained application instance with one persistent data directory.

---

# 2. Product Scope

## Seller capabilities

Seller can:

- create/configure a store
- upload logo/banner
- set structured location
- set default currency
- set timezone
- configure contact methods
- configure comments
- configure reservation/hold timers
- create listings
- upload multiple images per listing
- edit/delete/hide listings
- reorder listings/images
- mark listings sold
- review incoming holds
- approve/reject holds
- extend approved reservations
- cancel reservations
- moderate comments
- export all store data
- restore/import a YardSale export
- optionally expose public listing metadata through the YardSale federation API

## Buyer capabilities

Buyer can:

- browse without an account
- search listings
- filter listings
- see availability state
- view seller contact methods
- comment when enabled
- request a hold/reservation
- see hold/reservation expiry
- cancel their own hold/reservation using a secret management URL
- contact the seller externally

## Explicit non-goals for v1

- buyer accounts
- integrated buyer/seller payments
- Stripe/PayPal checkout
- escrow
- shipping labels
- courier integration
- seller payouts
- refunds
- chargebacks
- in-app private messaging
- dispute resolution
- seller reputation
- permanent retail/e-commerce features
- multi-vendor stores

---

# 3. Architecture

## 3.1 Runtime philosophy

The image must be OCI-compatible and not depend on a specific runtime.

Official documentation should include:

- `podman run`
- Podman Quadlet example
- `docker run`
- `docker compose`

The normal installation must not require environment-variable editing. On the
first launch, the application opens a short setup flow that creates the seller
account and store. After that, store settings are changed in the seller UI.

The commercial hosted service will use rootless Podman.

The project must not depend on Docker-specific APIs or behavior.

## 3.2 Preferred application stack

Preferred v1 stack:

- Go
- SQLite
- server-rendered HTML
- HTMX and/or minimal JavaScript
- small CSS framework or custom CSS
- local filesystem image storage
- embedded static assets
- OCI image

Rationale:

- very low idle RAM
- fast startup
- simple deployment
- single binary possible
- minimal dependency tree
- high container density on inexpensive servers
- simple self-hosting

A React/Svelte frontend is acceptable only if it compiles to static assets and does not require a second long-running Node process.

## 3.3 Resource target

Low idle resource consumption is a formal requirement.

Initial engineering targets:

```text
Idle RAM:           target < 40 MB, hard review if > 75 MB
Idle CPU:           effectively zero
Startup time:       target < 2 seconds on modest VPS hardware
Persistent state:   one mounted /data directory
External services:  none required
```

These are targets, not promises. Benchmark them before v1 release.

## 3.4 Persistence

Single mounted directory:

```text
/data/
  yardsale.db
  uploads/
  generated/
  backups/
```

The application must survive container replacement without data loss as long as `/data` remains intact.

---

# 4. Deployment Examples

## Podman

```bash
podman run -d \
  --name yardsale \
  -p 3000:3000 \
  -v yardsale-data:/data:Z \
  ghcr.io/<org>/yardsale:latest
```

## Docker

```bash
docker run -d \
  --name yardsale \
  -p 3000:3000 \
  -v yardsale-data:/data \
  ghcr.io/<org>/yardsale:latest
```

## Docker Compose

```yaml
services:
  yardsale:
    image: ghcr.io/<org>/yardsale:latest
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - yardsale-data:/data

volumes:
  yardsale-data:
```

---

# 5. Core Data Model

## Store

Fields:

- id
- slug
- name
- description
- logo_path
- banner_path
- default_currency
- timezone
- comments_enabled
- default_hold_minutes
- default_reservation_minutes
- sold_listing_behavior
- federation_enabled
- contact_methods
- created_at
- updated_at

## StructuredLocation

Location is core functionality because YardSale discovery is intended to be local.

Fields:

- country_code
- country_name
- region
- city
- area
- display_location
- latitude nullable
- longitude nullable

Exact seller home addresses should not be required.

Example:

```text
country_code: KH
region: Phnom Penh
city: Phnom Penh
area: Toul Tom Poung
display_location: TTP / Russian Market
```

## AdminUser

v1 supports one local seller/admin.

Fields:

- id
- email_or_username
- password_hash
- created_at
- last_login_at

## Listing

Fields:

- id
- public_id
- title
- slug
- description
- price_minor
- currency nullable
- category
- condition
- status
- quantity
- pickup_notes
- tags
- sort_order
- published
- comments_enabled_override
- created_at
- updated_at
- sold_at

Currency defaults to Store.default_currency but may be overridden per listing.

Suggested statuses:

```text
available
held
reserved
sold
hidden
```

## ListingImage

Fields:

- id
- listing_id
- path
- thumbnail_path
- alt_text
- sort_order
- width
- height
- created_at

## Reservation

Fields:

- id
- listing_id
- buyer_name
- buyer_contact
- buyer_message
- status
- manage_token_hash
- requested_at
- hold_expires_at
- approved_at
- reservation_expires_at
- completed_at
- rejected_at
- cancelled_at
- source_ip_hash
- created_at
- updated_at

Suggested statuses:

```text
held
reserved
expired
rejected
cancelled
completed
```

## Comment

Fields:

- id
- listing_id
- author_name
- body
- status
- created_at
- deleted_at

## ContactMethod

Structured JSON is acceptable.

Supported types initially:

- phone
- email
- Telegram
- WhatsApp
- Messenger
- Signal
- custom URL
- custom text

---

# 6. Two-Stage Reservation Model

This is a core product workflow.

## State machine

```text
AVAILABLE
    |
    | buyer requests item
    v
HELD
    |
    +---- seller approves ----> RESERVED
    |                              |
    |                              +---- seller confirms ----> SOLD
    |
    +---- seller rejects ------> AVAILABLE
    |
    +---- hold expires --------> AVAILABLE
```

A Reserved item can also return to Available if:

- seller cancels
- buyer cancels
- approved reservation expires

## Hold stage

When a buyer clicks **Reserve**:

1. buyer submits name
2. buyer submits one contact method
3. buyer may submit a note
4. server atomically verifies item is Available
5. item changes to Held
6. hold timer starts
7. seller is shown the incoming request
8. buyer receives secret reservation-management URL

Default hold:

```text
60 minutes
```

Seller can configure the default.

## Approval stage

Seller can:

- approve
- reject
- manually choose reservation expiry

If approved:

```text
HELD -> RESERVED
```

Default approved reservation duration:

```text
24 hours
```

Seller may choose a specific date/time instead.

## Concurrency requirement

A single-quantity item may never have two simultaneous active Holds/Reservations.

Implement this transactionally in SQLite.

Concurrency tests are mandatory.

## Expiry behavior

Do not depend only on cron/systemd timers.

On listing/reservation reads and mutations:

- detect expired state
- expire transactionally
- restore listing to Available when appropriate

A background cleanup loop can reconcile stale rows periodically.

---

# 7. Buyer Identity and Privacy

Buyer accounts are not required.

Use a high-entropy secret management URL:

```text
https://store.example.com/r/<public-id>/<secret-token>
```

Store only a hash of the secret token.

Buyer contact data:

- never appears in public APIs
- never appears in federation feed
- is visible only to seller/admin
- is purgeable
- should have configurable retention

Suggested default retention:

```text
30 days after completion/cancellation/expiry
```

---

# 8. Public Store UI

## Home page

Display:

- store name
- description
- location
- contact methods
- listing search
- category filter
- condition filter
- status filter
- price filter
- listing grid

Listing card shows:

- thumbnail
- title
- price
- condition
- location if overridden later
- state badge:
  - Available
  - Held
  - Reserved
  - Sold

## Listing page

Display:

- image gallery
- title
- description
- price
- condition
- pickup notes
- store location
- availability state
- hold/reservation expiry countdown
- Reserve button when Available
- seller contact methods
- comments
- share/copy link controls

## Sold behavior

Store setting:

- hide sold
- dim sold
- show sold at bottom

Default:

```text
Show sold at bottom with prominent SOLD state.
```

---

# 9. Seller Admin UI

Suggested routes:

```text
/admin
/admin/listings
/admin/listings/new
/admin/listings/:id
/admin/reservations
/admin/comments
/admin/store
/admin/settings
/admin/export
```

Dashboard should show:

- Available count
- Held count
- Reserved count
- Sold count
- Holds expiring soon
- Reservations expiring soon
- recent comments

## Listing creation UX

This workflow must be fast.

Minimum flow:

```text
Add item
-> drop photos
-> title
-> price
-> optional description
-> save
-> add next
```

Do not require category, tags, or long descriptions to create a listing.

Bulk/AI-assisted creation is post-v1.

---

# 10. Image Pipeline

Requirements:

- multiple images per listing
- JPEG/PNG/WebP
- HEIC only if reliable
- automatic orientation
- EXIF stripping
- thumbnail generation
- optimized display image
- upload size limits
- image dimension limits
- randomized filenames
- magic-byte validation
- orphan cleanup

Reject SVG in v1.

Defend against:

- malformed images
- decompression bombs
- path traversal
- MIME spoofing

---

# 11. Store Search

Use SQLite FTS5.

Index:

- title
- description
- category
- tags

Filters:

- status
- category
- condition
- price
- newest
- price ascending/descending

---

# 12. Federation / SaaS Integration

Self-hosting must remain independent.

The central platform never receives direct database access.

Expose a narrow versioned protocol.

Suggested endpoints:

```text
GET /.well-known/yardsale-store.json
GET /api/federation/v1/listings
```

Public listing feed may include:

- public listing ID
- store public ID
- title
- description excerpt
- price
- currency
- category
- tags
- status
- structured public location
- canonical URL
- thumbnail URL
- created_at
- updated_at

Never expose:

- buyer information
- reservation tokens
- admin information
- private moderation metadata

Managed instances may support signed control-plane requests.

---

# 13. API Structure

Suggested namespaces:

```text
/api/v1/public/*
/api/v1/admin/*
/api/federation/v1/*
```

Representative public routes:

```text
GET  /api/v1/public/store
GET  /api/v1/public/listings
GET  /api/v1/public/listings/:id
POST /api/v1/public/listings/:id/hold
POST /api/v1/public/listings/:id/comments
POST /api/v1/public/reservations/:id/cancel
```

Representative admin routes:

```text
POST   /api/v1/admin/session
DELETE /api/v1/admin/session

GET    /api/v1/admin/listings
POST   /api/v1/admin/listings
PATCH  /api/v1/admin/listings/:id
DELETE /api/v1/admin/listings/:id

GET    /api/v1/admin/reservations
POST   /api/v1/admin/reservations/:id/approve
POST   /api/v1/admin/reservations/:id/reject
POST   /api/v1/admin/reservations/:id/extend
POST   /api/v1/admin/reservations/:id/sold
```

---

# 14. Authentication and Security

## Seller authentication

- one local admin
- Argon2id password hashing
- secure HTTP-only cookies
- SameSite cookies
- CSRF protection
- login rate limiting
- optional password reset if SMTP configured

## Security controls

Required:

- output escaping
- parameterized SQL
- CSP
- security headers
- CSRF protection
- IDOR tests
- upload validation
- rate limiting
- comment anti-spam
- reservation abuse controls
- secret redaction
- structured audit/security logs
- non-root runtime
- minimal container privileges
- read-only root filesystem where practical
- dependency scanning
- SAST
- secret scanning
- reproducible/traceable image builds

The store must remain secure even when an attacker knows its source code and architecture.

---

# 15. Comments

v1:

- optional globally
- optional per listing
- display name required
- no account required
- plain text only
- HTML rejected/escaped
- URLs may initially be non-clickable
- seller can delete/moderate

Anti-spam:

- per-IP rate limits
- per-listing rate limits
- honeypot
- maximum length
- optional CAPTCHA adapter

---

# 16. Export and Portability

Seller can download:

```text
yardsale-export-YYYY-MM-DD.zip
```

Containing:

```text
manifest.json
store.json
listings.json
reservations.json
comments.json
uploads/
```

A SQLite snapshot may optionally be included, but JSON is the portability format.

Self-hosted users must be able to:

- export
- import
- migrate between Podman and Docker
- move `/data` to another server

---

# 17. Configuration

The normal installation has no required configuration. The container listens
on port 3000, stores its database and uploads under `/data`, and asks for the
seller account, store name, currency, timezone, and other settings on first
launch. Store settings remain editable from the seller UI.

Deployment-specific overrides may be documented separately for operators, but
they must never be needed for a first-time user to get a working store.

Commercial pricing, trial rules, promotions, and hosted entitlements do **not** belong in this container.

---

# 18. OCI Deliverable

Required:

- `Containerfile` or portable `Dockerfile`
- Podman run documentation
- Podman Quadlet example
- Docker run documentation
- `docker-compose.yml`
- healthcheck
- non-root image
- amd64 build
- arm64 build where practical
- GHCR publishing
- semantic versioning
- immutable release tags

The image must run unchanged under Podman and Docker.

---

# 19. Delivery Plan

## Milestone 0 — Architecture and Benchmark Harness

Deliverables:

- repository
- FOSS license decision
- Go application skeleton
- SQLite schema/migrations
- OCI build
- benchmark harness
- security baseline

TODO:

- [ ] Create repository.
- [ ] Choose license.
- [ ] Add README.
- [ ] Add CONTRIBUTING.
- [ ] Add SECURITY.md.
- [ ] Add CI.
- [ ] Add Go lint/test pipeline.
- [ ] Add SQLite migrations.
- [ ] Add OCI image build.
- [ ] Verify Podman.
- [ ] Verify Docker.
- [ ] Record idle RAM.
- [ ] Record startup time.
- [ ] Record image size.
- [ ] Define performance gates.

## Milestone 1 — Setup and Authentication

- [ ] First-run wizard.
- [ ] Local admin creation.
- [ ] Argon2id.
- [ ] Session handling.
- [ ] CSRF.
- [ ] Login rate limiting.
- [ ] Store settings.
- [ ] Structured location.
- [ ] currency/timezone.
- [ ] contact methods.
- [ ] hold/reservation defaults.

## Milestone 2 — Listings

- [ ] Listing CRUD.
- [x] Listing status.
- [ ] price/currency.
- [ ] condition/category.
- [ ] tags.
- [ ] listing order.
- [ ] public store page.
- [ ] public listing page.
- [ ] responsive UI.

## Milestone 3 — Images

- [ ] Multi-upload.
- [ ] validation.
- [ ] EXIF stripping.
- [ ] resizing.
- [ ] thumbnails.
- [ ] randomized names.
- [ ] delete/reorder.
- [ ] malformed-image tests.
- [ ] orphan cleanup.

## Milestone 4 — Hold / Reservation Workflow

- [x] Reservation schema.
- [x] atomic Available -> Held transaction.
- [x] default hold timer.
- [x] seller approve.
- [x] seller reject.
- [x] Held -> Reserved.
- [x] configurable reservation timer.
- [x] manual reservation-until timestamp.
- [x] buyer secret management token.
- [x] buyer cancel.
- [x] seller cancel.
- [x] seller mark Sold.
- [x] automatic expiry.
- [x] concurrency test suite.
- [x] abuse limits.

## Milestone 5 — Comments

- [x] Comment schema.
- [x] plain-text submission.
- [x] escaping.
- [x] moderation.
- [x] rate limits.
- [x] honeypot.
- [ ] optional CAPTCHA.

## Milestone 6 — Search

- [x] SQLite FTS5.
- [x] title/description index.
- [x] tags/category.
- [x] filters.
- [x] sorting.

## Milestone 7 — Export / Import

- [ ] versioned export schema.
- [ ] JSON export.
- [ ] media export.
- [ ] import validation.
- [ ] restore tests.
- [ ] migration tests.

## Milestone 8 — Federation

- [ ] protocol v1.
- [ ] well-known manifest.
- [ ] public listing feed.
- [ ] structured location payload.
- [ ] ETag/Last-Modified.
- [ ] optional indexing flag.
- [ ] managed request signatures.
- [ ] privacy tests.

## Milestone 9 — Security Hardening

- [ ] XSS tests.
- [ ] CSRF tests.
- [ ] IDOR tests.
- [ ] upload attack tests.
- [ ] reservation race tests.
- [ ] rate-limit tests.
- [ ] dependency scanning.
- [ ] SAST.
- [ ] secret scanning.
- [ ] non-root verification.
- [ ] read-only filesystem test where practical.

## Milestone 10 — v1 Release

- [ ] Publish `v1.0.0`.
- [ ] Publish amd64 image.
- [ ] Publish arm64 image where practical.
- [ ] Podman installation guide.
- [ ] Docker installation guide.
- [ ] Quadlet guide.
- [ ] reverse-proxy examples.
- [ ] upgrade guide.
- [ ] backup/restore guide.
- [ ] resource benchmark report.
- [ ] demo store.

---

# 20. v1 Acceptance Criteria

- [ ] Store works with Podman.
- [ ] Store works with Docker.
- [ ] No external database required.
- [ ] No SaaS dependency required.
- [ ] Persistent data survives container replacement.
- [ ] Seller can create listings with photos.
- [ ] Structured location works.
- [ ] Buyer can request a Hold without an account.
- [ ] Hold immediately locks the item.
- [x] Seller can approve into Reserved.
- [ ] Hold/reservation expiry returns item to Available.
- [ ] Concurrent requests cannot double-book an item.
- [ ] Buyer contact remains private.
- [ ] Seller can mark Sold.
- [ ] Comments can be moderated.
- [ ] Export/import works.
- [ ] Federation feed exposes only public fields.
- [ ] Security test suite passes.
- [ ] Idle resource usage is measured and documented.

---

# 21. Post-v1 Candidates

- waitlist
- bulk photo-to-draft creation
- AI titles/descriptions
- QR codes
- PWA
- web push
- Telegram notifications
- email notifications
- seller analytics
- store themes
- translations
- geospatial radius search
- S3-compatible media adapter
- multi-admin stores
- custom webhooks
