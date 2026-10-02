import { Body, Controller, Get, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Business } from './service';
import { Ai } from './ai';
import { Artifacts } from './artifacts';
import { Administration } from './admin';
import { Imports } from './import';
import { Recommendations } from './recommendations';
@ApiTags('REGI')
@ApiBearerAuth()
@Controller()
export class Api {
 constructor(private readonly business:Business,private readonly ai:Ai,private readonly artifacts:Artifacts,private readonly administration:Administration,private readonly imports:Imports,private readonly recommendations:Recommendations) {}
 @Post('v1/products/import') importProducts(@Req() request:any,@Body() body:any){return this.imports.products(request.actor,body);}
 @Post('v1/ai/reorder-policy') policy(@Req() request:any,@Body() body:any){return this.recommendations.policy(request.actor,body);}
 @Get('v1/ai/recommendations') recommended(@Req() request:any,@Query('storeId') storeId:string){return this.recommendations.list(request.actor,storeId);}
 @Post('v1/settings/:action') configure(@Req() request:any,@Param('action') action:string,@Body() body:any){return this.administration.execute(request.actor,action,body);}
 @Get('health') health(){return {status:'ok',product:'REGI',ruleVersion:'regi-1'};}
 @Get('v1/settings') settings(@Req() request:any){return this.business.settings(request.actor);}
 @Get('v1/products') products(@Req() request:any){return this.business.products(request.actor);}
 @Post('v1/products') product(@Req() request:any,@Body() body:any){return this.business.saveProduct(request.actor,body);}
 @Patch('v1/products/:id') updateProduct(@Req() request:any,@Param('id') id:string,@Body() body:any){return this.business.saveProduct(request.actor,body,id);}
 @Post('v1/devices/enroll') enroll(@Req() request:any,@Body() body:any){return this.business.enroll(request.actor,body);}
 @Post('v1/devices/:id/status') deviceStatus(@Req() request:any,@Param('id') id:string,@Body() body:any){return this.business.deviceStatus(request.actor,id,body);}
 @Get('v1/sync/bootstrap') bootstrap(@Req() request:any,@Query('deviceId') id:string){return this.business.bootstrap(request.actor,id);}
 @Post('v1/devices/:id/lease') lease(@Req() request:any,@Param('id') id:string){return this.business.renewLease(request.actor,id);}
 @Get('v1/sync/changes') changes(@Req() request:any,@Query('cursor') cursor='0'){return this.business.changes(request.actor,cursor);}
 @Post('v1/sync/events') events(@Req() request:any,@Body() body:any){return this.business.events(request.actor,body);}
 @Get('v1/sync/reviews') reviews(@Req() request:any,@Query('storeId') storeId:string){return this.business.reviews(request.actor,storeId);}
 @Post('v1/sync/reviews/:id/retry') retryReview(@Req() request:any,@Param('id') id:string,@Body() body:any){return this.business.retryReview(request.actor,id,body);}
 @Get('v1/documents/:kind') list(@Req() request:any,@Param('kind') kind:string,@Query('storeId') storeId?:string,@Query('q') query=''){return this.business.list(request.actor,kind,storeId,query);}
 @Get('v1/sales/:id/returnable') returnable(@Req() request:any,@Param('id') id:string){return this.business.returnable(request.actor,id);}
 @Post('v1/refunds') refund(@Req() request:any,@Body() body:any){return this.business.refund(request.actor,body);}
 @Post('v1/refunds/:id/confirm') refundConfirm(@Req() request:any,@Param('id') id:string,@Body() body:any){return this.business.confirmRefund(request.actor,id,body);}
 @Post('v1/purchase-orders') purchase(@Req() request:any,@Body() body:any){return this.business.purchase(request.actor,body);}
 @Post('v1/purchase-orders/:id/approve') approve(@Req() request:any,@Param('id') id:string,@Body() body:any){return this.business.purchaseAction(request.actor,id,body,'approve');}
 @Post('v1/purchase-orders/:id/issue') issue(@Req() request:any,@Param('id') id:string,@Body() body:any){return this.business.purchaseAction(request.actor,id,body,'issue');}
 @Post('v1/purchase-orders/:id/revise') revise(@Req() request:any,@Param('id') id:string,@Body() body:any){return this.business.purchaseAction(request.actor,id,body,'revise');}
 @Post('v1/purchase-orders/:id/receipts') receipt(@Req() request:any,@Param('id') id:string,@Body() body:any){return this.business.receipt(request.actor,id,body);}
 @Post('v1/receipts/:id/cancel') cancel(@Req() request:any,@Param('id') id:string,@Body() body:any){return this.business.cancelReceipt(request.actor,id,body);}
 @Get('v1/inventory') inventory(@Req() request:any,@Query('storeId') storeId?:string){return this.business.inventory(request.actor,storeId);}
 @Post('v1/inventory/adjustments') adjustment(@Req() request:any,@Body() body:any){return this.business.adjust(request.actor,body);}
 @Post('v1/stocktakes') stocktake(@Req() request:any,@Body() body:any){return this.business.stocktake(request.actor,body);}
 @Post('v1/stocktakes/:id/confirm') stocktakeConfirm(@Req() request:any,@Param('id') id:string,@Body() body:any){return this.business.confirmStocktake(request.actor,id,body);}
 @Post('v1/transfers') transfer(@Req() request:any,@Body() body:any){return this.business.transfer(request.actor,body);}
 @Post('v1/transfers/:id/receive') receive(@Req() request:any,@Param('id') id:string,@Body() body:any){return this.business.receiveTransfer(request.actor,id,body);}
 @Post('v1/shifts') shift(@Req() request:any,@Body() body:any){return this.business.openShift(request.actor,body);}
 @Post('v1/shifts/:id/close') close(@Req() request:any,@Param('id') id:string,@Body() body:any){return this.business.closeShift(request.actor,id,body);}
 @Post('v1/cash-movements') cash(@Req() request:any,@Body() body:any){return this.business.cash(request.actor,body);}
 @Post('v1/day-closes') dayClose(@Req() request:any,@Body() body:any){return this.business.dayClose(request.actor,body);}
 @Get('v1/reports/sales') report(@Req() request:any,@Query('storeId') storeId?:string,@Query('from') from?:string,@Query('to') to?:string){return this.business.report(request.actor,storeId,from,to);}
 @Post('v1/ai/query') aiQuery(@Req() request:any,@Body() body:any){return this.ai.query(request.actor,body);}
 @Get('v1/ai/forecasts') forecasts(@Req() request:any,@Query('storeId') storeId:string){return this.ai.forecasts(request.actor,storeId);}
 @Post('v1/exports') async export(@Req() request:any,@Body() body:any){const job=await this.artifacts.request(request.actor,body);if(!process.env.EXPORT_QUEUE_URL)setImmediate(()=>this.artifacts.tick(request.actor));return job;}
 @Get('v1/exports/:id/download') async download(@Req() request:any,@Param('id') id:string,@Res() response:any){const result=await this.artifacts.download(request.actor,id);response.setHeader('Content-Type',result.extension==='pdf'?'application/pdf':result.extension==='tar.gz'?'application/gzip':'text/csv; charset=utf-8');response.setHeader('Content-Disposition',`attachment; filename="regi-${id}.${result.extension}"`);response.send(result.bytes);}
}
