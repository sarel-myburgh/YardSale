# YardSale

YardSale is a small, self-hosted storefront for selling second-hand goods.

## Run it

Docker is the simplest path:

```bash
docker compose up -d --build
```

Open [http://localhost:3000](http://localhost:3000). The first launch takes you
straight to a setup screen where you create the seller account and store. No
`.env` file or environment-variable setup is required.

Store data is kept in the Docker-managed `yardsale-data` volume, so it
survives container restarts without any host permissions setup. Operators who
prefer a host directory can replace the volume line in `docker-compose.yml`
with `./yardsale-data:/data`.

## Local development

Node.js 22.5 or newer is required because this first slice uses Node's built-in
SQLite support.

```bash
npm run dev
```

Local data is stored in `.yardsale/`.

## Current slice

- First-run seller account and store setup.
- Password login/logout with HTTP-only sessions and CSRF tokens.
- Store settings.
- Public seller contact methods and details.
- Listing create, edit, hide/unhide, mark reserved, mark sold, and delete.
- Multi-photo listing uploads with JPG, PNG, and WebP support, browser resizing, and bounded portrait/landscape galleries.
- Public store and listing pages.
- Buyer hold requests with expiry and private management links.
- Seller hold approval/rejection, optional reservation-until time, cancellation, extension, and completion.
- Basic reservation abuse protection (per-IP and per-listing request windows).
- Public comments with seller approval, hiding, deletion, plain-text escaping, and basic anti-spam protection.
- Health endpoint and persistent Docker volume.

Optional CAPTCHA, search indexing, import/export, federation, and image
reordering are planned next from `ContainerPlan.md`.
