ALTER TABLE prices NO FORCE ROW LEVEL SECURITY;
ALTER TABLE products NO FORCE ROW LEVEL SECURITY;
UPDATE prices SET cost_snapshot=p.cost FROM products p WHERE prices.product_id=p.id AND prices.tenant_id=p.tenant_id AND prices.cost_snapshot=0 AND p.cost<>0;
ALTER TABLE products FORCE ROW LEVEL SECURITY;
ALTER TABLE prices FORCE ROW LEVEL SECURITY;
