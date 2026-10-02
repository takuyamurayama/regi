import assert from 'node:assert/strict';
import test from 'node:test';
import {reportPeriod} from '../apps/web/src/report-period';

test('optional demo Web build selects seven real historical days after the Cognito callback returns to root',()=>{
 const now=new Date('2026-10-02T06:00:00Z');
 assert.deepEqual(reportPeriod('','2026-10-01',now),{from:'2026-09-25',to:'2026-10-01',demoDefault:true});
 assert.deepEqual(reportPeriod('',undefined,now),{from:'2026-10-02',to:'2026-10-02',demoDefault:false});
 for(const invalid of ['2026-02-30','2026-10-02','2026-12-31','not-a-date'])assert.deepEqual(reportPeriod('',invalid,now),{from:'2026-10-02',to:'2026-10-02',demoDefault:false});
 assert.deepEqual(reportPeriod('?from=2026-09-01&to=2026-09-03','2026-10-01',now),{from:'2026-09-01',to:'2026-09-03',demoDefault:false});
});
