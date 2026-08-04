# labs-pixel

Vercel edge proxy serving `pixel.unstuckengine.com`: `public/v1/p.js` (browser tracking script) + `public/dashboard.html` + `vercel.json` rewrites to 4 Labs edge functions (source in Unstuck-Engine/labs `supabase/functions/`). Renaming/deleting those EFs in labs breaks this proxy silently — check `vercel.json` when touching them.

Deploy: push to `main` -> Vercel auto-deploys. No build step.

## Working System v2 (2026-08-04)

- main is PR-only, server-enforced by a GitHub ruleset. Branch, PR, self-merge after checks.
- feat/fix PR titles must carry a feature scope from product `docs/features/registry.md` (this repo's work is usually `signal-website-intent`); CI gates this.
- When the user corrects a session mistake: explain why, propose the preventing instruction change, apply on approval.
- Full contract: product `docs/working-system.md`.
