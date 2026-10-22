// Minimal PostgreSQL client (wire protocol v3) — zero dependencies.
// Supports: cleartext / md5 / SCRAM-SHA-256 auth, SSL upgrade, extended query protocol
// (parameters are always sent separately from SQL => no string interpolation), simple query for migrations,
// connection pool with transaction helper.
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

export class PgError extends Error {
  constructor(fields) {
    super(fields.M || 'postgres error');
    this.name = 'PgError';
    this.code = fields.C;
    this.detail = fields.D;
    this.constraint = fields.n;
    this.table = fields.t;
    this.severity = fields.S;
  }
}

const i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const i16 = (n) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const cstr = (s) => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
const msg = (type, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from(type, 'latin1'), i32(body.length + 4), body]);
};

export function parseDatabaseUrl(url) {
  const u = new URL(url);
  const sslmode = u.searchParams.get('sslmode') || process.env.PGSSLMODE || 'prefer';
  return {
    host: u.hostname || 'localhost',
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, '')),
    sslmode,
  };
}

// ---- type parsing (text format) ----
function parseTs(s) {
  // "2026-10-09 15:37:52.123456+00" -> Date
  const m = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(\.\d+)?([+-]\d\d)(?::?(\d\d))?$/.exec(s);
  if (!m) return new Date(s);
  const frac = m[3] ? m[3].slice(0, 4) : '';
  return new Date(`${m[1]}T${m[2]}${frac}${m[4]}:${m[5] || '00'}`);
}
function parseArray(s, conv) {
  // 1-dimensional arrays only
  if (s === '{}') return [];
  const out = [];
  let i = 1;
  while (i < s.length - 1) {
    if (s[i] === '"') {
      let v = ''; i++;
      while (s[i] !== '"') { if (s[i] === '\\') i++; v += s[i++]; }
      i++; out.push(conv(v));
    } else {
      let j = i;
      while (j < s.length - 1 && s[j] !== ',') j++;
      const v = s.slice(i, j); out.push(v === 'NULL' ? null : conv(v)); i = j;
    }
    if (s[i] === ',') i++;
  }
  return out;
}
const idc = (x) => x;
const PARSERS = {
  16: (s) => s === 't',
  20: (s) => { const n = Number(s); return Number.isSafeInteger(n) ? n : s; },
  21: Number, 23: Number, 26: Number, 700: Number, 701: Number, 1700: Number,
  114: JSON.parse, 3802: JSON.parse,
  1114: (s) => parseTs(s + '+00'), 1184: parseTs,
  17: (s) => Buffer.from(s.slice(2), 'hex'),
  1009: (s) => parseArray(s, idc), 1015: (s) => parseArray(s, idc), 2951: (s) => parseArray(s, idc),
  1007: (s) => parseArray(s, Number), 1016: (s) => parseArray(s, Number),
  1000: (s) => parseArray(s, (x) => x === 't'),
};

function encodeParam(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return Buffer.from(v, 'utf8');
  if (typeof v === 'number' || typeof v === 'bigint') return Buffer.from(String(v));
  if (typeof v === 'boolean') return Buffer.from(v ? 't' : 'f');
  if (v instanceof Date) return Buffer.from(v.toISOString());
  if (Buffer.isBuffer(v)) return Buffer.from('\\x' + v.toString('hex'));
  if (Array.isArray(v)) {
    // PG array literal (elements: strings/numbers/null). For jsonb pass JSON.stringify(...) yourself.
    const el = (x) => x === null ? 'NULL' : '"' + String(x).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    return Buffer.from('{' + v.map(el).join(',') + '}');
  }
  return Buffer.from(JSON.stringify(v));
}
/** Wrap a value so it is sent as JSON text (use for jsonb parameters that are arrays). */
export const json = (v) => ({ toJSON() { return v; }, __json: true, v });

export class Client {
  constructor(cfg) {
    this.cfg = cfg;
    this.buf = Buffer.alloc(0);
    this.waiter = null;
    this.queue = [];
    this.dead = false;
    this.busy = false;
  }

  async connect() {
    const { host, port, sslmode } = this.cfg;
    let socket = await new Promise((res, rej) => {
      const s = net.connect({ host, port }, () => res(s));
      s.once('error', rej);
    });
    if (sslmode !== 'disable' && sslmode !== 'prefer-off') {
      socket.write(Buffer.concat([i32(8), i32(80877103)]));
      const ans = await new Promise((res) => socket.once('data', res));
      if (ans[0] === 0x53) { // 'S'
        const verify = sslmode === 'verify-full' || sslmode === 'verify-ca';
        socket = await new Promise((res, rej) => {
          const t = tls.connect({ socket, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: verify }, () => res(t));
          t.once('error', rej);
        });
      } else if (['require', 'verify-ca', 'verify-full'].includes(sslmode)) {
        socket.destroy();
        throw new Error('server does not support SSL but sslmode=' + sslmode);
      }
    }
    this.socket = socket;
    socket.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this._pump(); });
    socket.on('error', (e) => this._fail(e));
    socket.on('close', () => this._fail(new Error('connection closed')));
    const { user, database } = this.cfg;
    const params = Buffer.concat([cstr('user'), cstr(user), cstr('database'), cstr(database),
      cstr('client_encoding'), cstr('UTF8'), cstr('TimeZone'), cstr('UTC'), cstr('application_name'), cstr('trs6'), Buffer.from([0])]);
    socket.write(Buffer.concat([i32(params.length + 8), i32(196608), params]));
    await this._authenticate();
  }

  _fail(e) {
    if (this.dead) return;
    this.dead = true;
    if (this.waiter) { const w = this.waiter; this.waiter = null; w.reject(e); }
    try { this.socket.destroy(); } catch { /* noop */ }
  }

  _pump() {
    while (this.buf.length >= 5) {
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < 1 + len) return;
      const type = String.fromCharCode(this.buf[0]);
      const body = this.buf.subarray(5, 1 + len);
      this.buf = this.buf.subarray(1 + len);
      this.queue.push({ type, body });
    }
    this._wake();
  }
  _wake() {
    if (this.waiter && this.queue.length) { const w = this.waiter; this.waiter = null; w.resolve(this.queue.shift()); }
  }
  _next() {
    if (this.dead) return Promise.reject(new Error('connection closed'));
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; });
  }

  async _authenticate() {
    let scram = null;
    for (;;) {
      const m = await this._next();
      if (m.type === 'E') throw new PgError(parseFields(m.body));
      if (m.type === 'R') {
        const code = m.body.readInt32BE(0);
        if (code === 0) continue;
        if (code === 3) this.socket.write(msg('p', cstr(this.cfg.password)));
        else if (code === 5) {
          const salt = m.body.subarray(4, 8);
          const md5 = (x) => crypto.createHash('md5').update(x).digest('hex');
          const h = 'md5' + md5(Buffer.concat([Buffer.from(md5(this.cfg.password + this.cfg.user)), salt]));
          this.socket.write(msg('p', cstr(h)));
        } else if (code === 10) {
          const nonce = crypto.randomBytes(18).toString('base64');
          const first = `n=*,r=${nonce}`;
          scram = { nonce, first };
          const data = Buffer.from('n,,' + first);
          this.socket.write(msg('p', cstr('SCRAM-SHA-256'), i32(data.length), data));
        } else if (code === 11) {
          const sf = m.body.subarray(4).toString();
          const kv = Object.fromEntries(sf.split(',').map((p) => [p[0], p.slice(2)]));
          if (!kv.r.startsWith(scram.nonce)) throw new Error('SCRAM nonce mismatch');
          const salted = crypto.pbkdf2Sync(this.cfg.password, Buffer.from(kv.s, 'base64'), Number(kv.i), 32, 'sha256');
          const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
          const clientKey = hmac(salted, 'Client Key');
          const storedKey = crypto.createHash('sha256').update(clientKey).digest();
          const finalNoProof = `c=biws,r=${kv.r}`;
          const authMsg = `${scram.first},${sf},${finalNoProof}`;
          const sig = hmac(storedKey, authMsg);
          const proof = Buffer.from(clientKey.map((b, i) => b ^ sig[i])).toString('base64');
          scram.serverSig = hmac(hmac(salted, 'Server Key'), authMsg).toString('base64');
          this.socket.write(msg('p', Buffer.from(`${finalNoProof},p=${proof}`)));
        } else if (code === 12) {
          const v = m.body.subarray(4).toString().replace(/^v=/, '');
          if (v !== scram.serverSig) throw new Error('SCRAM server signature mismatch');
        } else throw new Error('unsupported auth method ' + code);
      } else if (m.type === 'Z') { return; }
      // S (ParameterStatus), K (BackendKeyData), N (Notice): ignore
    }
  }

  /** Extended protocol, single statement with parameters. */
  async query(sql, params = []) {
    if (this.busy) throw new Error('client busy');
    this.busy = true;
    try {
      const enc = params.map((p) => (p && p.__json) ? Buffer.from(JSON.stringify(p.v)) : encodeParam(p));
      const bind = Buffer.concat([cstr(''), cstr(''), i16(0), i16(enc.length),
        ...enc.map((e) => (e === null ? i32(-1) : Buffer.concat([i32(e.length), e]))), i16(0)]);
      this.socket.write(Buffer.concat([
        msg('P', cstr(''), cstr(sql), i16(0)),
        msg('B', bind),
        msg('D', Buffer.from('P'), cstr('')),
        msg('E', cstr(''), i32(0)),
        msg('S'),
      ]));
      return await this._collect();
    } finally { this.busy = false; }
  }

  /** Simple query protocol (multi-statement, no parameters) — used for migrations only. */
  async exec(sql) {
    if (this.busy) throw new Error('client busy');
    this.busy = true;
    try { this.socket.write(msg('Q', cstr(sql))); return await this._collect(); } finally { this.busy = false; }
  }

  async _collect() {
    let fields = null; let rows = []; let err = null; let rowCount = 0; let tag = '';
    for (;;) {
      const m = await this._next();
      if (m.type === 'T') fields = parseRowDesc(m.body);
      else if (m.type === 'D') rows.push(parseDataRow(m.body, fields));
      else if (m.type === 'C') { tag = m.body.toString('utf8', 0, m.body.length - 1); rowCount = Number(tag.split(' ').pop()) || 0; }
      else if (m.type === 'E') err = new PgError(parseFields(m.body));
      else if (m.type === 'Z') {
        this.txStatus = String.fromCharCode(m.body[0]);
        if (err) throw err;
        return { rows, rowCount, tag };
      }
    }
  }

  close() { try { this.socket.write(msg('X')); this.socket.end(); } catch { /* noop */ } this.dead = true; }
}

function parseFields(b) {
  const f = {}; let i = 0;
  while (i < b.length && b[i] !== 0) {
    const k = String.fromCharCode(b[i++]); let e = b.indexOf(0, i);
    f[k] = b.toString('utf8', i, e); i = e + 1;
  }
  return f;
}
function parseRowDesc(b) {
  const n = b.readInt16BE(0); let i = 2; const out = [];
  for (let k = 0; k < n; k++) {
    const e = b.indexOf(0, i); const name = b.toString('utf8', i, e); i = e + 1;
    const oid = b.readInt32BE(i + 6); i += 18; out.push({ name, oid });
  }
  return out;
}
function parseDataRow(b, fields) {
  const n = b.readInt16BE(0); let i = 2; const row = {};
  for (let k = 0; k < n; k++) {
    const len = b.readInt32BE(i); i += 4;
    if (len === -1) row[fields[k].name] = null;
    else {
      const s = b.toString('utf8', i, i + len); i += len;
      const p = PARSERS[fields[k].oid]; row[fields[k].name] = p ? p(s) : s;
    }
  }
  return row;
}

export class Pool {
  constructor(cfg, { max = 10 } = {}) {
    this.cfg = cfg; this.max = max; this.idle = []; this.total = 0; this.waiters = [];
  }
  async _acquire() {
    for (;;) {
      const c = this.idle.pop();
      if (c) { if (c.dead) { this.total--; continue; } return c; }
      if (this.total < this.max) {
        this.total++;
        try { const c2 = new Client(this.cfg); await c2.connect(); return c2; } catch (e) { this.total--; throw e; }
      }
      await new Promise((r) => this.waiters.push(r));
    }
  }
  _release(c) {
    if (c.dead || c.txStatus !== 'I') { if (!c.dead) c.close(); this.total--; } else this.idle.push(c);
    const w = this.waiters.shift(); if (w) w();
  }
  async query(sql, params) {
    const c = await this._acquire();
    try { return await c.query(sql, params); } finally { this._release(c); }
  }
  /** Run fn(q) inside a transaction. q(sql, params) -> {rows,rowCount}. */
  async tx(fn, { tenantId = null, system = false, isolation = null, retries = 3 } = {}) {
    for (let attempt = 0; ; attempt++) {
      const c = await this._acquire();
      try {
        await c.query('BEGIN' + (isolation ? ` ISOLATION LEVEL ${isolation}` : ''));
        if (tenantId) await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
        if (system) await c.query("SELECT set_config('app.system', 'on', true)");
        const q = (sql, params) => c.query(sql, params);
        const out = await fn(q);
        await c.query('COMMIT');
        return out;
      } catch (e) {
        try { if (!c.dead) await c.query('ROLLBACK'); } catch { c.dead = true; }
        if (e instanceof PgError && (e.code === '40001' || e.code === '40P01') && attempt < retries) {
          await new Promise((r) => setTimeout(r, 20 * (attempt + 1) + Math.random() * 30));
          continue;
        }
        throw e;
      } finally { this._release(c); }
    }
  }
  async close() { for (const c of this.idle) c.close(); this.idle = []; }
}
