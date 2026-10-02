CREATE TABLE tenants (
 id uuid PRIMARY KEY, name text NOT NULL, price_mode text NOT NULL CHECK(price_mode IN ('inclusive','exclusive')),
 starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, version integer NOT NULL DEFAULT 1,
 CHECK(ends_at > starts_at)
);
CREATE TABLE stores (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), name text NOT NULL,
 UNIQUE(tenant_id,id));
CREATE TABLE staff (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), subject text NOT NULL,
 name text NOT NULL, role text NOT NULL CHECK(role IN ('admin','headquarters','manager','cashier')), stores uuid[] NOT NULL,
 pin_hash text NOT NULL, active boolean NOT NULL DEFAULT true, UNIQUE(tenant_id,id), UNIQUE(subject));
CREATE TABLE devices (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, store_id uuid NOT NULL, name text NOT NULL,
 active boolean NOT NULL DEFAULT true, stopped boolean NOT NULL DEFAULT false, pending integer NOT NULL DEFAULT 0 CHECK(pending >= 0),
 last_sync timestamptz, auth_until timestamptz, lease_issued_at timestamptz, lease_contract_until timestamptz,
 UNIQUE(tenant_id,id), FOREIGN KEY(tenant_id,store_id) REFERENCES stores(tenant_id,id));
CREATE TABLE products (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), sku text NOT NULL,
 jan text, name text NOT NULL, category text NOT NULL DEFAULT '', stock_managed boolean NOT NULL,
 cost bigint NOT NULL CHECK(cost >= 0), version integer NOT NULL DEFAULT 1, active boolean NOT NULL DEFAULT true,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,sku), UNIQUE(tenant_id,jan));
CREATE TABLE prices (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, product_id uuid NOT NULL,
 amount bigint NOT NULL CHECK(amount >= 0), tax_code text NOT NULL, effective_at timestamptz NOT NULL,
 UNIQUE(tenant_id,product_id,effective_at), FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id));
CREATE TABLE tax_rates (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), code text NOT NULL,
 rate_bps integer NOT NULL CHECK(rate_bps BETWEEN 0 AND 10000), effective_at timestamptz NOT NULL,
 UNIQUE(tenant_id,code,effective_at));
CREATE TABLE documents (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), store_id uuid,
 kind text NOT NULL, status text NOT NULL, body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 actor_id uuid NOT NULL, version integer NOT NULL DEFAULT 1, UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,store_id) REFERENCES stores(tenant_id,id), FOREIGN KEY(tenant_id,actor_id) REFERENCES staff(tenant_id,id));
CREATE INDEX documents_lookup ON documents(tenant_id,store_id,kind,created_at);
CREATE UNIQUE INDEX single_open_refund ON documents(tenant_id,(body->>'saleId')) WHERE kind='refund' AND status='pending';
CREATE UNIQUE INDEX single_open_stocktake ON documents(tenant_id,store_id) WHERE kind='stocktake' AND status='pending';
CREATE UNIQUE INDEX single_open_shift ON documents(tenant_id,(body->>'deviceId')) WHERE kind='shift' AND status='open';
CREATE TABLE inventory (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, store_id uuid NOT NULL, product_id uuid NOT NULL,
 quantity integer NOT NULL CHECK(quantity <> 0), source_id uuid NOT NULL, source_line text NOT NULL,
 reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,source_id,source_line,store_id),
 FOREIGN KEY(tenant_id,store_id) REFERENCES stores(tenant_id,id), FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id));
CREATE INDEX inventory_balance ON inventory(tenant_id,store_id,product_id);
CREATE TABLE operations (tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL, store_id uuid,
 hash text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,store_id) REFERENCES stores(tenant_id,id));
CREATE TABLE device_events (tenant_id uuid NOT NULL, id uuid NOT NULL, store_id uuid NOT NULL, device_id uuid NOT NULL,
 sequence bigint NOT NULL CHECK(sequence > 0), hash text NOT NULL, status text NOT NULL, result jsonb NOT NULL,
 body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,device_id,sequence), FOREIGN KEY(tenant_id,device_id) REFERENCES devices(tenant_id,id),
 FOREIGN KEY(tenant_id,store_id) REFERENCES stores(tenant_id,id));
CREATE TABLE change_heads (tenant_id uuid PRIMARY KEY REFERENCES tenants(id), cursor bigint NOT NULL DEFAULT 0);
CREATE TABLE changes (tenant_id uuid NOT NULL REFERENCES tenants(id), cursor bigint NOT NULL, store_id uuid,
 kind text NOT NULL, entity_id uuid NOT NULL, body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,cursor), FOREIGN KEY(tenant_id,store_id) REFERENCES stores(tenant_id,id));
CREATE TABLE audit (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), store_id uuid,
 actor_id uuid NOT NULL, action text NOT NULL, entity_id uuid NOT NULL, body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,store_id) REFERENCES stores(tenant_id,id), FOREIGN KEY(tenant_id,actor_id) REFERENCES staff(tenant_id,id));
CREATE TABLE ai_usage (tenant_id uuid NOT NULL REFERENCES tenants(id), month text NOT NULL, used integer NOT NULL DEFAULT 0 CHECK(used BETWEEN 0 AND 5000), PRIMARY KEY(tenant_id,month));
CREATE TABLE forecasts (tenant_id uuid NOT NULL, store_id uuid NOT NULL, product_id uuid NOT NULL, day date NOT NULL,
 quantity numeric NOT NULL CHECK(quantity >= 0), method text NOT NULL, model_version text NOT NULL, trained_from date,
 trained_to date, generated_at timestamptz NOT NULL, PRIMARY KEY(tenant_id,store_id,product_id,day),
 FOREIGN KEY(tenant_id,store_id) REFERENCES stores(tenant_id,id), FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id));
CREATE FUNCTION tenant_visible(record_tenant uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT record_tenant = nullif(current_setting('regi.tenant',true),'')::uuid
$$;
CREATE FUNCTION store_visible(record_store uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT record_store IS NULL OR current_setting('regi.all_stores',true)='true'
 OR record_store::text = ANY(string_to_array(current_setting('regi.stores',true),','))
$$;
DO $$ DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['tenants','stores','staff','devices','products','prices','tax_rates','documents','inventory','operations','device_events','change_heads','changes','audit','ai_usage','forecasts'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
 IF table_name='tenants' THEN
  EXECUTE format('CREATE POLICY isolation ON %I USING (tenant_visible(id)) WITH CHECK (tenant_visible(id))',table_name);
 ELSIF table_name='stores' THEN
  EXECUTE format('CREATE POLICY isolation ON %I USING (tenant_visible(tenant_id) AND store_visible(id)) WITH CHECK (tenant_visible(tenant_id) AND store_visible(id))',table_name);
 ELSIF table_name IN ('devices','documents','inventory','operations','device_events','changes','audit','forecasts') THEN
  EXECUTE format('CREATE POLICY isolation ON %I USING (tenant_visible(tenant_id) AND store_visible(store_id)) WITH CHECK (tenant_visible(tenant_id) AND store_visible(store_id))',table_name);
 ELSE
  EXECUTE format('CREATE POLICY isolation ON %I USING (tenant_visible(tenant_id)) WITH CHECK (tenant_visible(tenant_id))',table_name);
 END IF;
 END LOOP;
END $$;
CREATE FUNCTION prevent_fact_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'immutable business fact';
END $$;
CREATE TRIGGER inventory_immutable BEFORE UPDATE OR DELETE ON inventory FOR EACH ROW EXECUTE FUNCTION prevent_fact_mutation();
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit FOR EACH ROW EXECUTE FUNCTION prevent_fact_mutation();
CREATE FUNCTION immutable_sale() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.kind='sale' THEN RAISE EXCEPTION 'confirmed sale is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sales_immutable BEFORE UPDATE OR DELETE ON documents FOR EACH ROW EXECUTE FUNCTION immutable_sale();
GRANT USAGE ON SCHEMA public TO regi_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO regi_app;
REVOKE UPDATE,DELETE ON inventory,audit,changes FROM regi_app;
