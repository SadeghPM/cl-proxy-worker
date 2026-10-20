# Cloudflare Worker Proxy

A proxy for browsing websites through a Cloudflare Worker.

There are two implementations in this repo:

- **`worker-v2.js`** — current, recommended implementation (streaming, cookie jar, JS shim, security guards).
- **`worker.js`** — the original simple version, kept for reference.

## Features (v2)

- **Streaming HTML rewriting** with Cloudflare's native `HTMLRewriter` (single pass, no whole-document buffering).
- **Correct URL rewriting**: absolute, root-relative, relative (`../`, `./`), protocol-relative (`//host/x`), `<base href>`, `srcset`/`imagesrcset`, inline `style`, `<style>` blocks, `url()`/`@import` in CSS, `<meta http-equiv="refresh">`.
- **SRI-safe**: strips `integrity`/`crossorigin` on rewritten tags so scripts/styles are not blocked.
- **Header hygiene**: strips hop-by-hop and origin-assuming headers (`content-length`, `content-encoding`, CSP, `X-Frame-Options`, HSTS, COOP/COEP/CORP, …); maps `Origin`/`Referer` back to the target.
- **Redirects**: fetched with `redirect: "manual"`, `Location` rewritten into the proxy.
- **Per-host cookie jar**: upstream `Set-Cookie` is stored on the worker origin, split into an `HttpOnly` store and a JS-visible store, matched by domain/path/`Secure`, and isolated per target site.
- **Runtime shim**: injected before page scripts; patches `fetch`, `XMLHttpRequest`, `history.pushState/replaceState`, `location.assign/replace`, `window.open`, `sendBeacon`, URL-reflecting element properties, `Element.prototype.setAttribute`, and `document.cookie`.
- **Un-prefixed URL fallback**: if the page (or its JS) navigates to a URL without the proxy prefix, the worker reconstructs the target from the `Referer` or a `__p_last` cookie and redirects into the proxy.
- **Safety**: blocks localhost/private/link-local/cloud-metadata targets by default, optional allow/deny host lists, and a configurable upstream fetch timeout.
- Minimal landing page and readable error pages.

## Usage

```
https://your-worker-domain/https://example.com
```

The target must be an absolute `http(s)` URL. Query strings work as expected:

```
https://your-worker-domain/https://example.com/search?q=hello
```

## Configuration

Set these as Worker variables (e.g. under `[vars]` in `wrangler.toml`):

| Variable | Default | Description |
|---|---|---|
| `ALLOWED_HOSTS` | _(empty = allow all)_ | Comma-separated hosts; subdomains match automatically. `*.example.com` is also accepted. |
| `DENIED_HOSTS` | _(empty)_ | Comma-separated hosts to block (subdomains included). Takes precedence. |
| `BLOCK_PRIVATE_IPS` | `true` | Blocks `localhost`, RFC1918, link-local/cloud metadata (`169.254.0.0/16`), CGNAT, multicast, and private IPv6. Set to `false` to disable. |
| `FETCH_TIMEOUT_MS` | `30000` | Upstream fetch timeout in milliseconds. |

Example:

```toml
[vars]
ALLOWED_HOSTS = "telegram.org,*.github.com,core.telegram.org"
DENIED_HOSTS  = "facebook.com"
FETCH_TIMEOUT_MS = "30000"
```

## Deployment

`wrangler.toml`:

```toml
name = "cl-proxy"
main = "worker-v2.js"
compatibility_date = "2024-11-01"

[vars]
# ALLOWED_HOSTS = "example.com"
```

Then:

```sh
npx wrangler deploy
```

Attach a route or custom domain (e.g. `px.example.com/*`) in the Cloudflare dashboard, or use the generated `workers.dev` URL.

## How it works

1. The request path after the worker origin is the target URL. The target's query string is carried as the worker's query string.
2. The worker fetches the target (`redirect: "manual"`, timeout, SSRF/allowlist checks).
3. HTML is streamed through `HTMLRewriter`; URLs are resolved with `new URL(value, documentBase)` and prefixed with the worker origin. A small runtime shim is injected first.
4. CSS is rewritten (`url()`, `@import`).
5. `Set-Cookie` is merged into the per-host jar and re-emitted as worker-origin cookies.
6. Redirects have their `Location` rewritten into the proxy.

## Limitations

- **`location.href = '...'` cannot be intercepted** in browsers (the `location` object is unforgeable). The worker's Referer/`__p_last` fallback handles most of these, but a navigation with no referer and no prior target can still fail.
- **WebSockets are not proxied.**
- Cookies live in client-side cookies on the worker origin and are capped at roughly 42 KB; very cookie-heavy sites may overflow.
- **DNS rebinding** cannot be fully prevented (Workers cannot resolve hostnames before fetching); the private-range checks cover literal IPs and known local names.
- Some sites with aggressive bot protection may block Cloudflare Worker egress.
- Sites that rely on reading `location.pathname` may behave oddly because the browser URL contains the proxied target path.

## Credits

Created by SadeghPM, based on work by [SeRaMo](https://github.com/seramo/).
