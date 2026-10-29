/**
 * Schema runtime tối giản (kiểu Zod-lite, không phụ thuộc ngoài).
 * Mutation: từ chối trường lạ (strict). Trả { ok, value } | { ok:false, errors:[{path,code}] }.
 */
import { UUID_RE } from './ids.js';

const wrap = (check) => ({ _check: check, optional() { return { ...this, _optional: true }; }, nullable() { return { ...this, _nullable: true }; }, default(v) { return { ...this, _optional: true, _default: v }; } });

export const s = {
  string({ min = 0, max = 10000, trim = true, pattern } = {}) {
    return wrap((v, path, errs) => {
      if (typeof v !== 'string') return errs.push({ path, code: 'type.string' });
      const x = trim ? v.trim() : v;
      if (x.length < min) return errs.push({ path, code: 'string.min', params: { min } });
      if (x.length > max) return errs.push({ path, code: 'string.max', params: { max } });
      if (pattern && !pattern.test(x)) return errs.push({ path, code: 'string.pattern' });
      return x;
    });
  },
  email() {
    return wrap((v, path, errs) => {
      if (typeof v !== 'string') return errs.push({ path, code: 'type.string' });
      const x = v.trim().toLowerCase();
      if (x.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)) return errs.push({ path, code: 'string.email' });
      return x;
    });
  },
  uuid() {
    return wrap((v, path, errs) => (typeof v === 'string' && UUID_RE.test(v) ? v.toLowerCase() : errs.push({ path, code: 'string.uuid' })));
  },
  int({ min = -2147483648, max = 2147483647 } = {}) {
    return wrap((v, path, errs) => {
      if (typeof v !== 'number' || !Number.isInteger(v)) return errs.push({ path, code: 'type.int' });
      if (v < min || v > max) return errs.push({ path, code: 'number.range', params: { min, max } });
      return v;
    });
  },
  number({ min = -1e12, max = 1e12 } = {}) {
    return wrap((v, path, errs) => {
      if (typeof v !== 'number' || !Number.isFinite(v)) return errs.push({ path, code: 'type.number' });
      if (v < min || v > max) return errs.push({ path, code: 'number.range', params: { min, max } });
      return v;
    });
  },
  boolean() { return wrap((v, path, errs) => (typeof v === 'boolean' ? v : errs.push({ path, code: 'type.boolean' }))); },
  enum(values) { return wrap((v, path, errs) => (values.includes(v) ? v : errs.push({ path, code: 'enum', params: { values } }))); },
  iso() {
    return wrap((v, path, errs) => {
      if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) return errs.push({ path, code: 'string.datetime' });
      return new Date(v).toISOString();
    });
  },
  array(item, { min = 0, max = 1000 } = {}) {
    return wrap((v, path, errs) => {
      if (!Array.isArray(v)) return errs.push({ path, code: 'type.array' });
      if (v.length < min) return errs.push({ path, code: 'array.min', params: { min } });
      if (v.length > max) return errs.push({ path, code: 'array.max', params: { max } });
      return v.map((x, i) => run(item, x, `${path}[${i}]`, errs));
    });
  },
  object(shape, { strict = true } = {}) {
    return wrap((v, path, errs) => {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) return errs.push({ path, code: 'type.object' });
      const out = {};
      if (strict) for (const k of Object.keys(v)) if (!(k in shape)) errs.push({ path: path ? `${path}.${k}` : k, code: 'unknown_field' });
      for (const [k, sch] of Object.entries(shape)) {
        out[k] = run(sch, v[k], path ? `${path}.${k}` : k, errs);
        if (out[k] === undefined) delete out[k];
      }
      return out;
    });
  },
  any() { return wrap((v) => v); },
  /** JSON tuỳ ý nhưng giới hạn kích thước (payload có schema + version do tầng gọi kiểm). */
  json({ maxBytes = 20000 } = {}) {
    return wrap((v, path, errs) => (JSON.stringify(v ?? null).length > maxBytes ? errs.push({ path, code: 'json.too_large' }) : v));
  },
};

function run(sch, v, path, errs) {
  if (v === undefined) {
    if (sch._default !== undefined) return typeof sch._default === 'function' ? sch._default() : structuredClone(sch._default);
    if (sch._optional) return undefined;
    errs.push({ path, code: 'required' });
    return undefined;
  }
  if (v === null && sch._nullable) return null;
  return sch._check(v, path, errs);
}

export function parse(schema, data) {
  const errors = [];
  const value = run(schema, data, '', errors);
  return errors.length ? { ok: false, errors } : { ok: true, value };
}
