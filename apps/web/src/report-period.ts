import {businessDate} from '@regi/core';

export function reportPeriod(search:string,demoHistoryEnd:string|undefined,now=new Date()){
 const query=new URLSearchParams(search),today=businessDate(now.toISOString());
 const candidate=demoHistoryEnd??'',parsed=new Date(`${candidate}T00:00:00Z`);
 const valid=/^\d{4}-\d{2}-\d{2}$/.test(candidate)&&!Number.isNaN(parsed.getTime())&&parsed.toISOString().slice(0,10)===candidate&&candidate<today;
 const end=valid?candidate:today,start=valid?new Date(parsed.getTime()-6*86400000).toISOString().slice(0,10):today;
 return {from:query.get('from')??start,to:query.get('to')??end,demoDefault:valid&&!query.has('from')&&!query.has('to')};
}
