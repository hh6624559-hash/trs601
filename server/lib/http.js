import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { extname, join, normalize, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { AppError, err } from './errors.js';
import { parse } from './validate.js';
import { uuidv7 } from './ids.js';
import { sha256hex, safeEqual, randomToken, hmacHex } from './crypto.js';
import { can, ageBand } from './policy.js';
import { MATRIX } from './policy.matrix.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2' };
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.webmanifest', '.txt']);

export const SESSION_COOKIE = (cfg) => (cfg.cookieSecure ? '__Host-trs_sid' : 'trs_sid');

export function createRouter() {
  const routes = [];
  const add = (method) => (path, def, handler) => {
    const keys = [];
    const re = new RegExp('^/api/v1' + path.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, path, re, keys, def: { auth: 'session', ...def }, handler });
  };
  return { routes, get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE') };
}

export function createApp(deps) {
  const { config, db, clock, log, limiter, audit } = deps;
  const router = createRouter();
  const PUBLIC_DIR = deps.publicDir;
  const staticCache = new Map();

  const securityHeaders = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    // CSP không cần nonce vì frontend không có script/style inline (không unsafe-inline).
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    ...(config.prod ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
  };

  const clientIp = (req) => {
    if (config.trustProxy) {
      const xff = req.headers['x-forwarded-for'];
      if (xff) { const parts = String(xff).split(',').map((x) => x.trim()).filter(Boolean); if (parts.length) return parts[parts.length - 1]; }
    }
    return req.socket.remoteAddress || '0.0.0.0';
  };
  const ipHash = (ip) => hmacHex(config.secret, ip).slice(0, 24);

  function parseCookies(h = '') {
    const out = {};
    for (const part of h.split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
    return out;
  }
  function cookieStr(name, value, { maxAge, expires } = {}) {
    let c = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`;
    if (config.cookieSecure) c += '; Secure';
    if (maxAge !== undefined) c += `; Max-Age=${maxAge}`;
    if (expires) c += `; Expires=${expires.toUTCString()}`;
    return c;
  }

  function originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true; // client không phải trình duyệt; CSRF token vẫn bắt buộc với route có phiên
    // Cho phép: đúng PUBLIC_ORIGIN đã khai báo, hoặc cùng máy chủ (Origin.host == Host) – vẫn là same-origin nên không mở thêm CSRF.
    if (config.publicOrigins.includes(origin.toLowerCase())) return true;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  }

  async function readBody(req) {
    const chunks = []; let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > config.maxBodyBytes) throw err('PAYLOAD_TOO_LARGE');
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }

  // ---- phiên ----
  function loadSession(req) {
    const tok = parseCookies(req.headers.cookie)[SESSION_COOKIE(config)];
    if (!tok) return null;
    const id = sha256hex(tok);
    const s = db.get('SELECT * FROM sessions WHERE id=? AND revoked_at IS NULL', id);
    if (!s) return null;
    const now = clock.ms();
    if (Date.parse(s.expires_at) <= now) return { expired: true, row: s };
    if (s.idle_timeout_sec && now - Date.parse(s.last_seen_at) > s.idle_timeout_sec * 1000) return { expired: true, row: s };
    if (now - Date.parse(s.last_seen_at) > 60000) db.run('UPDATE sessions SET last_seen_at=? WHERE id=?', clock.iso(), id);
    return { row: s };
  }

  function buildActor(user, session) {
    const rows = db.all("SELECT role FROM memberships WHERE user_id=? AND tenant_id=? AND status='active'", user.id, session.tenant_id);
    const roles = new Set(rows.map((r) => r.role));
    if (roles.has('owner')) roles.add('admin');
    const tv = db.get('SELECT state FROM teacher_verifications WHERE user_id=?', user.id);
    const teacherApproved = tv?.state === 'APPROVED';
    if (roles.has('teacher') && tv && !teacherApproved) roles.add('teacher_pending');
    if (user.platform_role === 'admin') roles.add('platform_admin');
    return {
      id: user.id, tenantId: session.tenant_id, roles: [...roles], ageBand: ageBand(user.birth_ym, clock.now()),
      mfaPassed: !!session.mfa_passed, stepUp: !!session.stepup_until && Date.parse(session.stepup_until) > clock.ms(), teacherApproved,
    };
  }

  function relations(actor, resource) {
    const rel = { teacherOf: false, guardianOf: false, classMember: false };
    if (resource.classId) {
      rel.teacherOf = !!db.get("SELECT 1 FROM classes WHERE id=? AND teacher_id=? AND tenant_id=? AND status='active'", resource.classId, actor.id, actor.tenantId);
      rel.classMember = !!db.get("SELECT 1 FROM class_members WHERE class_id=? AND user_id=? AND status='active'", resource.classId, actor.id);
    }
    if (resource.ownerId && resource.ownerId !== actor.id) {
      if (!rel.teacherOf) rel.teacherOf = !!db.get("SELECT 1 FROM classes c JOIN class_members m ON m.class_id=c.id WHERE c.teacher_id=? AND c.tenant_id=? AND m.user_id=? AND m.status='active' AND c.status='active'", actor.id, actor.tenantId, resource.ownerId);
      rel.guardianOf = !!db.get("SELECT 1 FROM guardian_links WHERE guardian_id=? AND learner_id=? AND tenant_id=? AND status='active'", actor.id, resource.ownerId, actor.tenantId);
    }
    return rel;
  }

  function grantedConsents(actor) {
    return new Set(db.all("SELECT purpose FROM consents WHERE subject_id=? AND tenant_id=? AND state='GRANTED' AND (expires_at IS NULL OR expires_at>?)", actor.id, actor.tenantId, clock.iso()).map((r) => r.purpose));
  }

  /** Thực thi can(); không lộ sự tồn tại: tài nguyên ngoài phạm vi → NOT_FOUND. */
  function authorize(actor, action, resource = {}, extra = {}) {
    const ctx = { rel: relations(actor, resource), consents: grantedConsents(actor), ...extra };
    const d = can(actor, action, resource, ctx);
    if (d.allowed) return d;
    if (d.code === 'TENANT_MISMATCH' || (d.reason === 'relation' && resource.hideExistence)) throw err('NOT_FOUND');
    if (d.code === 'UNAUTHENTICATED') throw err('UNAUTHENTICATED');
    throw err(d.code, { details: [{ reason: d.reason }] });
  }

  // ---- idempotency ----
  function idemBegin(ctx, route) {
    const key = ctx.headers['idempotency-key'];
    if (!key || key.length > 128 || !/^[A-Za-z0-9_\-:.]+$/.test(key)) throw err('PRECONDITION_REQUIRED', { messageKey: 'error.IDEMPOTENCY_KEY_REQUIRED' });
    const fp = createHash('sha256').update(`${ctx.method} ${ctx.path}\n${canonical(ctx.rawBody)}`).digest('hex');
    const tenant = ctx.actor?.tenantId || '-', principal = ctx.user?.id || '-', op = `${ctx.method} ${route.path}`;
    const row = db.get('SELECT * FROM idempotency_records WHERE tenant_id=? AND principal_id=? AND operation=? AND key=?', tenant, principal, op, key);
    if (row) {
      if (row.fingerprint !== fp) throw err('IDEMPOTENCY_KEY_REUSED');
      if (row.state === 'IN_PROGRESS') throw err('REQUEST_IN_PROGRESS', { retryAfter: 1 });
      return { replay: { status: row.response_status, body: row.response_body } };
    }
    const exp = new Date(clock.ms() + config.idempotencyTtlHours * 3600e3).toISOString();
    db.run("INSERT INTO idempotency_records(tenant_id,principal_id,operation,key,fingerprint,state,expires_at) VALUES(?,?,?,?,?,'IN_PROGRESS',?)", tenant, principal, op, key, fp, exp);
    return { tenant, principal, op, key };
  }
  const idemEnd = (h, status, body, ok) => db.run('UPDATE idempotency_records SET state=?, response_status=?, response_body=? WHERE tenant_id=? AND principal_id=? AND operation=? AND key=?', ok ? 'COMPLETED' : 'FAILED', status, body, h.tenant, h.principal, h.op, h.key);
  const idemAbort = (h) => db.run('DELETE FROM idempotency_records WHERE tenant_id=? AND principal_id=? AND operation=? AND key=?', h.tenant, h.principal, h.op, h.key);
  function canonical(v) {
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
    return JSON.stringify(v ?? null);
  }

  function send(res, status, payload, headers = {}) {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body), ...securityHeaders, ...(status === 413 ? { Connection: 'close' } : {}), ...headers });
    res.end(body);
  }
  const envelopeOk = (data, requestId) => ({ success: true, data, meta: { requestId, timestamp: clock.iso() } });
  const envelopeErr = (e, requestId) => ({ success: false, error: { code: e.code, messageKey: e.messageKey, params: e.params, details: e.details, retryable: e.retryable }, requestId });

  async function handleApi(req, res, url) {
    const started = process.hrtime.bigint();
    const requestId = (req.headers['x-request-id'] && /^[\w-]{8,64}$/.test(req.headers['x-request-id']) ? req.headers['x-request-id'] : uuidv7());
    const method = req.method;
    let route, status = 500, userId;
    const setCookies = [];
    try {
      const path = url.pathname;
      let params = {};
      for (const r of router.routes) {
        if (r.method !== method) continue;
        const m = r.re.exec(path);
        if (m) { route = r; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); break; }
      }
      if (!route) {
        const other = router.routes.some((r) => r.re.test(path));
        throw other ? err('MALFORMED_REQUEST', { messageKey: 'error.METHOD_NOT_ALLOWED' }) : err('NOT_FOUND');
      }
      const def = route.def;
      const mutating = method !== 'GET';
      const ip = clientIp(req);
      const ctx = { req, res, method, path, params, headers: req.headers, ip, requestId, db, config, clock, log, deps, now: clock.now(), query: {}, body: undefined, rawBody: undefined, cookies: setCookies, user: null, session: null, actor: null };

      // 1. giới hạn IP chung (fail-closed cho route nhạy cảm, fail-open cho đọc)
      const generalIp = method === 'GET' ? [`ip:${ipHash(ip)}:g`, 600, 60] : [`ip:${ipHash(ip)}:m`, 240, 60];
      try {
        const lim = limiter.hit(...generalIp);
        if (!lim.allowed) throw err('RATE_LIMITED', { retryAfter: lim.retryAfter });
      } catch (e) { if (e instanceof AppError) throw e; if (mutating) throw err('DEPENDENCY_UNAVAILABLE'); log.warn('limiter_failed_open', { route: route.path }); }

      // 2. origin (CSRF lớp 1)
      if (mutating && !originAllowed(req)) throw err('FORBIDDEN', { messageKey: 'error.BAD_ORIGIN' });

      // 3. phiên
      if (def.auth === 'session') {
        const ses = loadSession(req);
        if (!ses) throw err('UNAUTHENTICATED');
        if (ses.expired) throw err('SESSION_EXPIRED');
        const user = db.get('SELECT * FROM users WHERE id=?', ses.row.user_id);
        if (!user || user.status !== 'active') throw err('UNAUTHENTICATED');
        ctx.session = ses.row; ctx.user = user; userId = user.id;
        ctx.actor = buildActor(user, ses.row);
        if (mutating && !def.noCsrf && !safeEqual(req.headers['x-csrf-token'] || '', ses.row.csrf)) throw err('FORBIDDEN', { messageKey: 'error.BAD_CSRF' });
        // giới hạn API chung theo người dùng
        try {
          const lim = limiter.hit(`u:${user.id}:api`, 120, 60, def.cost || 1);
          if (!lim.allowed) throw err('RATE_LIMITED', { retryAfter: lim.retryAfter });
        } catch (e) { if (e instanceof AppError) throw e; if (mutating) throw err('DEPENDENCY_UNAVAILABLE'); }
      }

      // 4. query + body
      if (def.query) {
        const q = Object.fromEntries(url.searchParams.entries());
        const p = parse(def.query, q);
        if (!p.ok) throw err('VALIDATION_ERROR', { details: p.errors });
        ctx.query = p.value;
      }
      if (mutating) {
        const raw = await readBody(req);
        if (raw.length) {
          if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw err('UNSUPPORTED_MEDIA_TYPE');
          try { ctx.rawBody = JSON.parse(raw.toString('utf8')); } catch { throw err('MALFORMED_REQUEST'); }
        } else ctx.rawBody = def.body ? undefined : {};
        if (def.body) {
          const p = parse(def.body, ctx.rawBody === undefined ? {} : ctx.rawBody);
          if (!p.ok) throw err('VALIDATION_ERROR', { details: p.errors });
          ctx.body = p.value;
        } else ctx.body = ctx.rawBody;
        if (def.rawBodyBuffer) ctx.rawBuffer = raw;
      }

      // 5. rate limit riêng của route
      for (const r of def.rate || []) {
        const who = r.by === 'ip' ? `ip:${ipHash(ip)}` : r.by === 'user' ? `u:${userId}` : `k:${r.by(ctx)}`;
        let lim;
        try { lim = limiter.hit(`${r.name}:${who}`, r.limit, r.windowSec, r.cost || 1); } catch { if (r.failOpen) continue; throw err('DEPENDENCY_UNAVAILABLE'); }
        if (!lim.allowed) throw err('RATE_LIMITED', { retryAfter: lim.retryAfter, params: { retryAfter: lim.retryAfter } });
      }

      // 6. policy (action + resource) – ĐẶT TRƯỚC handler, một nơi duy nhất
      if (def.action) {
        if (!MATRIX[def.action]) throw new Error(`route ${route.path} dùng action không có trong ma trận: ${def.action}`);
        ctx.resource = def.resource ? def.resource(ctx) : {};
        authorize(ctx.actor, def.action, ctx.resource || {});
      } else if (def.auth === 'session' && !def.selfOnly) {
        throw new Error(`route ${method} ${route.path} thiếu action (hoặc selfOnly)`);
      }
      ctx.authorize = (action, resource, extra) => authorize(ctx.actor, action, resource, extra);

      // 7. idempotency
      let idem;
      if (def.idem) {
        idem = idemBegin(ctx, route);
        if (idem.replay) {
          status = idem.replay.status;
          res.setHeader('Idempotent-Replay', 'true');
          send(res, status, JSON.parse(idem.replay.body), { 'X-Request-Id': requestId, 'Idempotent-Replay': 'true' });
          return;
        }
      }

      let out;
      try {
        out = await route.handler(ctx);
      } catch (e) {
        if (idem) { if (e instanceof AppError && e.status < 500) idemEnd(idem, e.status, JSON.stringify(envelopeErr(e, requestId)), false); else idemAbort(idem); }
        throw e;
      }
      const result = out && out.__raw ? out : { status: 200, data: out };
      status = result.status || 200;
      const payload = envelopeOk(result.data === undefined ? null : result.data, requestId);
      if (idem) idemEnd(idem, status, JSON.stringify(payload), true);
      const extraHeaders = { 'X-Request-Id': requestId, ...(result.headers || {}) };
      if (setCookies.length) extraHeaders['Set-Cookie'] = setCookies;
      send(res, status, payload, extraHeaders);
    } catch (e) {
      let ae = e;
      if (!(e instanceof AppError)) {
        log.error('unhandled', { requestId, route: route?.path, error: e.message, stack: config.prod ? undefined : e.stack });
        ae = err('INTERNAL_ERROR');
      }
      status = ae.status;
      const h = { 'X-Request-Id': requestId };
      if (ae.retryAfter) h['Retry-After'] = String(ae.retryAfter);
      if (setCookies.length) h['Set-Cookie'] = setCookies;
      try { send(res, ae.status, envelopeErr(ae, requestId), h); } catch { /* socket đã đóng */ }
    } finally {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      log.info('req', { requestId, method, route: route?.path || url.pathname, status, ms: Math.round(ms), userId });
    }
  }

  async function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    if (rel.includes('\0')) { res.writeHead(400); return res.end(); }
    let file = normalize(join(PUBLIC_DIR, rel));
    if (!(file === PUBLIC_DIR || file.startsWith(PUBLIC_DIR + sep))) { res.writeHead(403, securityHeaders); return res.end(); }
    let st = await stat(file).catch(() => null);
    if (st?.isDirectory()) { file = join(file, 'index.html'); st = await stat(file).catch(() => null); }
    const wantsFile = extname(url.pathname) !== '';
    if (!st) {
      if (wantsFile) { res.writeHead(404, { 'Content-Type': 'text/plain', ...securityHeaders }); return res.end('Not found'); }
      file = join(PUBLIC_DIR, 'index.html'); st = await stat(file).catch(() => null); // SPA fallback
      if (!st) { res.writeHead(404, securityHeaders); return res.end('Not found'); }
    }
    const ext = extname(file);
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const noCache = ext === '.html' || file.endsWith('sw.js');
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', ETag: etag, 'Cache-Control': noCache ? 'no-cache' : 'public, max-age=300', ...securityHeaders };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    let buf = staticCache.get(file);
    if (!buf || buf.etag !== etag) {
      const raw = await readFile(file);
      buf = { etag, raw, gz: COMPRESSIBLE.has(ext) && raw.length > 512 ? gzipSync(raw) : null };
      staticCache.set(file, buf);
    }
    const useGz = buf.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    if (useGz) { headers['Content-Encoding'] = 'gzip'; headers.Vary = 'Accept-Encoding'; }
    const body = useGz ? buf.gz : buf.raw;
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  let draining = false;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...securityHeaders }); return res.end('{"status":"ok"}'); }
      if (url.pathname === '/readyz') {
        let ok = false; try { ok = !draining && db.ready(); } catch { ok = false; }
        res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...securityHeaders }); return res.end(JSON.stringify({ status: ok ? 'ready' : 'unavailable' }));
      }
      if (url.pathname.startsWith('/api/')) {
        if (!url.pathname.startsWith('/api/v1/') && url.pathname !== '/api/v1') {
          return send(res, 404, envelopeErr(err('NOT_FOUND'), 'n/a'));
        }
        return await handleApi(req, res, url);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, securityHeaders); return res.end(); }
      return await serveStatic(req, res, url);
    } catch (e) {
      log.error('server_error', { error: e.message });
      try { res.writeHead(500, securityHeaders); res.end('error'); } catch { /* ignore */ }
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 15000; server.keepAliveTimeout = 5000;

  return {
    router, server, authorize, relations, buildActor, SESSION_COOKIE: SESSION_COOKIE(config),
    cookieStr, parseCookies, ipHash, clientIp, secureEq: safeEqual, randomToken,
    drain() { draining = true; },
    listen: (port = config.port, host = config.host) => new Promise((ok) => server.listen(port, host, () => ok(server.address()))),
    close: () => new Promise((ok) => { draining = true; server.close(() => ok()); server.closeIdleConnections?.(); }),
  };
}
