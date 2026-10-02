import json
import uuid
import unittest

import host_backup_test as original

backup = original.backup


class FinanceBackupPostgresTests(unittest.TestCase):
    """One real PostgreSQL 17 round trip beyond the frozen D0 backup tests."""

    tearDown = original.BackupPostgresTests.tearDown
    cli = original.BackupPostgresTests.cli
    record_databases = original.BackupPostgresTests.record_databases
    make_backup = original.BackupPostgresTests.make_backup
    journal = original.BackupPostgresTests.journal

    def setUp(self):
        original.BackupPostgresTests.setUp(self)
        path = original.ROOT / "apps/api/prisma/migrations/008_purchase_finance/migration.sql"
        self.tools.sql(self.database, "BEGIN; SET LOCAL ROLE regi_owner;\n" + path.read_text() +
                       "\nINSERT INTO regi_migrations VALUES('008'," +
                       backup.literal(backup.sha256_file(path)) + "); COMMIT;")
        self.config["migrationDirectory"] = str(original.ROOT / "apps/api/prisma/migrations")
        backup.private_json(self.configuration, self.config)
        party = self.tools.query(self.database, "SELECT jsonb_build_object('store',s.id,'staff',a.id) FROM stores s JOIN staff a ON a.tenant_id=s.tenant_id WHERE s.tenant_id=" + backup.literal(self.tenant) + "::uuid LIMIT 1;")
        names = ["supplier", "invoice", "product", "order", "receipt", "evidence", "debit",
                 "payment", "payment_ledger", "inverse", "inverse_ledger", "returned", "return_inverse"]
        identifiers = {name: str(uuid.uuid4()) for name in names}
        identifiers.update(tenant=self.tenant, store=party["store"], staff=party["staff"])
        value = {name: backup.literal(identifier) for name, identifier in identifiers.items()}
        self.invoice = identifiers["invoice"]
        source = backup.literal(json.dumps({"fixture": "synthetic immutable original", "gross": "5280000"}))
        self.tools.sql(self.database, f"""
        INSERT INTO products(id,tenant_id,sku,name,stock_managed,cost) VALUES({value['product']},{value['tenant']},'BACKUP-FINANCE','synthetic finance',true,50);
        INSERT INTO documents(id,tenant_id,store_id,kind,status,body,actor_id) VALUES
          ({value['order']},{value['tenant']},{value['store']},'purchase-order','issued','{{}}',{value['staff']}),
          ({value['receipt']},{value['tenant']},{value['store']},'receipt','confirmed','{{}}',{value['staff']});
        INSERT INTO purchase_suppliers(id,tenant_id,code,body,active) VALUES({value['supplier']},{value['tenant']},'BACKUP-FINANCE','{{"name":"synthetic supplier"}}',true);
        INSERT INTO purchase_supplier_links(id,tenant_id,store_id,order_id,supplier_id,body,actor_id) VALUES(gen_random_uuid(),{value['tenant']},{value['store']},{value['order']},{value['supplier']},'{{"originalSupplierText":"original supplier"}}',{value['staff']});
        INSERT INTO purchase_invoices(id,tenant_id,store_id,supplier_id,state,draft,supplier_snapshot,internal_reference,posted_snapshot_sha256,posted_snapshot_version)
          VALUES({value['invoice']},{value['tenant']},{value['store']},{value['supplier']},'posted',{source},'{{"name":"original supplier"}}','BACKUP-FINANCE-ORIGINAL',repeat('a',64),2);
        INSERT INTO purchase_invoice_identity(tenant_id,store_id,supplier_id,identity_key,revision,invoice_id) VALUES({value['tenant']},{value['store']},{value['supplier']},'original-source-001',1,{value['invoice']});
        INSERT INTO purchase_invoice_snapshots(invoice_id,tenant_id,store_id,version,sha256,content,preview,supplier_snapshot,effective_at,actor_id)
          VALUES({value['invoice']},{value['tenant']},{value['store']},2,repeat('a',64),{source},'{{"gross":"5280000"}}','{{"name":"original supplier"}}',now(),{value['staff']});
        INSERT INTO purchase_invoice_allocations(id,tenant_id,store_id,invoice_id,invoice_line_no,receipt_id,receipt_line_index,quantity)
          VALUES(gen_random_uuid(),{value['tenant']},{value['store']},{value['invoice']},1,{value['receipt']},0,1);
        INSERT INTO purchase_ledger(id,tenant_id,store_id,invoice_id,kind,amount,fact_id,reversal_of,occurred_at,actor_id) VALUES
          ({value['debit']},{value['tenant']},{value['store']},{value['invoice']},'invoice-debit',5280000,{value['invoice']},null,now(),{value['staff']}),
          ({value['payment_ledger']},{value['tenant']},{value['store']},{value['invoice']},'payment',1000,{value['payment']},null,now(),{value['staff']}),
          ({value['inverse_ledger']},{value['tenant']},{value['store']},{value['invoice']},'payment-reversal',1000,{value['inverse']},{value['payment_ledger']},now(),{value['staff']});
        INSERT INTO purchase_finance_facts(id,tenant_id,store_id,invoice_id,supplier_id,kind,amount,body,ledger_id,reversal_of,occurred_at,actor_id) VALUES
          ({value['payment']},{value['tenant']},{value['store']},{value['invoice']},{value['supplier']},'payment',1000,'{{"reference":"synthetic payment original"}}',{value['payment_ledger']},null,now(),{value['staff']}),
          ({value['inverse']},{value['tenant']},{value['store']},{value['invoice']},{value['supplier']},'payment',1000,'{{"reference":"synthetic inverse"}}',{value['inverse_ledger']},{value['payment']},now(),{value['staff']});
        INSERT INTO purchase_returns(id,tenant_id,store_id,invoice_id,supplier_id,body,reversal_of,occurred_at,actor_id,reason) VALUES
          ({value['returned']},{value['tenant']},{value['store']},{value['invoice']},{value['supplier']},'{{}}',null,now(),{value['staff']},'synthetic returned'),
          ({value['return_inverse']},{value['tenant']},{value['store']},{value['invoice']},{value['supplier']},'{{}}',{value['returned']},now(),{value['staff']},'synthetic reversal');
        INSERT INTO purchase_return_lines(return_id,tenant_id,store_id,line_no,receipt_id,receipt_line_index,product_id,quantity) VALUES
          ({value['returned']},{value['tenant']},{value['store']},1,{value['receipt']},0,{value['product']},1),
          ({value['return_inverse']},{value['tenant']},{value['store']},1,{value['receipt']},0,{value['product']},1);
        INSERT INTO purchase_evidence(id,tenant_id,store_id,invoice_id,object_key,bytes,sha256,body,actor_id)
          VALUES({value['evidence']},{value['tenant']},{value['store']},{value['invoice']},{backup.literal(self.tenant + '/finance/evidence/' + identifiers['evidence'])},10,repeat('b',64),'{{"originalName":"original.png"}}',{value['staff']});
        INSERT INTO purchase_supplier_confirmations(id,tenant_id,store_id,invoice_id,snapshot_sha256,evidence_id,body,actor_id)
          VALUES(gen_random_uuid(),{value['tenant']},{value['store']},{value['invoice']},repeat('a',64),{value['evidence']},'{{"counterpartyName":"synthetic party"}}',{value['staff']});
        INSERT INTO purchase_export_snapshots(id,tenant_id,store_id,format,status,source,source_sha256,as_of,observed_at,body,actor_id)
          VALUES(gen_random_uuid(),{value['tenant']},{value['store']},'purchase-finance-bundle','queued',{source},repeat('c',64),now(),now(),'{{}}',{value['staff']});
        """)

    def test_finance_all_thirteen_tables_sources_and_signed_inverses_survive_real_pg_dump_restore(self):
        manifest = self.make_backup()
        tables = sorted(name for name in manifest["database"]["counts"] if name.startswith("purchase_"))
        self.assertEqual(len(tables), 13)
        self.assertEqual(len(manifest["database"]["migrations"]), 9)
        for table in tables:
            self.assertGreater(manifest["database"]["counts"][table], 0, table)
        self.assertEqual(manifest["database"]["counts"]["purchase_ledger"], 3)
        self.cli("restore", (self.dump, "--verify-only"))
        candidate = self.journal()["candidate_database"]
        for table in tables:
            query = "SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) FROM " + backup.identifier(table) + " t;"
            self.assertEqual(self.tools.query(candidate, query), self.tools.query(self.database, query), table)
        security = self.tools.query(candidate, "SELECT jsonb_build_object('count',count(*),'forced',bool_and(relforcerowsecurity)) FROM pg_class WHERE relname LIKE 'purchase_%' AND relkind='r';")
        self.assertEqual(security, {"count": 13, "forced": True})
        ledger = self.tools.query(candidate, "SELECT jsonb_agg(signed_amount::text ORDER BY kind) FROM purchase_ledger;")
        self.assertEqual(ledger, ["5280000", "-1000", "1000"])
        self.assertEqual(manifest["dump_sha256"], backup.sha256_file(self.dump))


if __name__ == "__main__":
    unittest.main()
