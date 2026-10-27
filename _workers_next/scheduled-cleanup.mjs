import { INFINITE_STOCK, RESERVATION_TTL_MS } from './src/lib/constants.mjs';

// At most 80 product IDs + 6 scalar bindings per statement (D1 limit: 100).
// Leave backlog for the next minute instead of unbounded work in one invocation.
export const CLEANUP_BATCH_SIZE = 40;
export const MAX_CLEANUP_BATCHES = 4;
const placeholders = (values) => values.map(() => '?').join(', ');

/** Run cleanup using the native D1 binding, without Next.js, Drizzle or DDL. */
export async function cleanupExpiredData(db, now = Date.now()) {
    if (!db) throw new Error('D1 Database binding DB is required for scheduled cleanup');
    const cutoff = now - RESERVATION_TTL_MS;
    const totals = { deletedCardCount: 0, cancelledOrderCount: 0, updatedProductCount: 0, batches: 0 };

    for (let batch = 0; batch < MAX_CLEANUP_BATCHES; batch++) {
        const [cardResult, orderResult] = await db.batch([
            db.prepare(`
                SELECT id, product_id FROM cards
                WHERE expires_at IS NOT NULL AND expires_at < ?
                ORDER BY expires_at, id LIMIT ?
            `).bind(now, CLEANUP_BATCH_SIZE),
            db.prepare(`
                SELECT order_id, product_id FROM orders
                WHERE status = 'pending' AND created_at < ?
                ORDER BY created_at, order_id LIMIT ?
            `).bind(cutoff, CLEANUP_BATCH_SIZE),
        ]);
        const expiredCards = cardResult.results;
        const expiredOrders = orderResult.results;
        if (!expiredCards.length && !expiredOrders.length) break;

        const statements = [];
        let deleteIndex = -1;
        let cancelIndex = -1;
        if (expiredCards.length) {
            const ids = expiredCards.map(card => card.id);
            deleteIndex = statements.length;
            statements.push(db.prepare(`
                DELETE FROM cards
                WHERE id IN (${placeholders(ids)}) AND expires_at < ?
            `).bind(...ids, now));
        }
        if (expiredOrders.length) {
            const ids = expiredOrders.map(order => order.order_id);
            // Recheck status inside the write transaction: payment may have completed
            // since the candidate query. Never unlock/cancel an already paid order.
            statements.push(db.prepare(`
                UPDATE cards SET reserved_order_id = NULL, reserved_at = NULL
                WHERE reserved_order_id IN (
                    SELECT order_id FROM orders
                    WHERE order_id IN (${placeholders(ids)})
                      AND status = 'pending' AND created_at < ?
                )
            `).bind(...ids, cutoff));
            cancelIndex = statements.length;
            statements.push(db.prepare(`
                UPDATE orders SET status = 'cancelled'
                WHERE order_id IN (${placeholders(ids)})
                  AND status = 'pending' AND created_at < ?
            `).bind(...ids, cutoff));
        }

        const productIds = [...new Set([...expiredCards, ...expiredOrders].map(row => row.product_id))];
        // Refresh only inventory: cancelling pending orders does not change sales or
        // reviews. Compute from current rows in D1, not a potentially stale JS copy.
        statements.push(db.prepare(`
            UPDATE products SET
                stock_count = CASE WHEN is_shared THEN
                    CASE WHEN EXISTS (
                        SELECT 1 FROM cards WHERE product_id = products.id
                          AND COALESCE(is_used, 0) = 0
                          AND (expires_at IS NULL OR expires_at > ?)
                    ) THEN ? ELSE 0 END
                ELSE (
                    SELECT COUNT(*) FROM cards WHERE product_id = products.id
                      AND COALESCE(is_used, 0) = 0
                      AND (expires_at IS NULL OR expires_at > ?)
                      AND (reserved_at IS NULL OR reserved_at < ?)
                ) END,
                locked_count = (
                    SELECT COUNT(*) FROM cards WHERE product_id = products.id
                      AND COALESCE(is_used, 0) = 0
                      AND (expires_at IS NULL OR expires_at > ?)
                      AND reserved_at IS NOT NULL AND reserved_at >= ?
                )
            WHERE id IN (${placeholders(productIds)})
        `).bind(now, INFINITE_STOCK, now, cutoff, now, cutoff, ...productIds));

        // D1 batch is atomic: deletion, reservation release, cancellation and stock
        // counters either all commit or all roll back. A later minute can retry.
        const results = await db.batch(statements);
        totals.deletedCardCount += deleteIndex < 0 ? 0 : results[deleteIndex].meta.changes;
        totals.cancelledOrderCount += cancelIndex < 0 ? 0 : results[cancelIndex].meta.changes;
        totals.updatedProductCount += results.at(-1).meta.changes;
        totals.batches++;
        if (expiredCards.length < CLEANUP_BATCH_SIZE && expiredOrders.length < CLEANUP_BATCH_SIZE) break;
    }
    return totals;
}

export async function runScheduledCleanup(env) {
    const startedAt = Date.now();
    try {
        const result = await cleanupExpiredData(env?.DB);
        // Idle invocations do no writes and need no duplicate success log.
        if (result.deletedCardCount || result.cancelledOrderCount) {
            console.log('[cron-cleanup] ok:', { ...result, durationMs: Date.now() - startedAt });
        }
        return result;
    } catch (error) {
        console.error('[cron-cleanup] failed:', error);
        // Preserve rejection so Cloudflare reports a failed scheduled invocation.
        throw error;
    }
}
