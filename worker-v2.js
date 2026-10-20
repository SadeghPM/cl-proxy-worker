/**
 * Cloudflare Worker Proxy — v2
 * Author: SadeghPM based on SeRaMo work ( https://github.com/seramo/ )
 *
 * Changes vs v1:
 *  - Uses Cloudflare's native HTMLRewriter (streaming HTML parser) instead of
 *    a pile of regex passes. Correct attribute handling, no full-document
 *    buffering, single pass over the body.
 *  - Fixes relative URL resolution: URLs are resolved with `new URL(value, base)`
 *    against the *document* URL (and `<base href>` when present), so
 *    `/blog/post` + `page2` -> `/blog/post/page2`, `../` works, and
 *    protocol-relative (`//cdn.host/x`) URLs are handled.
 *  - Strips `integrity` / `crossorigin` on rewritten tags so SRI doesn't block
 *    the proxied resources.
 *  - Strips hop-by-hop and origin-assuming response headers:
 *    content-length, content-encoding, CSP, X-Frame-Options, HSTS, COOP/COEP/CORP, ...
 *  - Rewrites `Origin` / `Referer` on the outgoing request back to the target
 *    origin so sites don't reject us as cross-site.
 *  - Handles redirects manually and rewrites `Location` back into the proxy.
 *  - Cookie jar (step 3): upstream Set-Cookie values are stored in a jar
 *    cookie on the worker origin, keyed per target host + path, and replayed
 *    on subsequent requests. This gives working sessions without mixing
 *    cookies between different proxied sites.
 *  - Runtime shim (step 4): a small script is injected at the top of <head>
 *    that patches fetch, XMLHttpRequest, history.pushState/replaceState,
 *    location.assign/replace, window.open, sendBeacon, common URL-reflecting
 *    element properties, and document.cookie, so JS/SPA navigation keeps
 *    flowing through the proxy.
 *  - Safety (step 5): SSRF guard that blocks localhost/private/link-local/
 *    metadata ranges by default, optional ALLOWED_HOSTS / DENIED_HOSTS lists,
 *    and a configurable upstream fetch timeout.
 *
 * NOTE: Still intentionally out of scope here (see the review):
 *  - WebSocket proxying, host/subdomain based mapping, caching
 */

// Response headers that must not be forwarded verbatim. Either they are managed
// by the Workers runtime (length/encoding), or they assume the *real* origin and
// would break the proxied page, or they are hop-by-hop.
const STRIP_RESPONSE_HEADERS = [
  // managed by the runtime / would corrupt the body we resend
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'connection',
  'keep-alive',
  // security headers that assume the real origin
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'strict-transport-security',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'report-to',
  'nel',
  'clear-site-data',
  'alt-svc',
  'expect-ct',
  // cookies are handled by our own jar (see writeJar/storeSetCookies)
  'set-cookie',
];

// HTML attributes that carry a single URL.
const URL_ATTRIBUTES = [
  'href',
  'src',
  'action',
  'formaction',
  'poster',
  'background',
  'cite',
  'longdesc',
  'manifest',
  'data',
  'data-src',
  'data-href',
];

const SCHEME_PREFIX = /^(?:data:|blob:|javascript:|mailto:|tel:|sms:|about:|#|chrome:|view-source:)/i;

// --- configuration --------------------------------------------------------
// Bindings are optional; when unset the proxy stays open (like before) but
// still blocks private/internal targets. Set them in wrangler.toml as
// [vars] ALLOWED_HOSTS / DENIED_HOSTS / BLOCK_PRIVATE_IPS / FETCH_TIMEOUT_MS.
const CONFIG = {
  allow: parseHostList(globalThis.ALLOWED_HOSTS),
  deny: parseHostList(globalThis.DENIED_HOSTS),
  blockPrivate: globalThis.BLOCK_PRIVATE_IPS !== 'false',
  timeoutMs: Number(globalThis.FETCH_TIMEOUT_MS) || 30000,
};

function parseHostList(value) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value.join(',') : String(value);
  return raw
    .split(',')
    .map(s => s.trim().toLowerCase().replace(/^\.+/, ''))
    .filter(Boolean);
}

// An entry matches the host itself or any subdomain. `*.example.com` behaves
// the same as `example.com` for suffix matching.
function matchesHostList(host, list) {
  for (const entry of list) {
    const suffix = entry.startsWith('*.') ? entry.slice(2) : entry;
    if (host === suffix || host.endsWith(`.${suffix}`)) return true;
  }
  return false;
}

function isPrivateHost(host) {
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan')
  ) {
    return true;
  }

  // IPv4 (WHATWG normalizes decimal/octal/hex forms to dotted decimal).
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }

  // IPv6 (hostname may arrive wrapped in brackets).
  if (host.includes(':')) {
    const h = host.replace(/^\[|\]$/g, '').toLowerCase();
    if (h === '::1' || h === '::') return true;
    if (h.startsWith('fc') || h.startsWith('fd')) return true; // fc00::/7
    if (/^fe[89ab]/.test(h)) return true; // fe80::/10
    if (h.startsWith('::ffff:')) return isPrivateHost(h.slice(7));
    return false;
  }

  return false;
}

function isHostAllowed(host) {
  if (matchesHostList(host, CONFIG.deny)) return false;
  if (CONFIG.allow.length && !matchesHostList(host, CONFIG.allow)) return false;
  if (CONFIG.blockPrivate && isPrivateHost(host)) return false;
  return true;
}

// --- cookie jar -----------------------------------------------------------
// The whole jar lives in HTTP-only cookie(s) on the worker origin. Each entry
// remembers the target domain/path it belongs to, so cookies for different
// proxied sites never mix. Large jars are split across `__p_jar`, `__p_jar_1`...
const JAR_COOKIE = '__p_jar';
// JS-visible cookies (non-HttpOnly upstream cookies + anything the page sets
// via document.cookie) live here, so the shim can read/write them synchronously
// while HttpOnly cookies stay hidden from page scripts.
const JS_COOKIE = '__pjs';
// Remembers the most recently proxied target, used as a fallback when a request
// arrives without the target prefix (e.g. location.href = '/x' from page JS).
const LAST_COOKIE = '__p_last';
const JAR_CHUNK_SIZE = 3500; // encoded chars per cookie value (browser cap ~4KB)
const JAR_MAX_CHUNKS = 12;
const JAR_MAX_AGE = 31536000; // 1 year, refreshed on every change

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

// Read and reassemble one family of chunked jar cookies.
function readCookieFamily(cookieHeader, baseName) {
  const values = {};
  if (cookieHeader) {
    for (const pair of cookieHeader.split(';')) {
      const i = pair.indexOf('=');
      if (i < 0) continue;
      const name = pair.slice(0, i).trim();
      if (name === baseName || name.startsWith(`${baseName}_`)) {
        values[name] = pair.slice(i + 1).trim();
      }
    }
  }

  let encoded = values[baseName] || '';
  for (let n = 1; values[`${baseName}_${n}`] != null; n++) {
    encoded += values[`${baseName}_${n}`];
  }

  let list = [];
  if (encoded) {
    try {
      const parsed = JSON.parse(decodeURIComponent(encoded));
      if (Array.isArray(parsed)) list = parsed;
    } catch (e) {
      /* corrupt store -> start fresh */
    }
  }
  return { list, count: Object.keys(values).length };
}

// Read and reassemble the whole jar (both HttpOnly and JS-visible entries).
function readJar(cookieHeader) {
  const httpOnly = readCookieFamily(cookieHeader, JAR_COOKIE);
  const js = readCookieFamily(cookieHeader, JS_COOKIE);
  for (const c of httpOnly.list) c.js = false;
  for (const c of js.list) c.js = true;
  return {
    jar: httpOnly.list.concat(js.list),
    chunkCounts: { [JAR_COOKIE]: httpOnly.count, [JS_COOKIE]: js.count },
  };
}

// Collect the cookies that should be sent to a given target host/path.
function collectCookies(jar, host, path, isSecure) {
  const now = Date.now() / 1000;
  const matched = [];
  for (const c of jar) {
    if (c.expires != null && c.expires <= now) continue;
    if (c.secure && !isSecure) continue;
    if (!domainMatches(host, c)) continue;
    if (!pathMatches(path, c.path)) continue;
    matched.push(c);
  }
  // RFC 6265: longer paths first.
  matched.sort((a, b) => b.path.length - a.path.length);
  return matched;
}

function domainMatches(host, cookie) {
  if (cookie.hostOnly) return host === cookie.domain;
  return host === cookie.domain || host.endsWith(`.${cookie.domain}`);
}

function pathMatches(requestPath, cookiePath) {
  if (!cookiePath || cookiePath === '/' || requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

// Merge upstream Set-Cookie headers into the jar. Returns true if it changed.
function storeSetCookies(jar, headers, requestHost) {
  const list = getSetCookieHeaders(headers);
  if (!list.length) return false;

  const now = Date.now() / 1000;
  let changed = false;

  for (const raw of list) {
    const c = parseSetCookie(raw);
    if (!c) continue;

    let domain = c.domain;
    const hostOnly = !domain;
    if (domain) {
      // Reject cookies that don't actually belong to the host we talked to.
      if (domain !== requestHost && !requestHost.endsWith(`.${domain}`)) continue;
    } else {
      domain = requestHost;
    }

    const expired =
      (c.maxAge != null && c.maxAge <= 0) || (c.expires != null && c.expires <= now);
    const idx = jar.findIndex(
      x => x.domain === domain && x.path === c.path && x.name === c.name
    );

    if (expired) {
      if (idx >= 0) {
        jar.splice(idx, 1);
        changed = true;
      }
      continue;
    }

    const entry = {
      domain,
      hostOnly,
      path: c.path,
      name: c.name,
      value: c.value,
      expires: c.maxAge != null ? now + c.maxAge : c.expires != null ? c.expires : null,
      secure: c.secure,
      js: !c.httpOnly,
    };

    if (idx >= 0) {
      const prev = jar[idx];
      if (
        prev.value !== entry.value ||
        prev.expires !== entry.expires ||
        prev.secure !== entry.secure ||
        prev.js !== entry.js
      ) {
        jar[idx] = entry;
        changed = true;
      }
    } else {
      jar.push(entry);
      changed = true;
    }
  }
  return changed;
}

// Serialize the (non-expired) jar back into Set-Cookie headers, splitting it
// into the HttpOnly store and the JS-visible store.
function writeJar(headers, jar, previousCounts, workerUrl) {
  const now = Date.now() / 1000;
  const live = jar.filter(c => c.expires == null || c.expires > now);
  writeCookieFamily(
    headers,
    JAR_COOKIE,
    live.filter(c => !c.js),
    (previousCounts && previousCounts[JAR_COOKIE]) || 0,
    workerUrl,
    true
  );
  writeCookieFamily(
    headers,
    JS_COOKIE,
    live.filter(c => c.js),
    (previousCounts && previousCounts[JS_COOKIE]) || 0,
    workerUrl,
    false
  );
}

function writeCookieFamily(headers, baseName, entries, previousCount, workerUrl, httpOnly) {
  if (!entries.length && !previousCount) return;

  const attrs = `${workerUrl.startsWith('https:') ? '; Secure' : ''}${
    httpOnly ? '; HttpOnly' : ''
  }; SameSite=Lax; Path=/`;

  if (!entries.length) {
    headers.append('Set-Cookie', `${baseName}=; Max-Age=0${attrs}`);
    for (let n = 1; n < previousCount; n++) {
      headers.append('Set-Cookie', `${baseName}_${n}=; Max-Age=0${attrs}`);
    }
    return;
  }

  const encoded = encodeURIComponent(JSON.stringify(entries));
  const chunks = [];
  for (let i = 0; i < encoded.length && chunks.length < JAR_MAX_CHUNKS; i += JAR_CHUNK_SIZE) {
    chunks.push(encoded.slice(i, i + JAR_CHUNK_SIZE));
  }

  chunks.forEach((chunk, i) => {
    const name = i === 0 ? baseName : `${baseName}_${i}`;
    headers.append('Set-Cookie', `${name}=${chunk}; Max-Age=${JAR_MAX_AGE}${attrs}`);
  });
  // Clear any now-unused higher chunks from a previous, larger jar.
  for (let n = chunks.length; n < previousCount; n++) {
    headers.append('Set-Cookie', `${baseName}_${n}=; Max-Age=0${attrs}`);
  }
}

function getSetCookieHeaders(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  if (typeof headers.getAll === 'function') return headers.getAll('set-cookie');
  return [];
}

// Minimal Set-Cookie parser: name, value and the attributes we care about.
function parseSetCookie(str) {
  const parts = String(str).split(';');
  const first = parts.shift();
  const eq = first.indexOf('=');
  if (eq < 0) return null;

  const cookie = {
    name: first.slice(0, eq).trim(),
    value: first.slice(eq + 1).trim(),
    domain: null,
    path: '/',
    secure: false,
    httpOnly: false,
    maxAge: null,
    expires: null,
  };

  for (const attr of parts) {
    const i = attr.indexOf('=');
    const key = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
    const val = i < 0 ? '' : attr.slice(i + 1).trim();
    if (key === 'domain') cookie.domain = val.replace(/^\./, '').toLowerCase();
    else if (key === 'path') cookie.path = val || '/';
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'max-age') cookie.maxAge = parseInt(val, 10);
    else if (key === 'expires') cookie.expires = Date.parse(val) / 1000;
  }

  if (!cookie.name) return null;
  if (cookie.maxAge != null && Number.isNaN(cookie.maxAge)) cookie.maxAge = null;
  if (cookie.expires != null && Number.isNaN(cookie.expires)) cookie.expires = null;
  return cookie;
}


async function handleRequest(request) {
  const url = new URL(request.url);
  const workerUrl = url.origin;
  const rawTarget = url.pathname.slice(1);

  if (!rawTarget) {
    return landingPage(workerUrl);
  }

  // --- resolve + validate the target -------------------------------------
  const targetUrl = absoluteTarget(rawTarget, url.search);

  // The path is not an absolute URL. That means the page (or its JS) built a
  // URL without the proxy prefix, e.g. `location.href = '/faq'`, a root-relative
  // `fetch('/api')`, or a hard-coded path. Reconstruct the intended target from
  // the referer (our own proxied URL) or the last-known target, then bounce the
  // browser to the correctly-prefixed URL so everything stays inside the proxy.
  if (!targetUrl) {
    const base =
      refererTarget(request.headers.get('referer'), workerUrl) ||
      readLastTarget(request.headers.get('cookie'));
    if (base) {
      const resolved = resolveAgainst(base, rawTarget + url.search);
      if (resolved) return redirectTo(`${workerUrl}/${resolved}`, 307);
    }
    return errorPage('Provide a valid http(s) URL.', 400);
  }
  const targetHref = targetUrl.href;

  // --- abuse / SSRF guard -------------------------------------------------
  const targetHost = targetUrl.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!isHostAllowed(targetHost)) {
    return errorPage('This host is not allowed through the proxy.', 403);
  }

  // --- build the outgoing request ----------------------------------------
  const requestHeaders = new Headers();
  for (const [key, value] of request.headers) {
    const k = key.toLowerCase();
    if (k === 'cookie' || k === 'host') continue;
    requestHeaders.set(key, value);
  }
  // Restore the target site's cookies from our jar (keyed per host + path).
  const { jar, chunkCounts } = readJar(request.headers.get('cookie'));
  const outgoingCookies = collectCookies(
    jar,
    targetUrl.hostname,
    targetUrl.pathname || '/',
    targetUrl.protocol === 'https:'
  );
  if (outgoingCookies.length) {
    requestHeaders.set('cookie', outgoingCookies.map(c => `${c.name}=${c.value}`).join('; '));
  }
  // Map Origin/Referer back to the target so sites don't see a foreign origin.
  const origin = request.headers.get('origin');
  if (origin && origin !== 'null') {
    requestHeaders.set('origin', targetUrl.origin);
  }
  const referer = request.headers.get('referer');
  if (referer) {
    const idx = referer.indexOf(workerUrl);
    requestHeaders.set('referer', idx === 0 ? referer.slice(workerUrl.length + 1) : referer);
  }

  const init = {
    method: request.method,
    headers: requestHeaders,
    redirect: 'manual',
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
  }

  let response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.timeoutMs);
  try {
    response = await fetch(targetUrl.href, { ...init, signal: controller.signal });
  } catch (e) {
    const timedOut = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
    return errorPage(
      timedOut ? 'The target took too long to respond.' : 'Error fetching the target URL.',
      502
    );
  } finally {
    clearTimeout(timer);
  }

  const responseHeaders = new Headers(response.headers);
  for (const name of STRIP_RESPONSE_HEADERS) responseHeaders.delete(name);

  // --- cookie jar: absorb upstream Set-Cookie, re-emit as our jar ---------
  if (storeSetCookies(jar, response.headers, targetUrl.hostname)) {
    writeJar(responseHeaders, jar, chunkCounts, workerUrl);
  }

  // Remember this target so un-prefixed URLs can be resolved later.
  if (readLastTarget(request.headers.get('cookie')) !== targetHref) {
    appendLastTarget(responseHeaders, targetHref, workerUrl);
  }

  // --- redirects: rewrite Location back into the proxy --------------------
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (location) {
      responseHeaders.set('location', proxify(location, targetHref, workerUrl) || location);
    }
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml+xml');
  const isCss = contentType.includes('text/css');

  // --- HTML: stream through HTMLRewriter ---------------------------------
  if (request.method === 'GET' && isHtml && response.body) {
    const state = { workerUrl, docBase: targetHref };
    const rewriter = buildHtmlRewriter(state);
    return rewriter.transform(
      new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      })
    );
  }

  // --- CSS: buffer (small) and rewrite url()/@import ---------------------
  if (request.method === 'GET' && isCss) {
    const css = await response.text();
    return new Response(rewriteCss(css, targetHref, workerUrl), {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  }

  // --- everything else: stream straight through --------------------------
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

/**
 * Parse `rawTarget` (the path after the worker origin) as an absolute http(s)
 * URL, applying the worker's query string. Returns null when it isn't one.
 */
function absoluteTarget(rawTarget, search) {
  try {
    const u = new URL(rawTarget);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (search) u.search = search;
    return u;
  } catch (e) {
    return null;
  }
}

// Resolve `relative` against a base target URL, returning an absolute http(s)
// href or null.
function resolveAgainst(base, relative) {
  try {
    const u = new URL(relative, base);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
  } catch (e) {}
  return null;
}

// Extract the target from a referer that points at one of our proxied URLs.
function refererTarget(referer, workerUrl) {
  if (!referer) return null;
  const prefix = `${workerUrl}/`;
  const idx = referer.indexOf(prefix);
  if (idx < 0) return null;
  return resolveAgainst(workerUrl, referer.slice(idx + prefix.length));
}

function readLastTarget(cookieHeader) {
  if (!cookieHeader) return null;
  for (const pair of cookieHeader.split(';')) {
    const i = pair.indexOf('=');
    if (i < 0) continue;
    if (pair.slice(0, i).trim() === LAST_COOKIE) {
      try {
        return decodeURIComponent(pair.slice(i + 1).trim()) || null;
      } catch (e) {
        return null;
      }
    }
  }
  return null;
}

function appendLastTarget(headers, targetHref, workerUrl) {
  const secure = workerUrl.startsWith('https:') ? '; Secure' : '';
  headers.append(
    'Set-Cookie',
    `${LAST_COOKIE}=${encodeURIComponent(targetHref)}; Max-Age=${JAR_MAX_AGE}; SameSite=Lax; Path=/${secure}`
  );
}

function redirectTo(location, status) {
  return new Response(null, { status, headers: { location } });
}

/**
 * Turn a possibly-relative URL into an absolute proxy URL.
 * Returns null when the value should be left untouched.
 */
function proxify(value, base, workerUrl) {
  if (value == null) return null;
  const v = value.trim();
  if (!v || SCHEME_PREFIX.test(v)) return null;
  if (v.startsWith(workerUrl)) return null; // already proxied

  let absolute;
  try {
    absolute = new URL(v, base);
  } catch (e) {
    return null;
  }
  if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') return null;
  return `${workerUrl}/${absolute.href}`;
}

/**
 * Build the HTMLRewriter with all URL-bearing handlers wired to `state`.
 * `state.docBase` is mutated when a <base href> is encountered so elements
 * after it resolve correctly.
 */
function buildHtmlRewriter(state) {
  const rewriter = new HTMLRewriter();

  for (const attr of URL_ATTRIBUTES) {
    rewriter.on(`[${attr}]`, {
      element(el) {
        const raw = el.getAttribute(attr);
        if (raw == null) return;

        if (el.tagName === 'base' && attr === 'href') {
          handleBase(el, raw, state);
          return;
        }

        const out = proxify(raw, state.docBase, state.workerUrl);
        if (out == null) return;
        el.setAttribute(attr, out);
        // SRI breaks as soon as the URL is rewritten.
        el.removeAttribute('integrity');
        el.removeAttribute('crossorigin');
      },
    });
  }

  // srcset / imagesrcset hold a comma-separated candidate list.
  for (const attr of ['srcset', 'imagesrcset']) {
    rewriter.on(`[${attr}]`, {
      element(el) {
        const raw = el.getAttribute(attr);
        if (raw == null) return;
        el.setAttribute(attr, rewriteSrcset(raw, state));
      },
    });
  }

  // Inline style="..." attributes.
  rewriter.on('[style]', {
    element(el) {
      const raw = el.getAttribute('style');
      if (raw == null) return;
      el.setAttribute('style', rewriteCss(raw, state.docBase, state.workerUrl));
    },
  });

  // <style> blocks (per text chunk — see note in README-ish comment).
  rewriter.on('style', {
    text(chunk) {
      chunk.replace(rewriteCss(chunk.text, state.docBase, state.workerUrl));
    },
  });

  // <meta http-equiv="refresh" content="0; url=...">
  rewriter.on('meta', {
    element(el) {
      const equiv = el.getAttribute('http-equiv');
      if (!equiv || equiv.toLowerCase() !== 'refresh') return;
      const content = el.getAttribute('content');
      if (!content) return;
      const match = content.match(/url\s*=\s*(['"]?)([^'";]+)\1/i);
      if (!match) return;
      const out = proxify(match[2].trim(), state.docBase, state.workerUrl);
      if (out) el.setAttribute('content', content.replace(match[2], out));
    },
  });

  // Inject the runtime shim as early as possible so it runs before page code.
  const shim = `<script>(${proxyRuntime.toString()})(${JSON.stringify(
    state.workerUrl
  )}, ${JSON.stringify(state.docBase)});</script>`;
  const inject = el => {
    if (state.injected) return;
    state.injected = true;
    el.prepend(shim, { html: true });
  };
  rewriter.on('html', { element: inject });
  rewriter.on('head', { element: inject });
  rewriter.on('body', { element: inject });

  return rewriter;
}

/**
 * The client-side shim, serialized into the page. Kept as a real function so it
 * stays readable/lintable; it must not reference anything from worker scope.
 * Receives the worker origin and the current target URL.
 */
function proxyRuntime(WORKER, TARGET) {
  'use strict';

  var PREFIX = WORKER + '/';
  var SKIP = /^(?:data:|blob:|javascript:|mailto:|tel:|sms:|about:|#)/i;
  var JS_COOKIE = '__pjs';
  var VIRTUAL = TARGET; // the target URL the current document represents

  function currentHost() {
    try {
      return new URL(VIRTUAL).hostname;
    } catch (e) {
      return '';
    }
  }

  // Resolve a value to an absolute *target* URL (undoing an existing prefix).
  function toTarget(value) {
    var s = String(value);
    if (s.indexOf(PREFIX) === 0) s = s.slice(PREFIX.length);
    try {
      var abs = new URL(s, VIRTUAL);
      if (abs.protocol === 'http:' || abs.protocol === 'https:') return abs.href;
    } catch (e) {}
    return null;
  }

  function proxify(value) {
    if (value == null) return value;
    var s = String(value);
    if (!s || s.indexOf(PREFIX) === 0 || SKIP.test(s)) return value;
    var target = toTarget(s);
    return target ? PREFIX + target : value;
  }

  // ---- fetch ----------------------------------------------------------
  var nativeFetch = window.fetch;
  if (nativeFetch) {
    var cloneRequest = function (request, url) {
      var init = {
        method: request.method,
        headers: request.headers,
        mode: request.mode,
        credentials: request.credentials,
        cache: request.cache,
        redirect: request.redirect,
        referrer: request.referrer,
        referrerPolicy: request.referrerPolicy,
        integrity: request.integrity,
        keepalive: request.keepalive,
        signal: request.signal,
      };
      if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
        init.body = request.body;
        init.duplex = 'half';
      }
      return new Request(url, init);
    };

    window.fetch = function (input, init) {
      try {
        if (typeof Request !== 'undefined' && input instanceof Request) {
          var request = cloneRequest(input, proxify(input.url));
          return nativeFetch.call(this, init ? new Request(request, init) : request);
        }
        var url =
          typeof URL !== 'undefined' && input instanceof URL ? input.href : input;
        return nativeFetch.call(this, proxify(url), init);
      } catch (e) {
        return nativeFetch.call(this, input, init);
      }
    };
  }

  // ---- XMLHttpRequest -------------------------------------------------
  if (window.XMLHttpRequest) {
    var nativeOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      var args = Array.prototype.slice.call(arguments);
      args[1] = proxify(url);
      return nativeOpen.apply(this, args);
    };
  }

  // ---- history --------------------------------------------------------
  ['pushState', 'replaceState'].forEach(function (name) {
    var native = history[name];
    history[name] = function (state, title, url) {
      if (url != null) {
        var target = toTarget(url);
        if (target) {
          VIRTUAL = target;
          url = PREFIX + target;
        }
      }
      return native.call(history, state, title, url);
    };
  });

  // ---- window.open / location.assign|replace / sendBeacon -------------
  var nativeWindowOpen = window.open;
  window.open = function (url) {
    var args = Array.prototype.slice.call(arguments);
    if (url != null) args[0] = proxify(url);
    return nativeWindowOpen.apply(window, args);
  };

  try {
    var nativeAssign = Location.prototype.assign;
    Location.prototype.assign = function (url) {
      return nativeAssign.call(location, proxify(url));
    };
    var nativeReplace = Location.prototype.replace;
    Location.prototype.replace = function (url) {
      return nativeReplace.call(location, proxify(url));
    };
  } catch (e) {}

  if (navigator.sendBeacon) {
    var nativeBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) {
      return nativeBeacon(proxify(url), data);
    };
  }

  // ---- URL-reflecting element properties ------------------------------
  function patchProperty(Ctor, prop) {
    if (!Ctor) return;
    var desc = Object.getOwnPropertyDescriptor(Ctor.prototype, prop);
    if (!desc || !desc.set) return;
    try {
      Object.defineProperty(Ctor.prototype, prop, {
        configurable: true,
        enumerable: desc.enumerable,
        get: function () {
          return desc.get.call(this);
        },
        set: function (value) {
          return desc.set.call(this, proxify(value));
        },
      });
    } catch (e) {}
  }
  patchProperty(window.HTMLImageElement, 'src');
  patchProperty(window.HTMLScriptElement, 'src');
  patchProperty(window.HTMLLinkElement, 'href');
  patchProperty(window.HTMLIFrameElement, 'src');
  patchProperty(window.HTMLSourceElement, 'src');
  patchProperty(window.HTMLMediaElement, 'src');
  patchProperty(window.HTMLAnchorElement, 'href');
  patchProperty(window.HTMLAreaElement, 'href');
  patchProperty(window.HTMLFormElement, 'action');

  // Catch dynamic attribute writes too (el.setAttribute('src', '/x')).
  var URL_ATTRS = {
    href: 1, src: 1, action: 1, formaction: 1, poster: 1, background: 1,
    cite: 1, longdesc: 1, manifest: 1, 'data-src': 1, 'data-href': 1,
  };
  if (window.Element && Element.prototype.setAttribute) {
    var nativeSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      if (value != null && URL_ATTRS[String(name).toLowerCase()]) {
        value = proxify(value);
      }
      return nativeSetAttribute.call(this, name, value);
    };
  }

  // ---- document.cookie <-> JS-visible store ---------------------------
  var proto = window.Document && Document.prototype;
  var cookieDesc = proto && Object.getOwnPropertyDescriptor(proto, 'cookie');
  if (cookieDesc && cookieDesc.get && cookieDesc.set) {
    var nativeGet = cookieDesc.get;
    var nativeSet = cookieDesc.set;

    var readStore = function () {
      var raw = nativeGet.call(document) || '';
      var base = null;
      var chunks = {};
      raw.split(';').forEach(function (part) {
        var p = part.trim();
        var eq = p.indexOf('=');
        if (eq < 0) return;
        var name = p.slice(0, eq);
        var value = p.slice(eq + 1);
        if (name === JS_COOKIE) base = value;
        else if (name.indexOf(JS_COOKIE + '_') === 0) {
          var idx = parseInt(name.slice(JS_COOKIE.length + 1), 10);
          if (!isNaN(idx)) chunks[idx] = value;
        }
      });
      var encoded = base || '';
      if (base != null) {
        for (var i = 1; chunks[i] != null; i++) encoded += chunks[i];
      }
      if (!encoded) return {};
      try {
        return JSON.parse(decodeURIComponent(encoded)) || {};
      } catch (e) {
        return {};
      }
    };

    var writeStore = function (map) {
      var encoded = encodeURIComponent(JSON.stringify(map));
      var secure = location.protocol === 'https:' ? '; Secure' : '';
      if (!encoded || encoded === '%7B%7D') {
        nativeSet.call(document, JS_COOKIE + '=; Max-Age=0; Path=/' + secure);
        return;
      }
      for (var i = 0, n = 0; n < encoded.length; i++, n += 3500) {
        var name = i === 0 ? JS_COOKIE : JS_COOKIE + '_' + i;
        nativeSet.call(
          document,
          name + '=' + encoded.slice(n, n + 3500) +
            '; Max-Age=31536000; Path=/; SameSite=Lax' + secure
        );
      }
    };

    try {
      Object.defineProperty(proto, 'cookie', {
        configurable: true,
        enumerable: cookieDesc.enumerable,
        get: function () {
          var store = readStore()[currentHost()] || {};
          return Object.keys(store)
            .map(function (key) {
              return key + '=' + store[key];
            })
            .join('; ');
        },
        set: function (value) {
          var segments = String(value).split(';');
          var first = segments.shift();
          var eq = first.indexOf('=');
          if (eq < 0) return value;

          var name = first.slice(0, eq).trim();
          var val = first.slice(eq + 1).trim();
          var map = readStore();
          var host = currentHost();
          var store = map[host] || (map[host] = {});
          var remove = false;

          segments.forEach(function (segment) {
            var s = segment.trim().toLowerCase();
            if (s.indexOf('max-age=') === 0) {
              if (parseInt(s.slice(8), 10) <= 0) remove = true;
            } else if (s.indexOf('expires=') === 0) {
              var when = Date.parse(segment.trim().slice(8));
              if (!isNaN(when) && when <= Date.now()) remove = true;
            }
          });

          if (remove) delete store[name];
          else store[name] = val;
          if (!Object.keys(store).length) delete map[host];
          writeStore(map);
          return value;
        },
      });
    } catch (e) {}
  }
}

function handleBase(el, raw, state) {
  try {
    const resolved = new URL(raw, state.docBase);
    state.docBase = resolved.href;
    el.setAttribute('href', `${state.workerUrl}/${resolved.href}`);
  } catch (e) {
    /* leave the base tag alone if it can't be resolved */
  }
}

function rewriteSrcset(value, state) {
  return value
    .split(',')
    .map(part => {
      const trimmed = part.trim();
      if (!trimmed) return part;
      const match = trimmed.match(/^(\S+)(\s+.*)?$/);
      if (!match) return part;
      const out = proxify(match[1], state.docBase, state.workerUrl);
      if (out == null) return part;
      return match[2] ? `${out}${match[2]}` : out;
    })
    .join(', ');
}

/**
 * Rewrite url() and @import inside a CSS string.
 */
function rewriteCss(css, base, workerUrl) {
  // url( ... ) — quoted or bare.
  css = css.replace(
    /url\(\s*(?:'([^']*)'|"([^"]*)"|([^)'"\s][^)'"]*))\s*\)/gi,
    (match, single, double, bare) => {
      const raw = single != null ? single : double != null ? double : bare;
      const out = proxify(raw, base, workerUrl);
      return out ? `url("${out}")` : match;
    }
  );

  // @import "..." (string form; url() form already handled above).
  css = css.replace(
    /@import\s+(['"])([^'"]+)\1\s*;?/gi,
    (match, quote, raw) => {
      const out = proxify(raw, base, workerUrl);
      return out ? `@import "${out}";` : match;
    }
  );

  return css;
}

// --- tiny UI --------------------------------------------------------------

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

function landingPage(workerUrl) {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Proxy</title>
<style>
  body{margin:0;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:grid;place-items:center;min-height:100vh;background:#0f1115;color:#e6e6e6}
  main{width:min(520px,90vw)}
  h1{font-size:1.25rem;font-weight:600;margin:0 0 1rem}
  form{display:flex;gap:.5rem}
  input{flex:1;padding:.7rem .9rem;border-radius:10px;border:1px solid #2a2f3a;background:#171a21;color:inherit;outline:none}
  input:focus{border-color:#4a7dff}
  button{padding:.7rem 1.1rem;border-radius:10px;border:0;background:#4a7dff;color:#fff;cursor:pointer;font-weight:600}
  p{color:#8b93a7;font-size:.85rem;margin-top:.9rem}
</style></head>
<body><main>
  <h1>Browse through the proxy</h1>
  <form onsubmit="event.preventDefault();var u=this.url.value.trim();if(u)location.href='/${escapeHtml(workerUrl)}/'+u;">
    <input name="url" placeholder="https://example.com" autofocus autocomplete="off">
    <button type="submit">Go</button>
  </form>
  <p>Or open <code>${escapeHtml(workerUrl)}/https://example.com</code></p>
</main></body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function errorPage(message, status) {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Proxy error</title>
<style>body{margin:0;font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;background:#0f1115;color:#e6e6e6}</style>
</head><body><p>${escapeHtml(message)}</p></body></html>`;
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}
