/**
 * Node test suite for worker-v2.js.
 *
 * Runs the worker source in a VM with tiny stubs so the pure logic (URL
 * resolution, cookie jar, SSRF guards) and the injected client shim can be
 * exercised without a Cloudflare runtime.
 *
 *   node test/run.js      (or: npm test)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'worker-v2.js'), 'utf8');
const WORKER = 'https://w.dev';

let pass = 0;
let fail = 0;

function ok(label, condition) {
  if (condition) pass++;
  else fail++;
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`);
}

function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(`${label}${a === e ? '' : `\n       got  ${a}\n       want ${e}`}`, a === e);
}

// Load the worker in a fresh VM. `globals` simulates Worker [vars].
function loadWorker(globals = {}) {
  const ctx = {
    addEventListener() {},
    HTMLRewriter: class {},
    URL,
    Headers,
    Response,
    Request,
    fetch() {},
    console,
    ...globals,
  };
  vm.createContext(ctx);
  vm.runInContext(SOURCE, ctx);
  return ctx;
}

// ---------------------------------------------------------------------------
console.log('\n# URL resolution (worker)');
const w = loadWorker();

eq('relative against dir-less base', w.proxify('page2', 'https://example.com/blog/post', WORKER), `${WORKER}/https://example.com/blog/page2`);
eq('relative against trailing slash', w.proxify('page2', 'https://example.com/blog/', WORKER), `${WORKER}/https://example.com/blog/page2`);
eq('root-relative', w.proxify('/about', 'https://example.com/blog/', WORKER), `${WORKER}/https://example.com/about`);
eq('dot-dot', w.proxify('../x', 'https://example.com/blog/post/', WORKER), `${WORKER}/https://example.com/blog/x`);
eq('protocol-relative', w.proxify('//cdn.host/a.js', 'https://example.com/', WORKER), `${WORKER}/https://cdn.host/a.js`);
eq('absolute cross-host', w.proxify('http://other.com/p?q=1', 'https://example.com/', WORKER), `${WORKER}/http://other.com/p?q=1`);
eq('data: untouched', w.proxify('data:image/png;base64,AAA', 'https://example.com/', WORKER), null);
eq('fragment untouched', w.proxify('#top', 'https://example.com/', WORKER), null);
eq('mailto untouched', w.proxify('mailto:a@b.com', 'https://example.com/', WORKER), null);
eq('no double-proxy', w.proxify(`${WORKER}/https://x.com/`, 'https://example.com/', WORKER), null);

eq('css relative url', w.rewriteCss('.a{background:url("../img/a.png")}', 'https://example.com/css/main.css', WORKER), `.a{background:url("${WORKER}/https://example.com/img/a.png")}`);
eq('css absolute url', w.rewriteCss('a{background:url(http://x.com/i.png)}', 'https://example.com/', WORKER), `a{background:url("${WORKER}/http://x.com/i.png")}`);
eq('css data url', w.rewriteCss('a{background:url(data:image/png;base64,AA)}', 'https://example.com/', WORKER), 'a{background:url(data:image/png;base64,AA)}');
eq('css @import', w.rewriteCss('@import "reset.css";', 'https://example.com/css/main.css', WORKER), `@import "${WORKER}/https://example.com/css/reset.css";`);
eq('srcset', w.rewriteSrcset('/a.png 1x, //c.host/b.png 2x', { docBase: 'https://example.com/', workerUrl: WORKER }), `${WORKER}/https://example.com/a.png 1x, ${WORKER}/https://c.host/b.png 2x`);

// ---------------------------------------------------------------------------
console.log('\n# Un-prefixed URL recovery');
eq('absoluteTarget parses', w.absoluteTarget('https://telegram.org/faq', '')?.href, 'https://telegram.org/faq');
eq('absoluteTarget applies query', w.absoluteTarget('https://telegram.org/', '?setln=fa')?.href, 'https://telegram.org/?setln=fa');
eq('absoluteTarget rejects plain path', w.absoluteTarget('faq', ''), null);
eq('absoluteTarget rejects javascript:', w.absoluteTarget('javascript:alert(1)', ''), null);
eq('refererTarget extracts target', w.refererTarget(`${WORKER}/https://telegram.org/faq`, WORKER), 'https://telegram.org/faq');
eq('refererTarget rejects foreign referer', w.refererTarget('https://evil.com/x', WORKER), null);
eq('resolve root-relative', w.resolveAgainst('https://telegram.org/faq', '/x'), 'https://telegram.org/x');
eq('resolve relative', w.resolveAgainst('https://telegram.org/faq', 'x'), 'https://telegram.org/x');
eq('resolve telegram notgs', w.resolveAgainst('https://telegram.org/', '/?notgs=1'), 'https://telegram.org/?notgs=1');

const lastHeaders = new Headers();
w.appendLastTarget(lastHeaders, 'https://telegram.org/faq', WORKER);
const lastCookie = w.getSetCookieHeaders(lastHeaders)[0];
ok('__p_last is emitted', lastCookie.startsWith('__p_last='));
eq('__p_last round-trips', w.readLastTarget(lastCookie.split(';')[0]), 'https://telegram.org/faq');

// ---------------------------------------------------------------------------
console.log('\n# Cookie jar (per-host, httpOnly + js stores)');
const jar = [];
const setCookies = new Headers();
setCookies.append('set-cookie', 'sid=abc; Path=/; HttpOnly; Domain=example.com');
setCookies.append('set-cookie', 'theme=dark; Path=/');
w.storeSetCookies(jar, setCookies, 'www.example.com');
eq('HttpOnly cookie -> __p_jar store', jar.find(c => c.name === 'sid').js, false);
eq('plain cookie -> __pjs store', jar.find(c => c.name === 'theme').js, true);

const jarOut = new Headers();
w.writeJar(jarOut, jar, { __p_jar: 0, __pjs: 0 }, WORKER);
const jarSetCookies = w.getSetCookieHeaders(jarOut);
const httpOnlyCookie = jarSetCookies.find(s => s.startsWith('__p_jar='));
const jsCookie = jarSetCookies.find(s => s.startsWith('__pjs='));
ok('__p_jar is HttpOnly + Secure', /HttpOnly/.test(httpOnlyCookie) && /Secure/.test(httpOnlyCookie));
ok('__pjs is not HttpOnly', !/HttpOnly/.test(jsCookie));

const browserCookieHeader = jarSetCookies.map(s => s.split(';')[0]).join('; ');
const { jar: restored } = w.readJar(browserCookieHeader);
eq('jar round-trips both stores', restored.length, 2);
eq('replay merges both stores', w.collectCookies(restored, 'www.example.com', '/', true).map(c => c.name).sort(), ['sid', 'theme']);
eq('no leak to other host', w.collectCookies(restored, 'other.com', '/', true).length, 0);
eq('no leak to suffix trap', w.collectCookies(restored, 'evil-example.com', '/', true).length, 0);
eq('root path gets both (Path=/)', w.collectCookies(restored, 'www.example.com', '/', true).map(c => c.name).sort(), ['sid', 'theme']);

const pathJar = [];
const pathHeaders = new Headers();
pathHeaders.append('set-cookie', 'root=1; Path=/');
pathHeaders.append('set-cookie', 'app=1; Path=/app');
w.storeSetCookies(pathJar, pathHeaders, 'example.com');
eq('path scoping: /app gets both', w.collectCookies(pathJar, 'example.com', '/app/page', true).map(c => c.name).sort(), ['app', 'root']);
eq('path scoping: / excludes /app', w.collectCookies(pathJar, 'example.com', '/', true).map(c => c.name), ['root']);
eq('secure not sent over http', (() => {
  const j = [];
  const h = new Headers();
  h.append('set-cookie', 'sec=1; Secure; Path=/');
  w.storeSetCookies(j, h, 'a.com');
  return w.collectCookies(j, 'a.com', '/', false).length;
})(), 0);

const deleted = new Headers();
deleted.append('set-cookie', 'sid=; Max-Age=0; Domain=example.com; Path=/');
w.storeSetCookies(restored, deleted, 'www.example.com');
ok('Max-Age=0 deletes cookie', !w.collectCookies(restored, 'www.example.com', '/', true).some(c => c.name === 'sid'));

const foreign = [];
const foreignHeaders = new Headers();
foreignHeaders.append('set-cookie', 'x=1; Domain=evil.com');
ok('foreign Domain rejected', w.storeSetCookies(foreign, foreignHeaders, 'good.com') === false && foreign.length === 0);

// ---------------------------------------------------------------------------
console.log('\n# SSRF / allowlist guards');
const priv = ['localhost', 'foo.local', 'x.internal', '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.0.1', '169.254.169.254', '100.64.0.1', '224.0.0.1', '[::1]', '::1', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1'];
const pub = ['example.com', '8.8.8.8', '172.32.0.1', '2606:4700::1', 'telegram.org'];
for (const host of priv) ok(`private blocked: ${host}`, w.isPrivateHost(host) === true);
for (const host of pub) ok(`public allowed: ${host}`, w.isPrivateHost(host) === false);
ok('default allows public', w.isHostAllowed('example.com') === true);
ok('default blocks cloud metadata', w.isHostAllowed('169.254.169.254') === false);

const allowW = loadWorker({ ALLOWED_HOSTS: 'telegram.org, *.github.com' });
ok('allowlist: apex', allowW.isHostAllowed('telegram.org') === true);
ok('allowlist: subdomain', allowW.isHostAllowed('core.telegram.org') === true);
ok('allowlist: wildcard entry', allowW.isHostAllowed('api.github.com') === true);
ok('allowlist: rejects others', allowW.isHostAllowed('example.com') === false);
ok('allowlist: suffix trap', allowW.isHostAllowed('evil-telegram.org') === false);

const denyW = loadWorker({ DENIED_HOSTS: 'facebook.com' });
ok('denylist: apex', denyW.isHostAllowed('facebook.com') === false);
ok('denylist: subdomain', denyW.isHostAllowed('www.facebook.com') === false);
ok('denylist: others ok', denyW.isHostAllowed('telegram.org') === true);

const openW = loadWorker({ BLOCK_PRIVATE_IPS: 'false' });
ok('BLOCK_PRIVATE_IPS=false allows localhost', openW.isHostAllowed('localhost') === true);

// ---------------------------------------------------------------------------
console.log('\n# Injected runtime shim');
const runtimeSrc = w.proxyRuntime.toString();
const cookieBacking = { value: '' };

function FakeDocument() {}
Object.defineProperty(FakeDocument.prototype, 'cookie', {
  configurable: true,
  enumerable: true,
  get() { return cookieBacking.value; },
  set(v) { cookieBacking.value = v; },
});

function FakeElement() { this.attrs = {}; }
FakeElement.prototype.setAttribute = function (name, value) { this.attrs[name] = value; };

function FakeWebSocket(url, protocols) { this.url = url; this.protocols = protocols; }
FakeWebSocket.CONNECTING = 0; FakeWebSocket.OPEN = 1; FakeWebSocket.CLOSING = 2; FakeWebSocket.CLOSED = 3;

function FakeEventSource(url, config) { this.url = url; this.config = config; }
FakeEventSource.CONNECTING = 0; FakeEventSource.OPEN = 1; FakeEventSource.CLOSED = 2;

function FakeXHR() {}
FakeXHR.prototype.open = function (method, url) { this.url = url; };

const b = {
  URL,
  Request,
  console,
  JSON, Date, parseInt, isNaN, decodeURIComponent, encodeURIComponent,
  Array, Object, String, Number, Boolean, RegExp,
  document: new FakeDocument(),
  Document: FakeDocument,
  Element: FakeElement,
  WebSocket: FakeWebSocket,
  EventSource: FakeEventSource,
  XMLHttpRequest: FakeXHR,
  navigator: { sendBeacon() { return true; } },
  history: {
    pushState(state, title, url) { this._url = url; },
    replaceState(state, title, url) { this._url = url; },
  },
  Location: function Location() {},
  fetch(url) { this._fetchUrl = url; return Promise.resolve(); },
};
b.window = b;
b.Location.prototype.assign = function (url) { b.location.href = url; };
b.Location.prototype.replace = function (url) { b.location.href = url; };
b.location = new b.Location();
b.location.protocol = 'https:';
b.location.host = 'w.dev';
b.location.href = `${WORKER}/https://example.com/apps`;

vm.createContext(b);
vm.runInContext(`(${runtimeSrc})(${JSON.stringify(WORKER)}, "https://example.com/apps")`, b);

b.fetch('/api/x');
eq('fetch root-relative', b._fetchUrl, `${WORKER}/https://example.com/api/x`);
b.fetch('https://other.com/y');
eq('fetch absolute', b._fetchUrl, `${WORKER}/https://other.com/y`);
b.fetch('data:text/plain,x');
eq('fetch data: untouched', b._fetchUrl, 'data:text/plain,x');
b.fetch(`${WORKER}/https://example.com/already`);
eq('fetch no double-proxy', b._fetchUrl, `${WORKER}/https://example.com/already`);

const xhr = new FakeXHR();
xhr.open('GET', '/rpc');
eq('XHR rewritten', xhr.url, `${WORKER}/https://example.com/rpc`);

b.history.pushState({}, '', '/spa/route');
eq('pushState prefixed', b.history._url, `${WORKER}/https://example.com/spa/route`);
b.fetch('rel');
eq('relative after pushState', b._fetchUrl, `${WORKER}/https://example.com/spa/rel`);

b.location.assign('/logout');
eq('location.assign proxied', b.location.href, `${WORKER}/https://example.com/logout`);

const el = new FakeElement();
el.setAttribute('src', '/img/a.png');
eq('setAttribute src proxied', el.attrs.src, `${WORKER}/https://example.com/img/a.png`);
el.setAttribute('href', '#anchor');
eq('setAttribute fragment untouched', el.attrs.href, '#anchor');
el.setAttribute('class', 'x');
eq('setAttribute non-url untouched', el.attrs.class, 'x');

b.document.cookie = 'token=xyz; Path=/';
eq('document.cookie read-back', b.document.cookie, 'token=xyz');
ok('cookie stored in __pjs', cookieBacking.value.indexOf('__pjs=') === 0);
b.document.cookie = 'token=; Max-Age=0';
eq('document.cookie deletion', b.document.cookie, '');

const ws = new b.WebSocket('wss://example.com/socket');
eq('WebSocket rewritten', ws.url, `wss://w.dev/https://example.com/socket`);
eq('WebSocket constants kept', b.WebSocket.OPEN, 1);
const es = new b.EventSource('/events');
eq('EventSource rewritten', es.url, `${WORKER}/https://example.com/events`);

// ---------------------------------------------------------------------------
(async () => {
  console.log('\n# WebSocket proxy (worker)');

  function fakeSocket() {
    return {
      accepted: false,
      sent: [],
      accept() { this.accepted = true; },
      send(data) { this.sent.push(data); },
      close() {},
      addEventListener() {},
    };
  }

  class FakePair {
    constructor() {
      this[0] = fakeSocket();
      this[1] = fakeSocket();
    }
  }

  class FakeResponse {
    constructor(body, init) {
      this.body = body;
      this.status = init && init.status;
      this.webSocket = init && init.webSocket;
      this.headers = new Headers((init && init.headers) || {});
    }
  }

  let captured = null;
  const upstreamSocket = fakeSocket();
  const wsW = loadWorker({
    Response: FakeResponse,
    WebSocketPair: FakePair,
    fetch(url, init) {
      captured = { url, init };
      return Promise.resolve({ webSocket: upstreamSocket });
    },
  });

  const incoming = new Headers({
    cookie: '__p_jar=x',
    origin: 'https://example.com',
    referer: 'https://example.com/',
    'user-agent': 'UA',
    'sec-websocket-key': 'CLIENT-KEY',
    'sec-websocket-version': '13',
    'sec-websocket-protocol': 'chat',
    upgrade: 'websocket',
    connection: 'Upgrade',
  });

  const res = await wsW.handleWebSocket(new URL('https://example.com/socket'), incoming);

  eq('WS fetches target', captured.url, 'https://example.com/socket');
  eq('WS sends Upgrade', captured.init.headers.get('upgrade'), 'websocket');
  eq('WS strips client key', captured.init.headers.get('sec-websocket-key'), null);
  eq('WS strips client version', captured.init.headers.get('sec-websocket-version'), null);
  eq('WS forwards cookie', captured.init.headers.get('cookie'), '__p_jar=x');
  eq('WS forwards origin', captured.init.headers.get('origin'), 'https://example.com');
  eq('WS forwards subprotocol', captured.init.headers.get('sec-websocket-protocol'), 'chat');
  ok('WS accepts upstream', upstreamSocket.accepted === true);
  eq('WS returns 101', res.status, 101);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
