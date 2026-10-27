import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';

// Use Wrangler's own runtime dependency, including when npm nests dependencies.
const require = createRequire(import.meta.url);
const { Miniflare, Log, LogLevel } = createRequire(require.resolve('wrangler'))('miniflare');
const appRoot = fileURLToPath(new URL('../', import.meta.url));

test('the real scheduled entry commits and rolls back through native workerd D1', { timeout: 25000 }, async t => {
    const sourceFiles = ['worker-entry.mjs', 'scheduled-cleanup.mjs', 'src/lib/constants.mjs'];
    const modules = await Promise.all(sourceFiles.map(async file => ({
        type: 'ESModule', path: path.join(appRoot, file), contents: await readFile(path.join(appRoot, file), 'utf8'),
    })));
    modules.unshift({ type: 'ESModule', path: path.join(appRoot, 'runtime-test-entry.mjs'), contents: `
        import worker from './worker-entry.mjs';
        export default { async fetch(request, env) {
            const pending = [];
            let result;
            try {
                await worker.scheduled({}, env, { waitUntil(promise) {
                    pending.push(promise.then(value => { result = value; }));
                }});
                await Promise.all(pending);
                return Response.json(result);
            } catch (error) { return Response.json({ error: error.message }, { status: 500 }); }
        }};
    ` });
    modules.push({ type: 'ESModule', path: path.join(appRoot, '.open-next/worker.js'), contents: `
        export default { fetch() { throw new Error('Cron must not call the Next.js HTTP handler'); } };
    ` });
    const mf = new Miniflare({
        modules, modulesRoot: appRoot, compatibilityDate: '2025-11-12',
        compatibilityFlags: ['nodejs_compat'], host: '127.0.0.1', port: 0,
        d1Databases: { DB: 'scheduled-cleanup-runtime-test' }, d1Persist: false,
        cachePersist: false, log: new Log(LogLevel.ERROR),
    });
    const deadline = setTimeout(() => { void mf.dispose(); }, 20000);
    t.after(async () => { clearTimeout(deadline); await mf.dispose(); });
    const db = await mf.getD1Database('DB');
    const now = Date.now();
    await db.batch([
        db.prepare('CREATE TABLE products (id TEXT PRIMARY KEY, is_shared INTEGER DEFAULT 0, stock_count INTEGER DEFAULT 0, locked_count INTEGER DEFAULT 0)'),
        db.prepare('CREATE TABLE orders (order_id TEXT PRIMARY KEY, product_id TEXT NOT NULL, status TEXT, created_at INTEGER)'),
        db.prepare('CREATE TABLE cards (id INTEGER PRIMARY KEY, product_id TEXT NOT NULL, is_used INTEGER DEFAULT 0, reserved_order_id TEXT, reserved_at INTEGER, expires_at INTEGER)'),
        db.prepare("INSERT INTO products (id) VALUES ('p')"),
        db.prepare("INSERT INTO orders VALUES ('expired', 'p', 'pending', ?)").bind(now - 600000),
        db.prepare("INSERT INTO orders VALUES ('paid', 'p', 'paid', ?)").bind(now - 600000),
        db.prepare("INSERT INTO cards VALUES (1, 'p', 0, 'expired', ?, NULL)").bind(now - 600000),
        db.prepare("INSERT INTO cards VALUES (2, 'p', 0, 'paid', ?, NULL)").bind(now),
        db.prepare("INSERT INTO cards VALUES (3, 'p', 0, NULL, NULL, ?)").bind(now - 1),
    ]);
    let response = await mf.dispatchFetch('http://cleanup.test/tick');
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    assert.equal(result.deletedCardCount, 1);
    assert.equal(result.cancelledOrderCount, 1);
    assert.equal((await db.prepare("SELECT status FROM orders WHERE order_id = 'paid'").first()).status, 'paid');
    assert.equal((await db.prepare('SELECT reserved_order_id FROM cards WHERE id = 2').first()).reserved_order_id, 'paid');
    assert.deepEqual(await db.prepare('SELECT stock_count, locked_count FROM products').first(), { stock_count: 1, locked_count: 1 });
    response = await mf.dispatchFetch('http://cleanup.test/tick');
    assert.equal((await response.json()).batches, 0);

    await db.batch([
        db.prepare("INSERT INTO orders VALUES ('rollback', 'p', 'pending', ?)").bind(now - 600000),
        db.prepare("INSERT INTO cards VALUES (4, 'p', 0, 'rollback', ?, NULL)").bind(now - 600000),
        db.prepare("CREATE TRIGGER fail_inventory BEFORE UPDATE ON products BEGIN SELECT RAISE(ABORT, 'simulated inventory failure'); END"),
    ]);
    response = await mf.dispatchFetch('http://cleanup.test/tick');
    assert.equal(response.status, 500);
    await response.text();
    assert.equal((await db.prepare("SELECT status FROM orders WHERE order_id = 'rollback'").first()).status, 'pending');
    assert.equal((await db.prepare('SELECT reserved_order_id FROM cards WHERE id = 4').first()).reserved_order_id, 'rollback');
});
