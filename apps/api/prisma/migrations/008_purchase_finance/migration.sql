-- Buyer-side purchase finance. Existing migrations and confirmed sales are unchanged.
ALTER TABLE documents ADD CONSTRAINT documents_tenant_store_id UNIQUE(tenant_id,store_id,id);

CREATE FUNCTION finance_visible(record_tenant uuid, record_store uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT tenant_visible(record_tenant) AND store_visible(record_store)
 AND current_setting('regi.role',true) IN ('admin','headquarters','manager')
$$;

CREATE TABLE purchase_suppliers (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),code text NOT NULL,
 body jsonb NOT NULL,active boolean NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,code),CHECK(length(code) BETWEEN 1 AND 64)
);
CREATE TABLE purchase_supplier_links (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,store_id uuid NOT NULL,order_id uuid NOT NULL,supplier_id uuid NOT NULL,
 body jsonb NOT NULL,prior_link_id uuid,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),actor_id uuid NOT NULL,
 UNIQUE(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,order_id) REFERENCES documents(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,supplier_id) REFERENCES purchase_suppliers(tenant_id,id),
 FOREIGN KEY(tenant_id,store_id,prior_link_id) REFERENCES purchase_supplier_links(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES staff(tenant_id,id)
);
CREATE TABLE purchase_invoices (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,store_id uuid NOT NULL,supplier_id uuid NOT NULL,
 state text NOT NULL CHECK(state IN ('draft','cancelled','posted','voided')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),draft jsonb NOT NULL,supplier_snapshot jsonb NOT NULL,
 internal_reference text NOT NULL,revision integer NOT NULL DEFAULT 1 CHECK(revision>0),predecessor_invoice_id uuid,
 posted_snapshot_sha256 text,posted_snapshot_version integer,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,store_id,id),UNIQUE(tenant_id,store_id,supplier_id,id),UNIQUE(tenant_id,internal_reference),
 FOREIGN KEY(tenant_id,store_id) REFERENCES stores(tenant_id,id),
 FOREIGN KEY(tenant_id,supplier_id) REFERENCES purchase_suppliers(tenant_id,id),
 FOREIGN KEY(tenant_id,store_id,supplier_id,predecessor_invoice_id) REFERENCES purchase_invoices(tenant_id,store_id,supplier_id,id),
 CHECK((posted_snapshot_sha256 IS NULL AND posted_snapshot_version IS NULL) OR (posted_snapshot_sha256 ~ '^[0-9a-f]{64}$' AND posted_snapshot_version>0)),
 CHECK(state NOT IN ('posted','voided') OR posted_snapshot_sha256 IS NOT NULL)
);
CREATE UNIQUE INDEX purchase_one_replacement ON purchase_invoices(tenant_id,predecessor_invoice_id) WHERE predecessor_invoice_id IS NOT NULL AND state IN ('posted','voided');
CREATE INDEX purchase_invoice_listing ON purchase_invoices(tenant_id,store_id,created_at,id);
CREATE TABLE purchase_invoice_identity (
 tenant_id uuid NOT NULL,store_id uuid NOT NULL,supplier_id uuid NOT NULL,identity_key text NOT NULL,
 revision integer NOT NULL CHECK(revision>0),invoice_id uuid NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,supplier_id,identity_key,revision),UNIQUE(tenant_id,invoice_id),
 FOREIGN KEY(tenant_id,store_id,supplier_id,invoice_id) REFERENCES purchase_invoices(tenant_id,store_id,supplier_id,id),
 CHECK(length(identity_key) BETWEEN 1 AND 256)
);
CREATE TABLE purchase_invoice_snapshots (
 invoice_id uuid PRIMARY KEY,tenant_id uuid NOT NULL,store_id uuid NOT NULL,version integer NOT NULL CHECK(version>0),
 sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),content jsonb NOT NULL,preview jsonb NOT NULL,
 supplier_snapshot jsonb NOT NULL,effective_at timestamptz NOT NULL,reason text,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),actor_id uuid NOT NULL,
 FOREIGN KEY(tenant_id,store_id,invoice_id) REFERENCES purchase_invoices(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES staff(tenant_id,id)
);
CREATE TABLE purchase_invoice_allocations (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,store_id uuid NOT NULL,invoice_id uuid NOT NULL,
 invoice_line_no integer NOT NULL CHECK(invoice_line_no BETWEEN 1 AND 500),receipt_id uuid NOT NULL,
 receipt_line_index integer NOT NULL CHECK(receipt_line_index BETWEEN 0 AND 499),quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 10000),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,store_id,invoice_id) REFERENCES purchase_invoices(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,receipt_id) REFERENCES documents(tenant_id,store_id,id),
 UNIQUE(tenant_id,invoice_id,invoice_line_no,receipt_id,receipt_line_index)
);
CREATE INDEX purchase_receipt_allocations ON purchase_invoice_allocations(tenant_id,store_id,receipt_id,receipt_line_index);
CREATE TABLE purchase_ledger (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,store_id uuid NOT NULL,invoice_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('invoice-debit','invoice-void','supplier-credit','credit-reversal','payment','payment-reversal','supplier-refund','refund-reversal')),
 amount numeric(40,0) NOT NULL CHECK(amount>=0),
 signed_amount numeric(40,0) GENERATED ALWAYS AS (CASE WHEN kind IN ('invoice-debit','credit-reversal','payment-reversal','supplier-refund') THEN amount ELSE -amount END) STORED,
 fact_id uuid NOT NULL,reversal_of uuid,occurred_at timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),actor_id uuid NOT NULL,reason text,
 UNIQUE(tenant_id,store_id,invoice_id,id),UNIQUE(tenant_id,invoice_id,fact_id,kind),UNIQUE(tenant_id,reversal_of),
 FOREIGN KEY(tenant_id,store_id,invoice_id) REFERENCES purchase_invoices(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,invoice_id,reversal_of) REFERENCES purchase_ledger(tenant_id,store_id,invoice_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES staff(tenant_id,id),
 CHECK((kind IN ('invoice-void','credit-reversal','payment-reversal','refund-reversal'))=(reversal_of IS NOT NULL))
);
CREATE UNIQUE INDEX purchase_one_invoice_debit ON purchase_ledger(tenant_id,invoice_id) WHERE kind='invoice-debit';
CREATE INDEX purchase_ledger_asof ON purchase_ledger(tenant_id,store_id,invoice_id,occurred_at,recorded_at,id);
CREATE TABLE purchase_finance_facts (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,store_id uuid NOT NULL,invoice_id uuid NOT NULL,supplier_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('payment','credit','refund')),amount numeric(40,0) NOT NULL CHECK(amount>0),body jsonb NOT NULL,
 ledger_id uuid NOT NULL,reversal_of uuid,occurred_at timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),actor_id uuid NOT NULL,reason text,
 UNIQUE(tenant_id,store_id,invoice_id,id),UNIQUE(tenant_id,reversal_of),
 FOREIGN KEY(tenant_id,store_id,supplier_id,invoice_id) REFERENCES purchase_invoices(tenant_id,store_id,supplier_id,id),
 FOREIGN KEY(tenant_id,store_id,invoice_id,ledger_id) REFERENCES purchase_ledger(tenant_id,store_id,invoice_id,id),
 FOREIGN KEY(tenant_id,store_id,invoice_id,reversal_of) REFERENCES purchase_finance_facts(tenant_id,store_id,invoice_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES staff(tenant_id,id)
);
CREATE INDEX purchase_facts_listing ON purchase_finance_facts(tenant_id,store_id,kind,recorded_at,id);
CREATE TABLE purchase_returns (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,store_id uuid NOT NULL,invoice_id uuid,supplier_id uuid,
 body jsonb NOT NULL,reversal_of uuid,occurred_at timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),actor_id uuid NOT NULL,reason text NOT NULL,
 UNIQUE(tenant_id,store_id,id),UNIQUE(tenant_id,reversal_of),
 FOREIGN KEY(tenant_id,store_id) REFERENCES stores(tenant_id,id),
 FOREIGN KEY(tenant_id,store_id,supplier_id,invoice_id) REFERENCES purchase_invoices(tenant_id,store_id,supplier_id,id),
 FOREIGN KEY(tenant_id,store_id,reversal_of) REFERENCES purchase_returns(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES staff(tenant_id,id)
);
CREATE TABLE purchase_return_lines (
 return_id uuid NOT NULL,tenant_id uuid NOT NULL,store_id uuid NOT NULL,line_no integer NOT NULL,
 receipt_id uuid NOT NULL,receipt_line_index integer NOT NULL CHECK(receipt_line_index BETWEEN 0 AND 499),
 product_id uuid NOT NULL,quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 10000),
 PRIMARY KEY(return_id,line_no),
 FOREIGN KEY(tenant_id,store_id,return_id) REFERENCES purchase_returns(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,receipt_id) REFERENCES documents(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,product_id) REFERENCES products(tenant_id,id)
);
CREATE TABLE purchase_evidence (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,store_id uuid NOT NULL,invoice_id uuid NOT NULL,
 object_key text NOT NULL,bytes integer NOT NULL CHECK(bytes BETWEEN 1 AND 10485760),
 sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),body jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),actor_id uuid NOT NULL,
 UNIQUE(tenant_id,store_id,invoice_id,id),UNIQUE(object_key),
 FOREIGN KEY(tenant_id,store_id,invoice_id) REFERENCES purchase_invoices(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES staff(tenant_id,id),
 CHECK(object_key LIKE tenant_id::text || '/finance/evidence/%')
);
CREATE TABLE purchase_supplier_confirmations (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,store_id uuid NOT NULL,invoice_id uuid NOT NULL,
 snapshot_sha256 text NOT NULL CHECK(snapshot_sha256 ~ '^[0-9a-f]{64}$'),evidence_id uuid NOT NULL,
 body jsonb NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),actor_id uuid NOT NULL,
 FOREIGN KEY(tenant_id,store_id,invoice_id) REFERENCES purchase_invoices(tenant_id,store_id,id),
 FOREIGN KEY(tenant_id,store_id,invoice_id,evidence_id) REFERENCES purchase_evidence(tenant_id,store_id,invoice_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES staff(tenant_id,id)
);
CREATE TABLE purchase_export_snapshots (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,store_id uuid NOT NULL,
 format text NOT NULL CHECK(format IN ('purchase-invoice-pdf','purchase-finance-bundle','payables-csv','purchase-payments-csv')),
 status text NOT NULL CHECK(status IN ('queued','running','completed','failed')),source jsonb NOT NULL,
 source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[0-9a-f]{64}$'),as_of timestamptz NOT NULL,observed_at timestamptz NOT NULL,
 body jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),actor_id uuid NOT NULL,
 FOREIGN KEY(tenant_id,store_id) REFERENCES stores(tenant_id,id),FOREIGN KEY(tenant_id,actor_id) REFERENCES staff(tenant_id,id)
);

CREATE FUNCTION finance_invoice_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id OR NEW.store_id<>OLD.store_id OR NEW.supplier_id<>OLD.supplier_id
 OR NEW.internal_reference<>OLD.internal_reference OR NEW.predecessor_invoice_id IS DISTINCT FROM OLD.predecessor_invoice_id
 OR NEW.created_at<>OLD.created_at OR NEW.supplier_snapshot<>OLD.supplier_snapshot OR NEW.version<>OLD.version+1
 THEN RAISE EXCEPTION 'immutable invoice identity'; END IF;
 IF OLD.state<>'draft' AND (NEW.draft<>OLD.draft OR NEW.posted_snapshot_sha256 IS DISTINCT FROM OLD.posted_snapshot_sha256 OR NEW.posted_snapshot_version IS DISTINCT FROM OLD.posted_snapshot_version OR NEW.revision<>OLD.revision)
 THEN RAISE EXCEPTION 'immutable posted invoice source'; END IF;
 IF NOT ((OLD.state='draft' AND NEW.state IN ('draft','cancelled','posted')) OR (OLD.state='posted' AND NEW.state IN ('posted','voided')) OR (OLD.state='voided' AND NEW.state='voided'))
 THEN RAISE EXCEPTION 'invalid invoice state transition'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER purchase_invoice_guard BEFORE UPDATE ON purchase_invoices FOR EACH ROW EXECUTE FUNCTION finance_invoice_guard();
CREATE FUNCTION finance_export_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.status IN ('completed','failed') OR NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id OR NEW.store_id<>OLD.store_id
 OR NEW.source<>OLD.source OR NEW.source_sha256<>OLD.source_sha256 OR NEW.format<>OLD.format OR NEW.as_of<>OLD.as_of OR NEW.observed_at<>OLD.observed_at
 THEN RAISE EXCEPTION 'immutable finance export source'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER purchase_export_guard BEFORE UPDATE ON purchase_export_snapshots FOR EACH ROW EXECUTE FUNCTION finance_export_guard();

DO $$ DECLARE table_name text; BEGIN
 FOREACH table_name IN ARRAY ARRAY['purchase_suppliers','purchase_supplier_links','purchase_invoices','purchase_invoice_identity','purchase_invoice_snapshots','purchase_invoice_allocations','purchase_ledger','purchase_finance_facts','purchase_returns','purchase_return_lines','purchase_evidence','purchase_supplier_confirmations','purchase_export_snapshots'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
  IF table_name='purchase_suppliers' THEN
   EXECUTE format('CREATE POLICY finance_isolation ON %I USING(finance_visible(tenant_id,NULL)) WITH CHECK(finance_visible(tenant_id,NULL))',table_name);
  ELSE
   EXECUTE format('CREATE POLICY finance_isolation ON %I USING(finance_visible(tenant_id,store_id)) WITH CHECK(finance_visible(tenant_id,store_id))',table_name);
  END IF;
  EXECUTE format('GRANT SELECT,INSERT ON %I TO regi_app',table_name);
  IF table_name IN ('purchase_suppliers','purchase_invoices','purchase_export_snapshots') THEN
   EXECUTE format('GRANT UPDATE ON %I TO regi_app',table_name);
  ELSE
   EXECUTE format('CREATE TRIGGER purchase_fact_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION prevent_fact_mutation()',table_name);
  END IF;
 END LOOP;
END $$;
