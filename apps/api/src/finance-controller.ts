import { Body, Controller, Get, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Actor } from './db';
import { Finance, financeParse } from './finance';
import { evidenceLimit } from './finance-files';
import { BusinessError, requireRule } from './errors';
import { EvidenceUploadMetadataSchema } from '../../../packages/core/src/finance';
import { FinanceExports } from './finance-exports';

type FinanceRequest = Request & { actor: Actor };
@Controller('v1')
export class FinanceApi {
  constructor(
    private readonly finance: Finance,
    private readonly exports: FinanceExports,
  ) {}
  @Get('purchase-exports/:id') exportStatus(
    @Req() request: FinanceRequest,
    @Param('id') id: string,
    @Query('storeId') storeId: unknown,
  ) {
    return this.exports.get(request.actor, id, storeId);
  }
  @Post('purchase-orders/:id/supplier-link') linkSupplier(
    @Req() request: FinanceRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.finance.linkSupplier(request.actor, id, body);
  }
  @Post('purchase-invoices/:id/cancel') cancel(
    @Req() request: FinanceRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.finance.cancelOrVoid(request.actor, id, body, 'cancel');
  }
  @Post('purchase-invoices/:id/void') void(
    @Req() request: FinanceRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.finance.cancelOrVoid(request.actor, id, body, 'void');
  }
  @Post('purchase-invoices/:id/confirm-supplier') confirmSupplier(
    @Req() request: FinanceRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.finance.confirmSupplier(request.actor, id, body);
  }
  @Post('purchase-invoices/:id/credit-preview') creditPreview(
    @Req() request: FinanceRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.finance.creditPreview(request.actor, id, body);
  }
  @Get('purchase-credits') credits(@Req() request: FinanceRequest, @Query() query: unknown) {
    return this.finance.credits(request.actor, query);
  }
  @Post('purchase-credits') credit(@Req() request: FinanceRequest, @Body() body: unknown) {
    return this.finance.credit(request.actor, body);
  }
  @Post('purchase-credits/:id/reverse') reverseCredit(
    @Req() request: FinanceRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.finance.reverseCredit(request.actor, id, body);
  }
  @Get('purchase-returns') returns(@Req() request: FinanceRequest, @Query() query: unknown) {
    return this.finance.returns(request.actor, query);
  }
  @Post('purchase-returns') returnGoods(@Req() request: FinanceRequest, @Body() body: unknown) {
    return this.finance.returnGoods(request.actor, body);
  }
  @Post('purchase-returns/:id/reverse') reverseReturn(
    @Req() request: FinanceRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.finance.reverseReturn(request.actor, id, body);
  }
  @Get('purchase-receipts/available') receiptCandidates(
    @Req() request: FinanceRequest,
    @Query() query: unknown,
  ) {
    return this.finance.receiptCandidates(request.actor, query);
  }
  @Get('suppliers') suppliers(@Req() request: FinanceRequest, @Query() query: unknown) {
    return this.finance.suppliers(request.actor, query);
  }
  @Post('suppliers') supplier(@Req() request: FinanceRequest, @Body() body: unknown) {
    return this.finance.saveSupplier(request.actor, body);
  }
  @Patch('suppliers/:id') editSupplier(
    @Req() request: FinanceRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.finance.saveSupplier(request.actor, body, id);
  }
  @Get('purchase-invoices') invoices(@Req() request: FinanceRequest, @Query() query: unknown) {
    return this.finance.invoices(request.actor, query);
  }
  @Post('purchase-invoices') createInvoice(@Req() request: FinanceRequest, @Body() body: unknown) {
    return this.finance.saveInvoice(request.actor, body);
  }
  @Post('purchase-invoices/preview') preview(
    @Req() request: FinanceRequest,
    @Body() body: unknown,
  ) {
    return this.finance.preview(request.actor, body);
  }
  @Get('purchase-invoices/:id') invoice(
    @Req() request: FinanceRequest,
    @Param('id') id: string,
    @Query('storeId') storeId: unknown,
  ) {
    return this.finance.invoice(request.actor, id, storeId);
  }
  @Patch('purchase-invoices/:id') editInvoice(
    @Req() request: FinanceRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.finance.saveInvoice(request.actor, body, id);
  }
  @Post('purchase-invoices/:id/post') post(
    @Req() request: FinanceRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.finance.post(request.actor, id, body);
  }
  @Post('purchase-invoices/:id/evidence') async evidence(
    @Req() request: FinanceRequest,
    @Param('id') id: string,
  ) {
    let name: string, note: string;
    try {
      name = decodeURIComponent(String(request.headers['x-regi-evidence-name'] ?? ''));
      note = decodeURIComponent(String(request.headers['x-regi-evidence-note'] ?? ''));
    } catch {
      throw new BusinessError('INVALID_INPUT', 'ファイル名・説明の文字形式を確認してください', 400);
    }
    const metadata = financeParse(EvidenceUploadMetadataSchema, {
      operationId: request.headers['x-regi-operation-id'],
      storeId: request.headers['x-regi-store-id'],
      invoiceVersion: Number(request.headers['x-regi-invoice-version']),
      originalName: name,
      mediaType: request.headers['content-type'],
      role: request.headers['x-regi-evidence-role'],
      method: request.headers['x-regi-evidence-method'],
      note,
    });
    this.finance.authorize(request.actor, metadata.storeId);
    // Authenticate and authorize before consuming the raw body; JSON parsing never handles evidence.
    const length = request.headers['content-length'];
    if (length !== undefined)
      requireRule(
        Number(length) <= evidenceLimit,
        'PAYLOAD_TOO_LARGE',
        '証憑は10MiB以内で送信してください',
        413,
      );
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const raw of request) {
      const chunk: unknown = raw;
      requireRule(
        Buffer.isBuffer(chunk),
        'EVIDENCE_FORMAT',
        'ファイルをバイナリで送信してください',
        400,
      );
      size += chunk.length;
      requireRule(
        size <= evidenceLimit,
        'PAYLOAD_TOO_LARGE',
        '証憑は10MiB以内で送信してください',
        413,
      );
      chunks.push(chunk);
    }
    return this.finance.evidence(request.actor, id, metadata, Buffer.concat(chunks, size));
  }
  @Get('purchase-invoices/:id/evidence/:evidenceId/download') async download(
    @Req() request: FinanceRequest,
    @Param('id') id: string,
    @Param('evidenceId') evidenceId: string,
    @Query('storeId') storeId: unknown,
    @Res() response: Response,
  ) {
    const result = await this.finance.downloadEvidence(request.actor, id, evidenceId, storeId);
    response.setHeader('Content-Type', result.mediaType);
    response.setHeader('Content-Length', result.bytes.length);
    response.setHeader(
      'Content-Disposition',
      "attachment; filename*=UTF-8''" + encodeURIComponent(result.name),
    );
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('ETag', '"' + result.sha256 + '"');
    response.send(result.bytes);
  }
  @Get('payables') payables(@Req() request: FinanceRequest, @Query() query: unknown) {
    return this.finance.payables(request.actor, query);
  }
  @Get('purchase-payments') payments(@Req() request: FinanceRequest, @Query() query: unknown) {
    return this.finance.facts(request.actor, query, 'payment');
  }
  @Post('purchase-payments') payment(@Req() request: FinanceRequest, @Body() body: unknown) {
    return this.finance.settle(request.actor, body, 'payment');
  }
  @Post('purchase-payments/:id/reverse') reversePayment(
    @Req() request: FinanceRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.finance.reverseSettlement(request.actor, id, body, 'payment');
  }
  @Get('purchase-refunds') refunds(@Req() request: FinanceRequest, @Query() query: unknown) {
    return this.finance.facts(request.actor, query, 'refund');
  }
  @Post('purchase-refunds') refund(@Req() request: FinanceRequest, @Body() body: unknown) {
    return this.finance.settle(request.actor, body, 'refund');
  }
  @Post('purchase-refunds/:id/reverse') reverseRefund(
    @Req() request: FinanceRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.finance.reverseSettlement(request.actor, id, body, 'refund');
  }
}
