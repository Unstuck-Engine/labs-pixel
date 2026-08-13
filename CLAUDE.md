# labs-pixel

Vercel edge proxy serving `pixel.unstuckengine.com`: `public/v1/p.js` (browser tracking script) + `public/dashboard.html` + `vercel.json` rewrites to 4 Labs edge functions (source in Unstuck-Engine/labs `supabase/functions/`). Renaming/deleting those EFs in labs breaks this proxy silently — check `vercel.json` when touching them.

Deploy: push to `main` -> Vercel auto-deploys. No build step.

## Pre-production: judge every number at 1000x

We are pre-production. Today's volumes are a rounding error and are NOT a valid basis
for any decision. At launch, expect roughly **1000x** current volume.

Before citing any number — cost, executions, rows, requests, latency, spend — multiply
it by 1000 and cite that figure too. "$1.30/month today" is "$1,300/month at launch".
A quota sitting at 1% today is 10x over cap at launch.

Never argue that something isn't worth doing because the current absolute number is
small. Either state the 1000x figure, or leave the number out and argue the change on
correctness, accuracy, and stability instead.

## Working System v2 (2026-08-04)

- main is PR-only, server-enforced by a GitHub ruleset. Branch, PR, self-merge after checks.
- feat/fix PR titles must carry a feature scope from product `docs/features/registry.md` (this repo's work is usually `signal-website-intent`); CI gates this.
- When the user corrects a session mistake: explain why, propose the preventing instruction change, apply on approval.
- Full contract: product `docs/working-system.md`.
