import { db } from "@/lib/db";
import { orders, cards } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { isPaymentOrder } from "@/lib/payment";

export async function processOrderFulfillment(orderId: string, paidAmount: number, tradeNo: string) {
    const order = await db.query.orders.findFirst({
        where: eq(orders.orderId, orderId)
    });

    if (!order) {
        throw new Error(`Order ${orderId} not found`);
    }

    // Verify Amount (Prevent penny-dropping)
    const orderMoney = parseFloat(order.amount);

    // Allow small float epsilon difference
    if (Math.abs(paidAmount - orderMoney) > 0.01) {
        throw new Error(`Amount mismatch! Order: ${orderMoney}, Paid: ${paidAmount}`);
    }

    if (isPaymentOrder(order.productId)) {
        if (order.status === 'pending' || order.status === 'cancelled') {
            await db.update(orders)
                .set({
                    status: 'paid',
                    paidAt: new Date(),
                    tradeNo: tradeNo
                })
                .where(eq(orders.orderId, orderId));
        }
        return { success: true, status: 'processed' };
    }

    if (order.status === 'pending' || order.status === 'cancelled') {
        const quantity = order.quantity || 1;

        await db.transaction(async (tx: any) => {
            // Atomic update to claim card (Postgres only)
            let cardKeys: string[] = [];
            let supportsReservation = true;

            try {
                // Try to claim reserved card first
                // Use RETURNING to get all keys
                const reservedResult = await tx.execute(sql`
                    UPDATE cards
                    SET is_used = true,
                        used_at = NOW(),
                        reserved_order_id = NULL,
                        reserved_at = NULL
                    WHERE reserved_order_id = ${orderId} AND COALESCE(is_used, false) = false
                    RETURNING card_key
                `);

                if (reservedResult.rows.length > 0) {
                    cardKeys = reservedResult.rows.map((r: any) => r.card_key);
                }
            } catch (error: any) {
                const errorString = JSON.stringify(error);
                if (
                    error?.message?.includes('reserved_order_id') ||
                    error?.message?.includes('reserved_at') ||
                    errorString.includes('42703')
                ) {
                    supportsReservation = false;
                } else {
                    throw error;
                }
            }

            if (cardKeys.length < quantity) {
                const needed = quantity - cardKeys.length;
                console.log(`[Fulfill] Order ${orderId}: Found ${cardKeys.length} reserved cards, need ${needed} more.`);

                if (supportsReservation) {
                    // Try to claim strictly available cards (not reserved)
                    // Or "stealable" cards (reserved long ago)
                    // We need 'needed' amount.
                    // LIMIT needed
                    const result = await tx.execute(sql`
                        UPDATE cards
                        SET is_used = true,
                            used_at = NOW(),
                            reserved_order_id = NULL,
                            reserved_at = NULL
                        WHERE id IN (
                            SELECT id
                            FROM cards
                            WHERE product_id = ${order.productId}
                              AND COALESCE(is_used, false) = false
                              AND (reserved_at IS NULL OR reserved_at < NOW() - INTERVAL '1 minute')
                            LIMIT ${needed}
                            FOR UPDATE SKIP LOCKED
                        )
                        RETURNING card_key
                    `);

                    const newKeys = result.rows.map((r: any) => r.card_key);
                    cardKeys = [...cardKeys, ...newKeys];

                } else {
                    // Legacy fallback
                    const result = await tx.execute(sql`
                        UPDATE cards
                        SET is_used = true, used_at = NOW()
                        WHERE id IN (
                            SELECT id
                            FROM cards
                            WHERE product_id = ${order.productId} AND COALESCE(is_used, false) = false
                            LIMIT ${needed}
                            FOR UPDATE SKIP LOCKED
                        )
                        RETURNING card_key
                    `);

                    const newKeys = result.rows.map((r: any) => r.card_key);
                    cardKeys = [...cardKeys, ...newKeys];
                }
            }

            console.log(`[Fulfill] Order ${orderId}: Cards claimed: ${cardKeys.length}/${quantity}`);

            // Even if we got partial headers, we deliver what we have? 
            // Or only if we have > 0?
            // Usually we should have full amount if logic is sound. 
            // If partial, it's better to deliver partial than nothing, but mark as delivered?
            // User can contact admin.

            if (cardKeys.length > 0) {
                const joinedKeys = cardKeys.join('\n');

                await tx.update(orders)
                    .set({
                        status: 'delivered',
                        paidAt: new Date(),
                        deliveredAt: new Date(),
                        tradeNo: tradeNo,
                        cardKey: joinedKeys
                    })
                    .where(eq(orders.orderId, orderId));
                console.log(`[Fulfill] Order ${orderId} delivered successfully!`);
            } else {
                // Paid but no stock
                await tx.update(orders)
                    .set({ status: 'paid', paidAt: new Date(), tradeNo: tradeNo })
                    .where(eq(orders.orderId, orderId));
                console.log(`[Fulfill] Order ${orderId} marked as paid (no stock)`);
            }
        });
        return { success: true, status: 'processed' };
    } else {
        return { success: true, status: 'already_processed' }; // Idempotent success
    }
}
