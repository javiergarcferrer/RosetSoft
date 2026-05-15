# Roset Soft

Quoting software for Ligne Roset dealers — a shared, cloud-backed catalog,
a fabric/leather/swatch library, and a branded-PDF quote builder. Built as
the foundation of a CRM as the product evolves.

## Features

- **Shared catalog** — products with hero + technical-drawing images,
  variants, dimensions, yardage, reference codes, and grade-by-grade
  pricing. Visible to every signed-in team member.
- **Materials** — fabrics, leathers, and outdoor fabrics with swatch
  images, AFNOR/Martindale specs, and per-colour codes.
- **Quote builder** — pick product → pick fabric → pick colour → set qty.
  The right price is selected from the grade automatically. Per-line and
  per-quote margin and discount.
- **Branded PDF quotes** — your logo (PNG, JPEG, **or SVG** — rasterized
  at print resolution), company info, product images, swatch images,
  totals, DOP/USD conversion, and terms.
- **Customer database** — save clients, attach quotes, reuse contact
  info. Foundation for the CRM features coming next.
- **Containers** — group quotes for dispatch, with an auto-threshold for
  when a container is ready to ship.
- **Multiple currencies** — quote in any currency. The DOP rate can be
  pulled from BPD buy/sell, a market rate, or set manually.

## Stack

- **Vite + React + Tailwind** for the SPA.
- **Supabase** (Postgres + Auth + Storage) for the cloud backend.
- **pdf-lib** generates branded quote PDFs.

## Setting up Supabase

You need a Supabase project to run Roset Soft. The repo ships SQL
migrations under `supabase/migrations/` so once the project is linked to
GitHub, schema changes deploy on push.

1. **Create the project** at https://supabase.com → New project. Free
   tier is fine. Pick a region close to your team.
2. **Link the project to this GitHub repo** (Project Settings →
   Integrations → GitHub, or Database → Branching). Point it at the
   branch you want to deploy from (e.g. `main`). Supabase will run any
   files in `supabase/migrations/` that haven't been applied yet.
3. **Auth settings** (Authentication → Providers → Email):
   - Enable Email provider.
   - For now, **disable "Confirm email"** so teammates can sign up
     without configuring SMTP. Re-enable it later when you wire SMTP.
4. **Add team members** (Authentication → Users → Add user). Enter
   email + password for each teammate, or leave signup open so they can
   create their own accounts.

> If you haven't linked the repo yet, you can also run the SQL by hand:
> open SQL Editor → paste each file from `supabase/migrations/` in order
> (the filename prefix gives the order) → Run.

Schema:

- `profiles` / `settings` — one shared `team` row holds the company-wide
  configuration (logo, address, terms, exchange rates). One row per
  signed-in user for audit / display.
- `categories` / `products` / `product_variants` — the catalog.
- `materials` / `material_colors` — fabrics, leathers, outdoor fabrics
  with swatch images.
- `customers` / `quotes` / `quote_lines` — the CRM + quote pipeline.
- `containers` — dispatch grouping for finalised quotes.
- `images` — metadata; binary content lives in the `images` Storage
  bucket.

Row-level security is single-tenant: every authenticated user can read
and write everything.

## Running locally

Requires Node.js 18+.

```bash
cp .env.example .env.local
# Fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY from Settings → API.

npm install
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`).

## Deploying

The build output is a static SPA — `dist/index.html` plus assets — so
any static host works.

### Vercel (one-click)

1. Push this repo to GitHub.
2. Import it on https://vercel.com.
3. Add the two env vars on the project settings: `VITE_SUPABASE_URL`,
   `VITE_SUPABASE_ANON_KEY`.
4. Deploy. A `vercel.json` is included so client-side routes fall
   through to `index.html`.

The Vercel ↔ Supabase integration provides `SUPABASE_URL` and
`SUPABASE_ANON_KEY`; `vite.config.js` forwards them into the `VITE_`
slots at build time, so manual mirroring isn't needed.

### Cloudflare Pages / Netlify

Same idea — build command `npm run build`, output `dist`, set the two
env vars. Add a redirect from `/*` → `/index.html` if your host doesn't
do it automatically.

## Adding catalog data

Products, variants, materials, and customers are added through the
in-app UI. There is currently no built-in price-list importer; a new
parser is in development. Until then, populate the catalog by:

- **Catalog** → "Agregar producto" → fill in name + category, then add
  variants (reference, dimensions, prices by grade).
- **Materials** → "Add manually" → name, kind (fabric / leather /
  outdoor), grade, composition, then add colours.
- **Customers** → "Add customer" → contact + address.

## Adding images

Two ways:

1. **Drag/drop** a file (or paste from clipboard) onto any image slot.
2. **From URL** — paste the URL of a swatch from `ligne-roset.com`. Only
   works when the source site permits cross-origin downloads. If it
   fails, open the swatch in a new tab, save locally, and drop the
   file.

Each colour, each variant, and each product can hold one image. Images
upload to the Supabase `images` Storage bucket and are served via
public URLs.

**Logos**: PNG, JPEG, and SVG are all supported. SVGs are rasterized at
print resolution (1600 px wide) on the fly when the PDF is generated,
so vector logos stay crisp without you needing to convert them up
front.

## Project layout

```
src/
  components/   Layout, Modal, ImageDrop, ImageView, ProfileMenu, …
  context/      AppContext (team settings), AuthContext, CartContext
  db/           Cloud data layer (Supabase client, Dexie-shape shim,
                useLiveQuery hook)
  lib/          Pricing math, formatting, exchange-rate fetcher,
                CSV export, catalog / product dedup
  pages/        Routed pages (Login, Catalog, Quotes, Materials, …)
  pdf/          Branded PDF quote generator (pdf-lib)
  App.jsx       Routes + auth gating
  main.jsx      Entry point
supabase/
  migrations/   Timestamped SQL migrations — Supabase runs these in order
```

## Roadmap → CRM

The data model already has `customers`, `profiles`, and `quotes` in
place. Next steps:

- Activity log per customer (calls, meetings, follow-ups).
- Pipeline stages (Lead → Proposal → Won/Lost) on top of the existing
  `quote.status`.
- Per-user inbox of assigned customers and pending quotes.
- Email integration to send quote PDFs from the app and log responses on
  the customer.
- The new price-list parser, replacing the deleted in-browser importer.
