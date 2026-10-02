import {Icon,type IconName} from './Icon';
import {paymentShares,yen} from './presentation';
import {Table} from './Table';
import {StoreIllustration} from './StoreIllustration';

type Props = {report:any;sales:any[];storeName:string;from:string;to:string;onFromChange:(value:string)=>void;onToChange:(value:string)=>void;onNavigate:(page:string)=>void};

export function Dashboard({report,sales,storeName,from,to,onFromChange,onToChange,onNavigate}:Props){
 const metrics:{label:string;value:string;note:string;icon:IconName}[] = [
  {label:'売上（税込）',value:report?yen(report.total):'—',note:'確定した販売の合計',icon:'receipt'},
  {label:'返品後売上',value:report?yen(report.net):'—',note:'販売日と返品日は別々に集計',icon:'refund'},
  {label:'概算粗利',value:report?yen(report.approximateGrossProfit):'—',note:'標準原価による概算',icon:'overview'},
  {label:'取引件数',value:report?String(report.count??0)+' 件':'—',note:'未確定会計は含みません',icon:'orders'},
 ];
 const methods = {cash:{label:'現金',icon:'cash'},card:{label:'カード',icon:'card'},qr:{label:'QR',icon:'qr'}} as const;
 const shortcuts:{page:string;note:string;icon:IconName}[]=[{page:'商品・価格',note:'商品を登録・価格を変更',icon:'products'},{page:'発注・入荷',note:'仕入れを作成・入荷を記録',icon:'orders'},{page:'在庫・移動',note:'在庫を確認・棚卸を実施',icon:'inventory'},{page:'返品・取引',note:'取引を確認・返品を処理',icon:'refund'}];
 return <div className="dashboard">
  <div className="dashboard-top">
   <div className="dashboard-hero">
    <div className="dashboard-title"><span className="eyebrow">店舗の状況</span><h2><span>店舗の現在地を、</span><span>ひと目で。</span></h2><p>販売・在庫・仕入れの状況を確認し、<br/>日々の業務へ。</p><div className="dashboard-context"><span className="store-chip"><Icon name="store"/>{storeName||'店舗を読み込み中'}</span></div></div>
    <StoreIllustration/>
   </div>
   <section className="shortcut-card" aria-labelledby="shortcut-title"><h3 id="shortcut-title">ショートカット</h3><p>よく使う業務へすぐにアクセス。</p><div className="shortcut-grid">{shortcuts.map(shortcut=><button key={shortcut.page} aria-label={shortcut.page+'へ進む'} onClick={()=>onNavigate(shortcut.page)}><Icon name={shortcut.icon}/><span><b>{shortcut.page}</b><small>{shortcut.note}</small></span><Icon name="arrow" className="shortcut-arrow"/></button>)}</div></section>
  </div>
  <div className="dashboard-toolbar"><div className="ledger-caption"><Icon name="book"/><span>店舗の記録<small>営業日の区切り 5:00 · 日本時間</small></span></div><div className="date-range"><div className="date-range-label"><Icon name="calendar"/>集計期間</div><div className="dates"><input aria-label="開始日" type="date" value={from} onChange={event=>onFromChange(event.target.value)}/><span className="date-separator">—</span><input aria-label="終了日" type="date" value={to} onChange={event=>onToChange(event.target.value)}/></div></div></div>
  <div className="cards">{metrics.map((metric,index)=><article className={'metric'+(index===0?' metric-featured':'')} key={metric.label}><div className="metric-heading"><label>{metric.label}</label><span className="metric-icon"><Icon name={metric.icon}/></span></div><strong>{metric.value}</strong><small>{metric.note}</small></article>)}</div>
  <div className="two-columns dashboard-insights">
   <section className="payment-card"><div className="section-heading"><div><span className="eyebrow">決済内訳</span><h3>支払方法別売上</h3></div><span className="quiet-badge">税込</span></div><div className="payment-list">{paymentShares(report?.payments).map(({method,amount,share})=><div className={'payment payment-'+method} key={method}><span className="payment-icon"><Icon name={methods[method].icon}/></span><div className="payment-detail"><div className="payment-heading"><span>{methods[method].label}</span><b>{report?yen(amount):'—'}</b></div><div className="payment-meter"><div className="bar" role={report?"meter":undefined} aria-label={methods[method].label+'の売上比率'} aria-valuenow={report?share:undefined} aria-valuemin={0} aria-valuemax={100}><i style={{width:String(share)+'%'}}/></div><small>{report?share.toLocaleString('ja-JP',{maximumFractionDigits:1})+'%':'—'}</small></div></div></div>)}</div><p className="card-footnote">外部決済は端末の成功結果を店員が確認して記録します。</p></section>
   <section className="strategy-card dashboard-strategy"><div className="strategy-heading"><span className="strategy-emblem" aria-hidden="true"><Icon name="book"/></span><span className="tag">発注サポート<small>需要予測を仕入れに活用</small></span></div><h3>次の仕入れを、<br/>根拠とともに。</h3><p>需要予測と発注提案を、根拠とともに。<br/>更新日時と予測方式を確認して、仕入れを計画できます。</p><button className="text-button" onClick={()=>onNavigate('AI・需要予測')}>需要予測・発注提案を見る <Icon name="arrow"/></button><small className="strategy-availability">予測が利用できないときも、通常の業務は続けられます。</small></section>
  </div>
  <section className="transactions-card"><div className="section-heading"><div><span className="eyebrow">取引履歴</span><h3>最近の取引</h3></div><button className="text-button" onClick={()=>onNavigate('返品・取引')}>すべての取引 <Icon name="arrow"/></button></div><Table headers={['取引番号','販売日時','支払方法','金額','状態']} rows={sales.slice(0,8).map(entry=>[<span className="transaction-id">{entry.id.slice(0,8)}</span>,new Date(entry.body.occurredAt).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'}),<span className="payment-label">{methods[entry.body.method as keyof typeof methods]?.label??entry.body.method}</span>,yen(entry.body.total),<span className="status-badge"><Icon name="check"/>確定</span>])}/></section>
 </div>;
}
