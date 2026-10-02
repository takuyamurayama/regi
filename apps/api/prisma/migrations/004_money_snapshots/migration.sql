ALTER TABLE prices ADD COLUMN cost_snapshot bigint NOT NULL DEFAULT 0 CHECK(cost_snapshot>=0);
ALTER TABLE prices NO FORCE ROW LEVEL SECURITY;
ALTER TABLE products NO FORCE ROW LEVEL SECURITY;
UPDATE prices SET cost_snapshot=p.cost FROM products p WHERE prices.product_id=p.id AND prices.tenant_id=p.tenant_id;
ALTER TABLE products FORCE ROW LEVEL SECURITY;
ALTER TABLE prices FORCE ROW LEVEL SECURITY;
ALTER TABLE device_leases ADD COLUMN price_mode text NOT NULL DEFAULT 'inclusive' CHECK(price_mode IN ('inclusive','exclusive'));
