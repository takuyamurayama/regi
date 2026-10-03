import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { Database } from './db';
import { Business, json } from './service';
import { Api } from './controller';
import { Auth } from './auth';
import { Errors } from './errors';
import { Ai } from './ai';
import { Artifacts } from './artifacts';
import { Administration } from './admin';
import { Imports } from './import';
import { Recommendations } from './recommendations';
import { enrich } from './openapi';
import { mkdirSync, writeFileSync } from 'node:fs';
import { json as jsonParser } from 'express';
import { Finance } from './finance';
import { FinanceFiles } from './finance-files';
import { FinanceApi } from './finance-controller';
import { FinanceExports } from './finance-exports';
@Module({
  controllers: [Api, FinanceApi],
  providers: [
    Database,
    Business,
    Auth,
    Ai,
    Artifacts,
    Administration,
    Imports,
    Recommendations,
    Finance,
    FinanceFiles,
    FinanceExports,
  ],
})
class App {}
export async function createApp(options: { writeOpenapi?: boolean } = {}) {
  if (
    process.env.REGI_DEV_AUTH === 'true' &&
    !['development', 'test'].includes(process.env.NODE_ENV ?? '')
  )
    throw new Error('Development auth cannot run in production');
  const app = await NestFactory.create(App, { bodyParser: false });
  app.use('/v1/sync/events', jsonParser({ limit: '4mb' }));
  app.use('/v1/products/import', jsonParser({ limit: '5mb' }));
  app.use('/v1/purchase-invoices', jsonParser({ limit: '1mb' }));
  app.use(jsonParser({ limit: '256kb' }));
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173' });
  app.useGlobalGuards(app.get(Auth));
  app.useGlobalFilters(new Errors());
  app
    .getHttpAdapter()
    .getInstance()
    .set('json replacer', (_: string, value: any) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
  const document = enrich(
    SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('REGI API').setVersion('1.0').addBearerAuth().build(),
    ),
  );
  SwaggerModule.setup('openapi', app, document);
  if (options.writeOpenapi !== false) {
    mkdirSync('docs', { recursive: true });
    writeFileSync('docs/openapi.json', json(document));
  }
  app.enableShutdownHooks();
  return app;
}
async function main() {
  const app = await createApp();
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}
if (require.main === module)
  void main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
