ALTER TABLE device_events
  ADD CONSTRAINT device_events_status_check CHECK (status IN ('pending','accepted','review','waiting','dismissed')),
  ADD COLUMN dismissed_by uuid,
  ADD COLUMN dismiss_reason text,
  ADD CONSTRAINT device_events_dismissed_by_fkey FOREIGN KEY (tenant_id,dismissed_by) REFERENCES staff(tenant_id,id),
  ADD CONSTRAINT device_events_dismiss_reason_check CHECK (status <> 'dismissed' OR (dismissed_by IS NOT NULL AND dismiss_reason IS NOT NULL AND length(btrim(dismiss_reason)) > 0));

CREATE TABLE device_event_quarantine (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  store_id uuid NOT NULL,
  device_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','accepted','review','waiting','dismissed')),
  result jsonb NOT NULL,
  body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  dismissed_by uuid,
  dismiss_reason text,
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,device_id) REFERENCES devices(tenant_id,id),
  FOREIGN KEY (tenant_id,store_id) REFERENCES stores(tenant_id,id),
  FOREIGN KEY (tenant_id,dismissed_by) REFERENCES staff(tenant_id,id),
  CHECK (status <> 'dismissed' OR (dismissed_by IS NOT NULL AND dismiss_reason IS NOT NULL AND length(btrim(dismiss_reason)) > 0))
);
ALTER TABLE device_event_quarantine ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_event_quarantine FORCE ROW LEVEL SECURITY;
CREATE POLICY isolation ON device_event_quarantine
  USING (tenant_visible(tenant_id) AND store_visible(store_id))
  WITH CHECK (tenant_visible(tenant_id) AND store_visible(store_id));
GRANT SELECT,INSERT,UPDATE,DELETE ON device_event_quarantine TO regi_app;

ALTER TABLE staff DROP CONSTRAINT staff_subject_key;
CREATE UNIQUE INDEX staff_active_subject ON staff(subject) WHERE active;
ALTER TABLE devices ADD COLUMN review_count integer NOT NULL DEFAULT 0 CHECK (review_count >= 0);

REVOKE ALL ON regi_migrations FROM regi_app;
GRANT SELECT ON regi_migrations TO regi_app;
