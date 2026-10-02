import 'reflect-metadata';
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Database, Actor, rows, sql } from './db';
import { Business } from './service';
import { Artifacts } from './artifacts';
import { Ai } from './ai';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
async function main() {
  const database = new Database(),
    business = new Business(database),
    artifacts = new Artifacts(business),
    ai = new Ai(business);
  await database.onModuleInit();
  const queue = new SQSClient({ region: process.env.AWS_REGION });
  const scopes: Actor[] = JSON.parse(process.env.WORKER_SCOPES ?? '[]');
  if (process.env.NODE_ENV === 'production' && !process.env.EXPORT_QUEUE_URL)
    throw new Error('SQS configuration required');
  while (true) {
    if (process.env.EXPORT_QUEUE_URL) {
      const result = await queue.send(
        new ReceiveMessageCommand({
          QueueUrl: process.env.EXPORT_QUEUE_URL,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 20,
          VisibilityTimeout: 120,
        }),
      );
      for (const message of result.Messages ?? [])
        try {
          const job = JSON.parse(message.Body ?? '{}'),
            candidate: Actor = {
              tenantId: job.tenantId,
              staffId: job.staffId,
              role: 'cashier',
              stores: [],
              mfa: true,
            };
          const [staff] = await database.transaction(candidate, (transaction) =>
            rows(
              transaction,
              sql`SELECT role,stores FROM staff WHERE id=${candidate.staffId}::uuid AND active`,
            ),
          );
          if (!staff) throw new Error('Worker actor revoked');
          await artifacts.process({ ...candidate, role: staff.role, stores: staff.stores }, job.id);
          await queue.send(
            new DeleteMessageCommand({
              QueueUrl: process.env.EXPORT_QUEUE_URL,
              ReceiptHandle: message.ReceiptHandle,
            }),
          );
        } catch (error: any) {
          console.error('Queue job failed', message.MessageId, error.message);
        }
    }
    for (const scope of scopes)
      try {
        const [staff] = await database.transaction(
          { ...scope, role: 'cashier', stores: [] },
          (transaction) =>
            rows(
              transaction,
              sql`SELECT role,stores FROM staff WHERE id=${scope.staffId}::uuid AND active`,
            ),
        );
        if (!staff) continue;
        const actor = { ...scope, role: staff.role, stores: staff.stores };
        await artifacts.tick(actor);
        await ai.recover(actor);
        const stores = await database.transaction(actor, (transaction) =>
          rows(transaction, sql`SELECT id FROM stores`),
        );
        if (process.env.DAILY_JOBS === 'true')
          for (const { id: storeId } of stores) {
            const [closed] = await database.transaction(actor, (transaction) =>
              rows(
                transaction,
                sql`SELECT body->>'day' AS day FROM documents WHERE kind='day-close' AND status='confirmed' AND store_id=${storeId}::uuid ORDER BY body->>'day' DESC LIMIT 1`,
              ),
            );
            if (!closed) continue;
            const [forecast] = await database.transaction(actor, (transaction) =>
              rows(
                transaction,
                sql`SELECT id FROM documents WHERE kind='forecast-run' AND store_id=${storeId}::uuid AND body->>'day'=${closed.day}`,
              ),
            );
            if (!forecast) {
              await promisify(execFile)(
                process.env.PYTHON_EXECUTABLE ?? 'python3',
                ['forecast/regi_forecast.py', '--tenant', actor.tenantId, '--store', storeId],
                { timeout: 3600000 },
              );
              await database.transaction(actor, (transaction) =>
                business.createDocument(
                  transaction,
                  actor,
                  'forecast-run',
                  'completed',
                  { day: closed.day, generatedAt: new Date().toISOString() },
                  storeId,
                ),
              );
            }
            const [daily] = await database.transaction(actor, (transaction) =>
              rows(
                transaction,
                sql`SELECT id FROM documents WHERE kind='ai-query' AND status='completed' AND store_id=${storeId}::uuid AND body->'plan'->>'metric'='daily' AND body->>'from'=${closed.day}`,
              ),
            );
            if (!daily && process.env.BEDROCK_PROFILE_ID)
              await ai.daily(actor, storeId, closed.day);
          }
      } catch (error: any) {
        console.error('Scheduled job failed', scope.tenantId, error.message);
      }
    if (!process.env.EXPORT_QUEUE_URL) await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
