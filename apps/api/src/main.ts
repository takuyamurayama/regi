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
@Module({controllers:[Api],providers:[Database,Business,Auth,Ai,Artifacts,Administration,Imports,Recommendations]})
class App {}
async function main(){
 if(process.env.REGI_DEV_AUTH==='true'&&!['development','test'].includes(process.env.NODE_ENV??''))throw new Error('Development auth cannot run in production');
 const app=await NestFactory.create(App);
 app.enableCors({origin:process.env.WEB_ORIGIN??'http://localhost:5173'});app.useGlobalGuards(app.get(Auth));app.useGlobalFilters(new Errors());
 app.getHttpAdapter().getInstance().set('json replacer',(_:string,value:any)=>typeof value==='bigint'?value.toString():value);
 const document=enrich(SwaggerModule.createDocument(app,new DocumentBuilder().setTitle('REGI API').setVersion('1.0').addBearerAuth().build()));
 SwaggerModule.setup('openapi',app,document);mkdirSync('docs',{recursive:true});writeFileSync('docs/openapi.json',json(document));
 app.enableShutdownHooks();await app.listen(Number(process.env.PORT??3000),'0.0.0.0');
}
main().catch(error=>{console.error(error);process.exit(1);});
