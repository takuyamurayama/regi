import {test} from 'node:test';
import assert from 'node:assert/strict';
import {paymentShares,yen} from '../apps/web/src/presentation';

test('payment shares reflect actual totals, including zero and absent methods',()=>{
 assert.deepEqual(paymentShares().map(entry=>entry.share),[0,0,0]);
 assert.deepEqual(paymentShares({cash:'0',card:'0',qr:'0'}).map(entry=>entry.share),[0,0,0]);
 assert.deepEqual(paymentShares({cash:'100',card:'200',qr:'100'}).map(entry=>entry.share),[25,50,25]);
 assert.deepEqual(paymentShares({card:'42'}).map(entry=>entry.share),[0,100,0]);
});

test('payment proportions retain integer precision beyond Number.MAX_SAFE_INTEGER',()=>{
 const payments={cash:'9007199254740993000',card:'18014398509481986000',qr:'9007199254740993000'};
 assert.deepEqual(paymentShares(payments).map(entry=>entry.share),[25,50,25]);
 assert.deepEqual(paymentShares(payments).map(entry=>entry.amount),Object.values(payments));
 assert.deepEqual(paymentShares({cash:'1',card:'2',qr:'3'}).map(entry=>entry.share),[16.66,33.33,50]);
});

test('yen display preserves integer amounts, negative amounts and grouping',()=>{
 assert.equal(yen('9007199254740993'),'¥9,007,199,254,740,993');
 assert.equal(yen('1234567'),'¥1,234,567');
 assert.equal(yen('-1234'),'¥-1,234');
 assert.equal(yen('0'),'¥0');
});
