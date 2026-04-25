# 3D Printing Smart POS Dashboard

Vercel-ready Next.js starter.

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:3000

## Deploy to Vercel

1. Upload this folder to GitHub.
2. Import the GitHub repository into Vercel.
3. Deploy with default Next.js settings.

## Notes

- Current version stores jobs, inventory, and pricing formula in browser state/localStorage.
- Supabase integration can be added next for persistent jobs, filaments, printers, and payments.
- Formula settings are admin-facing. For production, move formula evaluation to a backend API and protect it with auth.
