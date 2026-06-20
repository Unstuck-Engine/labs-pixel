# Unstuck Labs Pixel Proxy

Hosts `pixel.unstuckengine.com` — the customer-facing tracking-script endpoint for the Unstuck Labs S2 web de-anon pipeline.

**Spec:** [product:docs/specs/7.6-website-intent-signal-deanon.md](https://github.com/Unstuck-Engine/product/blob/main/docs/specs/7.6-website-intent-signal-deanon.md)

## Architecture

This is a tiny Vercel-hosted edge proxy. Two things live here:

1. **Static tracking script** at `/v1/p.js` — served from `public/v1/p.js`. Currently a v0 stub; full implementation lands in companion spec 7.6.1.
2. **Domain-rewrite proxy** at `/v1/config`, `/v1/events`, `/v1/identify` — `vercel.json` rewrites these paths to the corresponding Supabase Edge Functions on the Labs project (`dbylvdycfnmsdxlmghhz`). Customer browsers never see a `*.supabase.co` URL.

This setup costs $0 (Vercel free tier) instead of $10/month for Supabase's custom-domain feature.

## Install snippet

```html
<script async src="https://pixel.unstuckengine.com/v1/p.js" data-key="<PIXEL_KEY>"></script>
```

Customer's `<PIXEL_KEY>` comes from the `pixel_configs.pixel_key` row managed in `/app` Settings → Pixel install panel (companion spec 7.6.1).

## JS API surface (mirrors Snitcher's tracker — spec 7.6 §C.3)

```js
Unstuck.identify(email, traits);   // self-identification
Unstuck.track(eventName, properties);  // custom event
Unstuck.page(properties);           // explicit page-view
Unstuck.giveCookieConsent();        // flush deferred queue
```

URL parameters (auto-captured on page load):

- `?u_email=<plaintext>` — recipient's email
- `?u_eid=<base64>` — base64-encoded recipient email
- `?u_trait_<key>=<value>` — additional traits
- `?u_uid=<our_uid>` — cross-domain handoff from other Unstuck tools

## Deploy

Pushed to `main` → Vercel auto-deploys.
