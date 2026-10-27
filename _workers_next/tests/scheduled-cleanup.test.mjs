import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';
import { cleanupExpiredData, runScheduledCleanup, CLEANUP_BATCH_SIZE, MAX_CLEANUP_BATCHES } from '../scheduled-cleanup.mjs';
import { INFINITE_STOCK, RESERVATION_TTL_MS } from '../src/lib/constants.mjs';

const NOW = 1793100000000;
const CUTOFF = NOW - RESERVATION_TTL_MS;

function fixture(t) {
    const sqlite = new DatabaseSync(':memory:');
    t.after(() => sqlite.close());
    sqlite.exec(`
        CREATE TABLE products (
            id TEXT PRIMARY KEY, is_shared INTEGER DEFAULT 0,
            stock_count INTEGER DEFAULT 0, locked_count INTEGER DEFAULT 0,
            sold_count INTEGER DEFAULT 9, rating REAL DEFAULT 4.5, review_count INTEGER DEFAULT 2
        );
        CREATE TABLE cards (
            id INTEGER PRIMARY KEY, product_id TEXT NOT NULL, is_used INTEGER DEFAULT 0,
            reserved_order_id TEXT, reserved_at INTEGER, expires_at INTEGER
        );
        CREATE TABLE orders (
            order_id TEXT PRIMARY KEY, product_id TEXT NOT NULL,
            status TEXT DEFAULT 'pending', created_at INTEGER
        );
        CREATE INDEX cards_expires_at_idx ON cards(expires_at);
        CREATE INDEX cards_product_used_reserved_idx ON cards(product_id, is_used, reserved_at);
        CREATE INDEX cards_reserved_order_idx ON cards(reserved_order_id);
        CREATE INDEX orders_status_created_at_idx ON orders(status, created_at);
    `);
    const calls = [];
    const db = {
        beforeWrite: null,
        prepare(query) {
            const statement = { query, values: [], bind(...values) { return { ...this, values }; } };
            return statement;
        },
        async batch(statements) {
            for (const statement of statements) {
                assert.ok(statement.values.length <= 100, 'D1 statement binding limit');
                assert.doesNotMatch(statement.query, /\b(?:ALTER|CREATE|DROP)\s+(?:TABLE|INDEX)\b/i, 'No schema work in cron');
            }
            if (statements.some(s => /^\s*(UPDATE|DELETE)/.test(s.query)) && this.beforeWrite) {
                const hook = this.beforeWrite; this.beforeWrite = null;
                await hook();
            }
            calls.push(...statements);
            sqlite.exec('BEGIN');
            try {
                const results = statements.map(({ query, values }) => ({
                    success: true,
                    results: sqlite.prepare(query).all(...values),
                    meta: { changes: sqlite.prepare('SELECT changes() AS n').get().n },
                }));
                sqlite.exec('COMMIT');
                return results;
            } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
        },
    };
    const product = (id = 'p', shared = 0) => sqlite.prepare('INSERT INTO products(id, is_shared) VALUES (?, ?)').run(id, shared);
    const order = (id, { productId = 'p', status = 'pending', createdAt = CUTOFF - 1 } = {}) =>
        sqlite.prepare('INSERT INTO orders VALUES (?, ?, ?, ?)').run(id, productId, status, createdAt);
    const card = (id, { productId = 'p', used = 0, orderId = null, reservedAt = null, expiresAt = null } = {}) =>
        sqlite.prepare('INSERT INTO cards VALUES (?, ?, ?, ?, ?, ?)').run(id, productId, used, orderId, reservedAt, expiresAt);
    const getProduct = (id = 'p') => ({ ...sqlite.prepare('SELECT * FROM products WHERE id = ?').get(id) });
    return { db, sqlite, calls, product, order, card, getProduct };
}

test('idle cleanup only reads indexed candidates and leaves data untouched', async t => {
    const f = fixture(t);
    f.product(); f.order('new', { createdAt: NOW }); f.card(1, { expiresAt: NOW + 1 });
    const before = f.getProduct();
    const result = await cleanupExpiredData(f.db, NOW);
    assert.deepEqual(result, { deletedCardCount: 0, cancelledOrderCount: 0, updatedProductCount: 0, batches: 0 });
    assert.deepEqual(f.getProduct(), before);
    assert.equal(f.calls.length, 2);
    assert.ok(f.calls.every(s => /^\s*SELECT/.test(s.query)));
});

test('an expired pending order releases all reserved cards and refreshes only inventory', async t => {
    const f = fixture(t); f.product(); f.order('old');
    for (const id of [1, 2, 3]) f.card(id, { orderId: 'old', reservedAt: CUTOFF - 1 });
    const result = await cleanupExpiredData(f.db, NOW);
    assert.equal(result.cancelledOrderCount, 1);
    assert.equal(f.sqlite.prepare('SELECT status FROM orders').get().status, 'cancelled');
    assert.ok(f.sqlite.prepare('SELECT * FROM cards').all().every(c => c.reserved_at === null && c.reserved_order_id === null));
    assert.deepEqual(f.getProduct(), { id: 'p', is_shared: 0, stock_count: 3, locked_count: 0, sold_count: 9, rating: 4.5, review_count: 2 });
    const writes = f.calls.filter(s => /^\s*(UPDATE|DELETE)/.test(s.query)).length;
    assert.equal((await cleanupExpiredData(f.db, NOW)).batches, 0);
    assert.equal(f.calls.filter(s => /^\s*(UPDATE|DELETE)/.test(s.query)).length, writes);
});

test('paid, delivered, failed, cancelled and exactly-five-minute orders remain intact', async t => {
    const f = fixture(t); f.product();
    for (const [index, status] of ['paid', 'delivered', 'failed', 'cancelled', 'pending'].entries()) {
        const id = `order-${index}`;
        f.order(id, { status, createdAt: status === 'pending' ? CUTOFF : CUTOFF - 1 });
        f.card(index + 1, { orderId: id, reservedAt: NOW - 1 });
    }
    // A payment-only order has no physical product. It must still be cancellable.
    f.order('payment', { productId: 'payment-only' });
    const before = f.sqlite.prepare('SELECT * FROM cards').all();
    const result = await cleanupExpiredData(f.db, NOW);
    assert.equal(result.cancelledOrderCount, 1);
    assert.deepEqual(f.sqlite.prepare('SELECT * FROM cards').all(), before);
    assert.equal(f.sqlite.prepare("SELECT status FROM orders WHERE order_id = 'order-4'").get().status, 'pending');
});

test('expired-card deletion preserves strict expiry boundaries and inventory rules', async t => {
    const f = fixture(t); f.product();
    f.card(1, { expiresAt: NOW - 1 });
    f.card(2, { used: 1, expiresAt: NOW - 1 }); // Existing cleanup also removes expired used cards.
    f.card(3, { expiresAt: NOW });
    f.card(4, { used: null });
    f.card(5, { reservedAt: CUTOFF - 1 });
    f.card(6, { reservedAt: CUTOFF });
    f.card(7, { used: 1 });
    const result = await cleanupExpiredData(f.db, NOW);
    assert.equal(result.deletedCardCount, 2);
    assert.deepEqual(f.sqlite.prepare('SELECT id FROM cards ORDER BY id').all().map(c => c.id), [3, 4, 5, 6, 7]);
    assert.equal(f.getProduct().stock_count, 2);
    assert.equal(f.getProduct().locked_count, 1);
    assert.equal((await cleanupExpiredData(f.db, NOW + 1)).deletedCardCount, 1);
});

test('shared-card products retain unlimited stock while an unused unexpired card remains', async t => {
    const f = fixture(t); f.product('shared', 1); f.product('empty-shared', 1);
    f.card(1, { productId: 'shared', expiresAt: NOW - 1 });
    f.card(2, { productId: 'shared', reservedAt: NOW });
    f.card(3, { productId: 'empty-shared', expiresAt: NOW - 1 });
    await cleanupExpiredData(f.db, NOW);
    assert.equal(f.getProduct('shared').stock_count, INFINITE_STOCK);
    assert.equal(f.getProduct('shared').locked_count, 1);
    assert.equal(f.getProduct('empty-shared').stock_count, 0);
});

test('payment completed between selection and mutation is never cancelled or unlocked', async t => {
    const f = fixture(t); f.product(); f.order('racing'); f.card(1, { orderId: 'racing', reservedAt: NOW - 1 });
    f.db.beforeWrite = () => f.sqlite.exec("UPDATE orders SET status = 'paid' WHERE order_id = 'racing'");
    const result = await cleanupExpiredData(f.db, NOW);
    assert.equal(result.cancelledOrderCount, 0);
    assert.equal(f.sqlite.prepare('SELECT status FROM orders').get().status, 'paid');
    assert.equal(f.sqlite.prepare('SELECT reserved_order_id FROM cards').get().reserved_order_id, 'racing');
    assert.equal(f.getProduct().locked_count, 1);
});

test('a card whose expiry is extended after selection survives cleanup', async t => {
    const f = fixture(t); f.product(); f.card(1, { expiresAt: NOW - 1 });
    f.db.beforeWrite = () => f.sqlite.prepare('UPDATE cards SET expires_at = ?').run(NOW + 1000);
    assert.equal((await cleanupExpiredData(f.db, NOW)).deletedCardCount, 0);
    assert.equal(f.getProduct().stock_count, 1);
});

test('overlapping ticks are idempotent and cannot cancel the same order twice', async t => {
    const f = fixture(t); f.product(); f.order('old'); f.card(1, { orderId: 'old', reservedAt: CUTOFF - 1 });
    const results = await Promise.all([cleanupExpiredData(f.db, NOW), cleanupExpiredData(f.db, NOW)]);
    assert.equal(results.reduce((sum, r) => sum + r.cancelledOrderCount, 0), 1);
    assert.equal(f.getProduct().stock_count, 1);
    assert.equal(f.getProduct().locked_count, 0);
});

test('inventory-update failure rolls back deletion, cancellation and reservation release', async t => {
    const f = fixture(t); f.product(); f.order('old');
    f.card(1, { expiresAt: NOW - 1 }); f.card(2, { orderId: 'old', reservedAt: CUTOFF - 1 });
    f.sqlite.exec("CREATE TRIGGER fail_inventory BEFORE UPDATE ON products BEGIN SELECT RAISE(ABORT, 'simulated inventory failure'); END");
    await assert.rejects(cleanupExpiredData(f.db, NOW), /simulated inventory failure/);
    assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM cards').get().n, 2);
    assert.equal(f.sqlite.prepare('SELECT status FROM orders').get().status, 'pending');
    assert.equal(f.sqlite.prepare('SELECT reserved_order_id FROM cards WHERE id = 2').get().reserved_order_id, 'old');
});

test('large backlogs are bounded, stay within D1 binding limits and drain on later ticks', async t => {
    const f = fixture(t);
    const count = CLEANUP_BATCH_SIZE * MAX_CLEANUP_BATCHES + 1;
    for (let i = 1; i <= count; i++) {
        f.product(`card-${i}`); f.product(`order-${i}`);
        f.card(i, { productId: `card-${i}`, expiresAt: NOW - 1 });
        f.order(`old-${i}`, { productId: `order-${i}` });
    }
    const first = await cleanupExpiredData(f.db, NOW);
    assert.equal(first.batches, MAX_CLEANUP_BATCHES);
    assert.equal(first.deletedCardCount, count - 1);
    assert.equal(first.cancelledOrderCount, count - 1);
    const second = await cleanupExpiredData(f.db, NOW);
    assert.equal(second.deletedCardCount, 1);
    assert.equal(second.cancelledOrderCount, 1);
    assert.equal((await cleanupExpiredData(f.db, NOW)).batches, 0);
});

test('missing D1 binding rejects the scheduled job instead of reporting success', async t => {
    t.mock.method(console, 'error', () => {});
    await assert.rejects(runScheduledCleanup({}), /binding DB is required/);
});

test('real worker entry routes cron directly to D1 and retains HTTP and named exports', async t => {
    const f = fixture(t);
    const context = vm.createContext({ console, Date });
    let httpCalls = 0;
    const sentinel = {};
    const next = new vm.SyntheticModule(['default', 'DOQueueHandler'], function () {
        this.setExport('default', { fetch: async () => { httpCalls++; return sentinel; } });
        this.setExport('DOQueueHandler', sentinel);
    }, { context });
    const cleanup = new vm.SyntheticModule(['runScheduledCleanup'], function () { this.setExport('runScheduledCleanup', runScheduledCleanup); }, { context });
    const entry = new vm.SourceTextModule(await readFile(new URL('../worker-entry.mjs', import.meta.url), 'utf8'), { context });
    await entry.link(specifier => specifier === './scheduled-cleanup.mjs' ? cleanup : next);
    await entry.evaluate();
    let scheduled;
    await entry.namespace.default.scheduled({}, { DB: f.db }, { waitUntil(promise) { scheduled = promise; } });
    await scheduled;
    assert.equal(httpCalls, 0);
    assert.equal(await entry.namespace.default.fetch({}, {}, {}), sentinel);
    assert.equal(httpCalls, 1);
    assert.equal(entry.namespace.DOQueueHandler, sentinel);
});
