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

## Orchestrate, don't hand off

The user doing manual work is a failed session, not a hand-off. Never write "run this command", "redeploy this", "merge this PR" and stop.

- A permission wall, a missing credential, a repo you aren't currently in (this proxy's edge functions live in `labs`), a merge you can't perform, a guard hook that blocks a tool — **none of these is a reason to give Ivan a task.** Each is a reason to dispatch a background subsession in the repo that can do it and have it report back. You are the orchestrator.
- **Try it before you describe it.** If the step fails, dispatch a subsession in the right repo. Only once a subsession has genuinely failed too does it reach Ivan — with the exact error, never an assumption about what would have happened.
- **Credentials already on the machine are usable by a subsession** — a `.env.local`, a token file a script sources. Never print or commit their contents. "I don't have the credential" is true only when it is genuinely absent, not when it merely lives in another repo.
- **A guard hook or a PR-only `main` is a constraint to work within, not a stop sign.** Dispatch a session that takes the approved path.
- **The real exceptions are narrow**: an action in a UI only Ivan is logged into that no tool reaches, a decision that's his to make, or something the safety rules prohibit outright (entering credentials into a form, moving money, permanently deleting data). Everything else is yours.
- **Dispatching is required; queuing is banned.** These pull in opposite directions, so read them together. A background subagent that finishes the work and reports a verified result back to you is orchestration — do it. A task chip or "suggested task" parked for Ivan to pick up later is not delegation; it's the same hand-off wearing a different hat, and at scale it's an unbounded queue of sessions nobody asked for and nobody closes. **Never spawn one.** Out-of-scope findings — a rewrite pointing at a renamed EF, say — get one line in your report: never a chip, never a spawned session, never a "someone should".
- **The test is where the thing terminates.** Ends with a human deciding whether to run it → hand-off, banned. Ends with a subagent reporting a finished, verified result back to you → orchestration, required.

## Working System v2 (2026-08-04)

- main is PR-only, server-enforced by a GitHub ruleset. Branch, PR, self-merge after checks.
- feat/fix PR titles must carry a feature scope from product `docs/features/registry.md` (this repo's work is usually `signal-website-intent`); CI gates this.
- When the user corrects a session mistake: explain why, propose the preventing instruction change, apply on approval.
- Full contract: product `docs/working-system.md`.
