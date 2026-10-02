DROP POLICY isolation ON changes;
CREATE POLICY isolation ON changes USING(tenant_visible(tenant_id) AND (store_visible(store_id) OR (kind='transfer' AND store_visible((body->'body'->>'toStoreId')::uuid)))) WITH CHECK(tenant_visible(tenant_id) AND (store_visible(store_id) OR (kind='transfer' AND store_visible((body->'body'->>'toStoreId')::uuid))));
