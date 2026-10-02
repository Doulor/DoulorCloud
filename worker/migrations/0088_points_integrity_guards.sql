-- 0088_points_integrity_guards.sql
--
-- Keep the points ledger and finite product inventory non-negative, and make
-- inventory reservation part of the point-order INSERT transaction. The
-- application can still compensate points when a later step fails, but an
-- order INSERT can no longer leave stock behind when the INSERT itself aborts.

CREATE TRIGGER IF NOT EXISTS trg_user_points_nonnegative_insert
BEFORE INSERT ON user_points
WHEN NEW.balance < 0
BEGIN
  SELECT RAISE(ABORT, 'user_points balance cannot be negative');
END;

CREATE TRIGGER IF NOT EXISTS trg_user_points_nonnegative_update
BEFORE UPDATE OF balance ON user_points
WHEN NEW.balance < 0
BEGIN
  SELECT RAISE(ABORT, 'user_points balance cannot be negative');
END;

-- NULL means unlimited inventory and keeps the existing product semantics.
CREATE TRIGGER IF NOT EXISTS trg_point_products_stock_nonnegative_insert
BEFORE INSERT ON point_products
WHEN NEW.stock IS NOT NULL AND NEW.stock < 0
BEGIN
  SELECT RAISE(ABORT, 'point_products stock cannot be negative');
END;

CREATE TRIGGER IF NOT EXISTS trg_point_products_stock_nonnegative_update
BEFORE UPDATE OF stock ON point_products
WHEN NEW.stock IS NOT NULL AND NEW.stock < 0
BEGIN
  SELECT RAISE(ABORT, 'point_products stock cannot be negative');
END;

-- One reservation flag lets cancellation and rental expiry return stock exactly
-- once, even when the product row is later edited or removed.
ALTER TABLE point_orders ADD COLUMN stock_reserved INTEGER NOT NULL DEFAULT 0;

-- Existing application versions already decremented stock before inserting an
-- order. Reconstruct the reservation bit for still-active finite-inventory
-- orders. Orders already handled by rental expiry returned their reservation
-- before this migration and must remain clear.
UPDATE point_orders
   SET stock_reserved = 1
 WHERE product_id IS NOT NULL
   AND status <> 'cancelled'
   AND expire_handled_at IS NULL
   AND product_id IN (SELECT id FROM point_products WHERE stock IS NOT NULL);

-- Reserve finite stock in the same SQLite statement transaction as the order
-- INSERT. The trigger deliberately owns the final race check; the application
-- snapshot is only an early UX check and is not a concurrency guarantee.
CREATE TRIGGER IF NOT EXISTS trg_point_orders_reserve_stock_before_insert
BEFORE INSERT ON point_orders
WHEN NEW.product_id IS NOT NULL AND NEW.status <> 'cancelled'
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM point_products
       WHERE id = NEW.product_id AND enabled = 1
    )
    THEN RAISE(ABORT, 'point product is missing or disabled')
  END;

  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM point_products
       WHERE id = NEW.product_id AND stock IS NOT NULL AND stock <= 0
    )
    THEN RAISE(ABORT, 'point product is out of stock')
  END;

  UPDATE point_products
     SET stock = stock - 1,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE id = NEW.product_id AND stock IS NOT NULL;
END;

CREATE TRIGGER IF NOT EXISTS trg_point_orders_mark_stock_reserved_after_insert
AFTER INSERT ON point_orders
WHEN NEW.product_id IS NOT NULL AND NEW.status <> 'cancelled'
BEGIN
  UPDATE point_orders
     SET stock_reserved = CASE
       WHEN EXISTS (
         SELECT 1 FROM point_products
          WHERE id = NEW.product_id AND stock IS NOT NULL
       ) THEN 1 ELSE 0 END
   WHERE id = NEW.id;
END;

-- A cancellation transition is the single source of truth for returning an
-- order's reservation. Clearing the flag in the same trigger makes retries and
-- concurrent cancellation requests harmless.
CREATE TRIGGER IF NOT EXISTS trg_point_orders_restore_stock_on_cancel
AFTER UPDATE OF status ON point_orders
WHEN OLD.status <> 'cancelled' AND NEW.status = 'cancelled' AND NEW.stock_reserved = 1
BEGIN
  UPDATE point_products
     SET stock = stock + 1,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE id = NEW.product_id AND stock IS NOT NULL;
  UPDATE point_orders SET stock_reserved = 0 WHERE id = NEW.id;
END;

-- Rental expiry keeps the historical order status, so use the expiry marker as
-- the other one-way transition that releases a reservation.
CREATE TRIGGER IF NOT EXISTS trg_point_orders_restore_stock_on_expiry
AFTER UPDATE OF expire_handled_at ON point_orders
WHEN OLD.expire_handled_at IS NULL
  AND NEW.expire_handled_at IS NOT NULL
  AND NEW.stock_reserved = 1
BEGIN
  UPDATE point_products
     SET stock = stock + 1,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE id = NEW.product_id AND stock IS NOT NULL;
  UPDATE point_orders SET stock_reserved = 0 WHERE id = NEW.id;
END;
