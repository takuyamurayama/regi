CREATE TABLE device_leases (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,store_id uuid NOT NULL,device_id uuid NOT NULL,
 issued_at timestamptz NOT NULL,auth_until timestamptz NOT NULL,contract_until timestamptz NOT NULL,
 FOREIGN KEY(tenant_id,device_id) REFERENCES devices(tenant_id,id),FOREIGN KEY(tenant_id,store_id) REFERENCES stores(tenant_id,id)
);
ALTER TABLE device_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_leases FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON device_leases USING(tenant_visible(tenant_id) AND store_visible(store_id)) WITH CHECK(tenant_visible(tenant_id) AND store_visible(store_id));
GRANT SELECT,INSERT ON device_leases TO regi_app;
DROP POLICY isolation ON documents;
CREATE POLICY isolation ON documents USING(tenant_visible(tenant_id) AND (store_visible(store_id) OR (kind='transfer' AND store_visible((body->>'toStoreId')::uuid)))) WITH CHECK(tenant_visible(tenant_id) AND (store_visible(store_id) OR (kind='transfer' AND store_visible((body->>'toStoreId')::uuid))));
