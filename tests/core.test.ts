import {test} from 'node:test';
import assert from 'node:assert/strict';
import fixtures from './fixtures/money.json';
import {allocate,businessDate,calculate,money,offlineAllowed,LineInput} from '../packages/core/src';
import {csv} from '../apps/api/src/artifacts';
import {parseCsv} from '../packages/core/src/csv';
for(const fixture of fixtures)test(fixture.name,()=>{
 const result=calculate(fixture.lines,fixture.discount,fixture.mode as any);
 assert.equal(result.total,fixture.total);assert.deepEqual(result.lines.map(line=>line.paid),fixture.paid);assert.deepEqual(result.taxes.map(tax=>tax.tax),fixture.tax);
});
test('10000 seeded monetary conservation cases',()=>{
 let seed=7391;const random=(max:number)=>{seed=(seed*1664525+1013904223)>>>0;return seed%max;};
 for(let iteration=0;iteration<10000;iteration++){
  const lines:LineInput[]=Array.from({length:1+random(10)},(_,index)=>({productId:String(index),name:'商品',quantity:1+random(10),price:String(random(100000)),discount:'0',rateBps:[0,800,1000,1200][random(4)],cost:'0',stockManaged:true}));
  const subtotal=lines.reduce((sum,line)=>sum+money(line.price)*BigInt(line.quantity),0n),discount=BigInt(random(Number(subtotal+1n)));
  const result=calculate(lines,discount.toString(),random(2)?'inclusive':'exclusive');
  assert.equal(result.lines.reduce((sum,line)=>sum+money(line.allocatedDiscount),0n),discount);
  assert.equal(result.lines.reduce((sum,line)=>sum+BigInt(line.paid),0n),BigInt(result.total));
  for(const line of result.lines){assert.equal(line.unitRefunds.length,line.quantity);assert.equal(line.unitRefunds.reduce((sum,value)=>sum+BigInt(value),0n),BigInt(line.paid));assert.equal(line.unitTaxRefunds.reduce((sum,value)=>sum+BigInt(value),0n),BigInt(line.managementTax));assert.ok(line.unitRefunds.every(value=>BigInt(value)>=0n));}
 }
});
test('strict amount and invalid discount rejected',()=>{for(const value of [1,'01','-1','1.5','1000000000000000000000000000000'])assert.throws(()=>money(value));assert.throws(()=>allocate(1n,[0n]));});
test('JST 05:00 day boundary and exact offline deadline',()=>{
 assert.equal(businessDate('2026-09-30T19:59:59Z'),'2026-09-30');assert.equal(businessDate('2026-09-30T20:00:00Z'),'2026-10-01');
 assert.equal(offlineAllowed('2026-10-03T23:59:59Z','2026-10-04T00:00:00Z','2027-01-01T00:00:00Z','2026-10-01T00:00:00Z'),true);
 assert.equal(offlineAllowed('2026-10-04T00:00:00Z','2026-10-04T00:00:00Z','2027-01-01T00:00:00Z','2026-10-01T00:00:00Z'),false);
});
test('CSV formulas neutralized and quotes escaped',()=>{assert.equal(csv('=SUM(A1)'),'"\'=SUM(A1)"');assert.equal(csv('a"b'),'"a""b"');});
test('CSV handles BOM, commas, quotes and CRLF',()=>{assert.deepEqual(parseCsv('\ufeffsku,name\r\nA,"商品,名前"\r\nB,"引用""符"\r\n'),[{sku:'A',name:'商品,名前'},{sku:'B',name:'引用"符'}]);assert.throws(()=>parseCsv('a,a\n1,2'));assert.throws(()=>parseCsv('a,b\n1'));});
