import { s } from '../lib/validate.js';
import { err } from '../lib/errors.js';
import { uuidv7 } from '../lib/ids.js';

/**
 * Ghi sổ cái append-only + cập nhật balance (cache) trong CÙNG transaction của người gọi.
 * UNIQUE (user_id, ref_type, ref_id, reason) chặn thưởng trùng (DI-008). Trả { applied, duplicate }.
 */
export function ledgerPost(db, clock, { tenantId, userId, delta, reason, refType, refId, reversesId = null }) {
  if (!Number.isInteger(delta) || delta === 0) throw new Error('delta phải là số nguyên khác 0');
  const id = uuidv7();
  const r = db.run('INSERT OR IGNORE INTO economy_ledger(id,tenant_id,user_id,delta,reason,ref_type,ref_id,reverses_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)', id, tenantId, userId, delta, reason, refType, refId, reversesId, clock.iso());
  if (r.changes === 0) return { applied: false, duplicate: true };
  const u = db.run('UPDATE economy_accounts SET balance = balance + ? WHERE user_id=? AND balance + ? >= 0', delta, userId, delta);
  if (u.changes !== 1) throw new Error('INSUFFICIENT_BALANCE'); // rollback toàn bộ transaction của người gọi
  return { applied: true, duplicate: false, id };
}

export const levelOf = (earned) => Math.floor(Math.sqrt(Math.max(0, earned) / 10)) + 1;

export function wallet(db, userId) {
  const acc = db.get('SELECT balance FROM economy_accounts WHERE user_id=?', userId) || { balance: 0 };
  const earned = db.get('SELECT COALESCE(SUM(delta),0) AS n FROM economy_ledger WHERE user_id=? AND delta>0', userId).n;
  return { balance: acc.balance, lifetimeEarned: earned, level: levelOf(earned), nextLevelAt: 10 * Math.pow(levelOf(earned), 2) };
}

export function register(r, d) {
  const { db, clock, audit } = d;

  r.get('/me/wallet', { action: 'economy.read' }, (ctx) => ({
    ...wallet(db, ctx.user.id),
    recent: db.all('SELECT id,delta,reason,created_at FROM economy_ledger WHERE user_id=? ORDER BY created_at DESC, id DESC LIMIT 20', ctx.user.id),
    inventory: db.all('SELECT item_id AS itemId, acquired_at AS acquiredAt FROM inventory_items WHERE user_id=?', ctx.user.id),
  }));

  r.get('/shop/items', { action: 'economy.read' }, (ctx) => ({
    items: db.all('SELECT id,kind,name_vi AS nameVi,name_en AS nameEn,price FROM shop_items WHERE active=1 ORDER BY price,id').map((i) => ({ ...i, owned: !!db.get('SELECT 1 FROM inventory_items WHERE user_id=? AND item_id=?', ctx.user.id, i.id) })),
  }));

  // Mua đồ trang trí bằng sao. Không loot box, không pay-to-win: vật phẩm chỉ là thẩm mỹ, giá cố định, kiếm bằng nỗ lực.
  r.post('/shop/purchases', {
    action: 'economy.spend', idem: true, rate: [{ name: 'purchase', by: 'user', limit: 10, windowSec: 60 }],
    body: s.object({ itemId: s.string({ min: 1, max: 40 }) }),
  }, (ctx) => {
    const item = db.get('SELECT * FROM shop_items WHERE id=? AND active=1', ctx.body.itemId);
    if (!item) throw err('NOT_FOUND');
    return db.tx(() => {
      if (db.get('SELECT 1 FROM inventory_items WHERE user_id=? AND item_id=?', ctx.user.id, item.id)) throw err('CONFLICT', { messageKey: 'error.ALREADY_OWNED' });
      const bal = db.get('SELECT balance FROM economy_accounts WHERE user_id=?', ctx.user.id);
      if (!bal || bal.balance < item.price) throw err('INSUFFICIENT_BALANCE', { params: { price: item.price, balance: bal?.balance ?? 0 } });
      if (item.price > 0) ledgerPost(db, clock, { tenantId: ctx.actor.tenantId, userId: ctx.user.id, delta: -item.price, reason: 'purchase', refType: 'shop_item', refId: item.id });
      db.run('INSERT INTO inventory_items(user_id,item_id,acquired_at) VALUES(?,?,?)', ctx.user.id, item.id, clock.iso());
      audit.write({ tenantId: ctx.actor.tenantId, actorId: ctx.user.id, action: 'shop.purchase', targetType: 'shop_item', targetId: item.id, diff: { price: item.price }, requestId: ctx.requestId });
      return { status: 201, __raw: true, data: { itemId: item.id, ...wallet(db, ctx.user.id) } };
    });
  });
}
