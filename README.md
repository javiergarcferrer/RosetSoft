# Alcover Soft

Cloud quoting app for Ligne Roset dealers. Vite + React + Supabase.

## Setup

```bash
cp .env.example .env.local   # fill in VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
npm install
npm run dev
```

Apply `supabase/migrations/*.sql` to your Supabase project (link the repo or
paste them into the SQL editor in order).

## Build

```bash
npm run build      # static SPA in dist/
```

Deploy `dist/` to any static host. On Vercel, set `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY` in project settings.
