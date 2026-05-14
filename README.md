# Roset Soft

Quoting software for Ligne Roset dealers — built as the foundation of a CRM as the product evolves. Import the official USA price-list PDF, browse the catalog, manage fabric and leather swatches, build branded PDF quotes for clients. Data lives in the cloud and is shared across the whole team in real time.

## Features

- **PDF importer** — parse a Ligne Roset USA price list (fabrics, leathers, products, variants, A–Z pricing tables) directly in the browser.
- **Shared catalog** — products with hero images, variants, dimensions, yardage, reference codes, and grade-by-grade pricing — visible to every signed-in team member.
- **Materials** — fabrics, leathers, outdoor fabrics with swatch images, AFNOR/Martindale specs, and per-color codes.
- **Quote builder** — pick product → pick fabric → pick color → set qty. The right price is selected from the grade automatically. Per-line and per-quote margin and discount.
- **Branded PDF quotes** — your logo, company info, product images, swatch images, totals, and terms.
- **Customer database** — save clients, attach quotes, reuse contact info. (Foundation for the CRM features coming next.)
- **Multiple currencies** — quote in any currency, with configurable exchange rates (BPD buy/sell, market, custom).

## Stack

- **Vite + React + Tailwind** for the SPA.
- **Supabase** (Postgres + Auth + Storage) for the cloud backend.
- **pdf.js** parses source price-list PDFs; **pdf-lib** generates branded quote PDFs.

## Setting up Supabase

You need a Supabase project to run Roset Soft. The repo ships SQL migrations under `supabase/migrations/` so once the project is linked to GitHub, schema changes deploy on push.

1. **Create the project** at https://supabase.com → New project. Free tier is fine. Pick a region close to your team.
2. **Link the project to this GitHub repo** (Project Settings → Integrations → GitHub, or Database → Branching). Point it at the branch you want to deploy from (e.g. `main`). Supabase will run any files in `supabase/migrations/` that haven't been applied yet.
3. **Auth settings** (Authentication → Providers → Email):
   - Enable Email provider.
   - For now, **disable "Confirm email"** so teammates can sign up without configuring SMTP. Re-enable it later when you wire SMTP.
4. **Add team members** (Authentication → Users → Add user):
   - Enter email + password for each teammate. They'll be able to sign in immediately.
   - Alternatively, leave signup open and have teammates create their own accounts from the Login screen.

> If you haven't linked the repo yet, you can also run the SQL by hand: open SQL Editor → paste each file from `supabase/migrations/` in order (the filename prefix gives the order) → Run.

Your data lives in your Supabase project. Schema:

- `profiles` / `settings` — one shared `team` row holds the company-wide configuration (logo, address, terms, exchange rates). One row per signed-in user for audit/display.
- `categories` / `products` / `product_variants` — the catalog.
- `materials` / `material_colors` — fabrics, leathers, outdoor fabrics with swatch images.
- `customers` / `quotes` / `quote_lines` — the CRM + quote pipeline.
- `images` — metadata; binary content lives in the `images` Storage bucket.

Row-level security: every authenticated user can read and write everything (single-tenant team).

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

The build output is a static SPA — `dist/index.html` plus assets — so any static host works.

### Vercel (one-click)

1. Push this repo to GitHub.
2. Import it on https://vercel.com.
3. Add the two env vars on the project settings: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`.
4. Deploy. A `vercel.json` is included so client-side routes fall through to `index.html`.

### Cloudflare Pages / Netlify

Same idea — build command `npm run build`, output `dist`, set the two env vars. Add a redirect from `/*` → `/index.html` if your host doesn't do it automatically.

## How the importer works

The official Ligne Roset USA price list has a consistent structure across releases:

1. **Cover Materials section** — fabrics, leathers, outdoor fabrics. Each material has a name, grade letter (A–Z), wear rating, width, USD price per yard, composition, and a list of colors with codes.
2. **Product sections** — Seats, Beds, Dining Chairs, etc. Each model has a designer, year, description, a list of "technical impossibilities" (fabrics that cannot be used), and a table of variants. Each variant has dimensions, yardage, a reference code, and prices for each grade letter.

The importer parses positioned text from each page, classifies pages by their headers, and extracts these structures into the catalog. After parsing, you see a preview screen — review it, then commit.

Imports are idempotent: products and variants are upserted by reference code; new colors are added under existing materials.

## Adding images

Two ways:

1. **Drag/drop** a file (or paste from clipboard) onto any image slot.
2. **From URL** — paste the URL of a swatch from `ligne-roset.com`. This only works when the source site permits cross-origin downloads. If it fails, open the swatch in a new tab, save it locally, and drop the file.

Each color, each variant, and each product can hold one image. Images upload to the Supabase `images` Storage bucket and are served via public URLs.

## Project layout

```
src/
  components/         Layout, Modal, ImageDrop, ImageView, ProfileMenu, etc.
  context/            AppContext (team settings), AuthContext (Supabase auth), CartContext (running quote)
  db/                 Cloud data layer — Supabase client, Dexie-shape shim, useLiveQuery hook, repositories
  lib/                Pricing math, formatting helpers, exchange-rate fetcher
  pages/              Routed pages (Login, Catalog, Quotes, Materials, etc.)
  parser/             PDF importer (pdf.js + Ligne Roset structure)
  pdf/                Branded PDF quote generator (pdf-lib)
  App.jsx             Routes + auth gating
  main.jsx            Entry point
supabase/
  migrations/         Timestamped SQL migrations — Supabase runs these in order
    20260514120000_init_schema.sql   Tables, indexes, RLS policies
    20260514120001_init_storage.sql  Images bucket + bucket-level access policies
```

## Roadmap → CRM

The data model already has `customers`, `profiles`, and `quotes` in place. Next steps:

- Activity log per customer (calls, meetings, follow-ups).
- Pipeline stages (Lead → Proposal → Won/Lost) on top of the existing `quote.status`.
- Per-user inbox of assigned customers and pending quotes.
- Email integration to send quote PDFs from the app and log responses on the customer.
