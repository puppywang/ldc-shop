import { getActiveProducts, getCategories, getProductRating, getVisitorCount, getUserPendingOrders } from "@/lib/db/queries";
import { getActiveAnnouncement } from "@/actions/settings";
import { auth } from "@/lib/auth";
import { HomeContent } from "@/components/home-content";

export const dynamic = 'force-dynamic';

export default async function Home() {
  let products: any[] = [];
  try {
    products = await getActiveProducts();
  } catch (error: any) {
    const errorString = JSON.stringify(error);
    const isTableMissing =
      error.message?.includes('does not exist') ||
      error.message?.includes('no such table') ||  // D1/SQLite error
      error.cause?.message?.includes('does not exist') ||
      error.cause?.message?.includes('no such table') ||  // D1/SQLite error
      errorString.includes('42P01') || // PostgreSQL error code for undefined_table
      errorString.includes('no such table') || // D1/SQLite in stringified error
      errorString.includes('relation') && errorString.includes('does not exist');

    if (isTableMissing) {
      console.log("Database initialized check: Table missing. Running inline migrations...");
      const { db } = await import("@/lib/db");
      const { sql } = await import("drizzle-orm");

      await db.run(sql`
        CREATE TABLE IF NOT EXISTS products (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          price TEXT NOT NULL,
          compare_at_price TEXT,
          category TEXT,
          image TEXT,
          is_hot INTEGER DEFAULT 0,
          is_active INTEGER DEFAULT 1,
          sort_order INTEGER DEFAULT 0,
          purchase_limit INTEGER,
          created_at INTEGER DEFAULT (unixepoch() * 1000)
        );
        CREATE TABLE IF NOT EXISTS cards (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          card_key TEXT NOT NULL,
          is_used INTEGER DEFAULT 0,
          reserved_order_id TEXT,
          reserved_at INTEGER,
          used_at INTEGER,
          created_at INTEGER DEFAULT (unixepoch() * 1000)
        );
        CREATE TABLE IF NOT EXISTS orders (
          order_id TEXT PRIMARY KEY,
          product_id TEXT NOT NULL,
          product_name TEXT NOT NULL,
          amount TEXT NOT NULL,
          email TEXT,
          payee TEXT,
          status TEXT DEFAULT 'pending',
          trade_no TEXT,
          card_key TEXT,
          paid_at INTEGER,
          delivered_at INTEGER,
          user_id TEXT,
          username TEXT,
          points_used INTEGER DEFAULT 0,
          quantity INTEGER DEFAULT 1 NOT NULL,
          current_payment_id TEXT,
          created_at INTEGER DEFAULT (unixepoch() * 1000)
        );
        CREATE TABLE IF NOT EXISTS login_users (
          user_id TEXT PRIMARY KEY,
          username TEXT,
          points INTEGER DEFAULT 0 NOT NULL,
          is_blocked INTEGER DEFAULT 0,
          created_at INTEGER DEFAULT (unixepoch() * 1000),
          last_login_at INTEGER DEFAULT (unixepoch() * 1000)
        );
        CREATE TABLE IF NOT EXISTS daily_checkins (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL REFERENCES login_users(user_id) ON DELETE CASCADE,
          created_at INTEGER DEFAULT (unixepoch() * 1000)
        );
        -- Note: ALTER TABLE ADD COLUMN IF NOT EXISTS is not supported in SQLite
        -- All columns are already defined in CREATE TABLE above
        UPDATE cards SET is_used = 0 WHERE is_used IS NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS cards_product_id_card_key_uq ON cards(product_id, card_key);
        -- Settings table for announcements
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT,
          updated_at INTEGER DEFAULT (unixepoch() * 1000)
        );
        -- Categories table
        CREATE TABLE IF NOT EXISTS categories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          icon TEXT,
          sort_order INTEGER DEFAULT 0,
          created_at INTEGER DEFAULT (unixepoch() * 1000),
          updated_at INTEGER DEFAULT (unixepoch() * 1000)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS categories_name_uq ON categories(name);
        -- Reviews table
        CREATE TABLE IF NOT EXISTS reviews (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          order_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          username TEXT NOT NULL,
          rating INTEGER NOT NULL,
          comment TEXT,
          created_at INTEGER DEFAULT (unixepoch() * 1000)
        );
        -- Refund requests
        CREATE TABLE IF NOT EXISTS refund_requests (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          order_id TEXT NOT NULL,
          user_id TEXT,
          username TEXT,
          reason TEXT,
          status TEXT DEFAULT 'pending',
          admin_username TEXT,
          admin_note TEXT,
          created_at INTEGER DEFAULT (unixepoch() * 1000),
          updated_at INTEGER DEFAULT (unixepoch() * 1000),
          processed_at INTEGER
        );
      `);

      products = await getActiveProducts();
    } else {
      throw error;
    }
  }

  const announcement = await getActiveAnnouncement();

  // Fetch ratings for each product
  const productsWithRatings = await Promise.all(
    products.map(async (p) => {
      let rating = { average: 0, count: 0 };
      try {
        rating = await getProductRating(p.id);
      } catch {
        // Reviews table might not exist yet
      }
      return {
        ...p,
        stockCount: p.stock + (p.locked || 0),
        soldCount: p.sold || 0,
        rating: rating.average,
        reviewCount: rating.count
      };
    })
  );

  let visitorCount = 0;
  try {
    visitorCount = await getVisitorCount();
  } catch {
    visitorCount = 0;
  }

  let categories: any[] = []
  try {
    categories = await getCategories()
  } catch {
    categories = []
  }

  // Check for pending orders
  const session = await auth();
  let pendingOrders: any[] = [];
  if (session?.user?.id) {
    try {
      pendingOrders = await getUserPendingOrders(session.user.id);
    } catch {
      // Ignore errors fetching pending orders
    }
  }

  return <HomeContent
    products={productsWithRatings}
    announcement={announcement}
    visitorCount={visitorCount}
    categories={categories}
    pendingOrders={pendingOrders}
  />;
}
