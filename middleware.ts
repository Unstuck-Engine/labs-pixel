// Routing Middleware for pixel.unstuckengine.com (c67.2).
//
// The /v1/config and /v1/events rewrites in vercel.json proxy to Labs Edge
// Functions on another host, and Vercel's geo headers do not survive that
// external rewrite: Labs has never received x-vercel-ip-country (every
// clickstream row since launch has geo_region and geo_lat NULL). The visitor's
// IP country is what decides whether a visit is EU, so this copies it onto the
// request as x-unstuck-ip-country and lets the vercel.json rewrite carry on.
//
// A missing or malformed country is not forwarded, and a client-sent
// x-unstuck-ip-country is always dropped: Labs reads a missing country as not
// EU, never a value the browser chose.
//
// No dependency: these are the same x-middleware-* response headers
// @vercel/functions' next({ request: { headers } }) sets.

export const config = {
  matcher: ['/v1/config', '/v1/events'],
};

const FORWARDED = 'x-unstuck-ip-country';

export default function middleware(request: Request): Response {
  const headers = new Headers({ 'x-middleware-next': '1' });
  const keys: string[] = [];
  request.headers.forEach((value, key) => {
    if (key === FORWARDED) return;
    headers.set(`x-middleware-request-${key}`, value);
    keys.push(key);
  });
  const country = (request.headers.get('x-vercel-ip-country') ?? '').trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(country)) {
    headers.set(`x-middleware-request-${FORWARDED}`, country);
    keys.push(FORWARDED);
  }
  headers.set('x-middleware-override-headers', keys.join(','));
  return new Response(null, { headers });
}
