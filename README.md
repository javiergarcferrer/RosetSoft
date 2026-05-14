# Roset Soft

Quoting software for Ligne Roset dealers. Import the official USA price-list PDF, browse the catalog, manage fabric and leather swatches, build branded PDF quotes for clients.

## Features

- **PDF importer** — parse a Ligne Roset USA price list (fabrics, leathers, products, variants, A–Z pricing tables) directly in the browser.
- **Catalog** — products with hero images, variants, dimensions, yardage, reference codes, and grade-by-grade pricing.
- **Materials** — fabrics, leathers, outdoor fabrics with swatch images, AFNOR/Martindale specs, and per-color codes.
- **Quote builder** — pick product → pick fabric → pick color → set qty. The right price is selected from the grade automatically. Per-line and per-quote margin and discount.
- **Branded PDF quotes** — your logo, company info, product images, swatch images, totals, and terms.
- **Customer database** — save clients, attach quotes, reuse contact info.
- **Multiple currencies** — quote in any currency, with configurable exchange rates.
- **Multiple profiles** — switch between team-member profiles in the bottom-left of the sidebar.

## Run locally

Requires Node.js 18+.

```bash
npm install
npm run dev
```

Then open the URL Vite prints (usually `http://localhost:5173`).

To build for production:

```bash
npm run build
npm run preview
```

The build produces a static `dist/` folder — open `dist/index.html` directly, host it on any static server, or zip it for handoff.

## Where your data lives

Everything is stored in your browser's IndexedDB. Catalog, materials, customers, quotes, and images all stay on your machine — nothing leaves until you click *Export PDF*.

This means:
- ✅ You can use it offline
- ✅ Nothing to set up, no accounts
- ⚠️ Data is per-browser-per-machine — clearing browser data wipes it
- ⚠️ Different machines = different data (until we add cloud sync)

If you change machines, do the PDF import again on the new one. The catalog import is idempotent — re-importing the same PDF won't create duplicates.

## How the importer works

The official Ligne Roset USA price list has a consistent structure across releases:

1. **Cover Materials section** — fabrics, leathers, outdoor fabrics. Each material has a name, grade letter (A–Z), wear rating, width, USD price per yard, composition, and a list of colors with codes.
2. **Product sections** — Seats, Beds, Dining Chairs, etc. Each model has a designer, year, description, a list of "technical impossibilities" (fabrics that cannot be used), and a table of variants. Each variant has dimensions, yardage, a reference code, and prices for each grade letter.

The importer parses positioned text from each page, classifies pages by their headers, and extracts these structures into the catalog. After parsing, you see a preview screen — review it, then commit.

When a future price-list PDF arrives, just re-import. New products are added; existing products and variants are updated by reference code; new colors are added under existing materials.

## Adding images

Two ways:

1. **Drag/drop** a file from your computer (or paste from clipboard) onto any image slot.
2. **From URL** — paste the URL of a swatch from `ligne-roset.com`. This only works when the source site permits cross-origin downloads. If it fails, open the swatch in a new tab, save it locally, and drop the file.

Each color, each variant, and each product can hold one image. Images are stored as blobs in IndexedDB.

## Roadmap → cloud

This first version runs locally. The data layer is in `src/db/` and is intentionally narrow (a Dexie wrapper plus repository functions), so a future cloud version swaps these out for a Supabase client without touching the React components.

When you're ready:
1. Spin up a Supabase project (free tier — Postgres + Auth + Storage).
2. Replace `src/db/database.js` and `src/db/repositories.js` with a Supabase-backed implementation that exposes the same API.
3. Add a login page + route guard.
4. Deploy the same `dist/` build to Vercel or Cloudflare Pages.
5. Add a one-time migrator that uploads local IndexedDB data to Supabase so you keep what you've already built.

## Project layout

```
src/
  components/         Layout, Modal, ImageDrop, ImageView, etc.
  context/            App-wide state (active profile, settings)
  db/                 Data layer — Dexie schema + repositories
  lib/                Pricing math, formatting helpers
  pages/              Routed pages (Catalog, Quotes, Materials, etc.)
  parser/             PDF importer (pdf.js + Ligne Roset structure)
  pdf/                Branded PDF quote generator (pdf-lib)
  App.jsx             Routes
  main.jsx            Entry point
```

## Tech

- **Vite + React** — fast dev, simple build, static output.
- **Tailwind CSS** — utility styles.
- **Dexie** — IndexedDB wrapper with live queries.
- **pdf.js** — parses the source price-list PDFs.
- **pdf-lib** — generates the branded client PDFs.
- **react-router-dom (HashRouter)** — works from any static host without server config.
