/** Clock tiêm được (B1.1) để test thời gian xác định. */
export class SystemClock {
  now() { return new Date(); }
  iso() { return this.now().toISOString(); }
  ms() { return this.now().getTime(); }
}
export class FakeClock {
  constructor(start = '2026-01-01T00:00:00.000Z') { this.t = new Date(start).getTime(); }
  now() { return new Date(this.t); }
  iso() { return this.now().toISOString(); }
  ms() { return this.t; }
  advance(ms) { this.t += ms; return this; }
  set(iso) { this.t = new Date(iso).getTime(); return this; }
}
