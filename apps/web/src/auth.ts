type Store=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
type Config={domain:string;clientId:string;redirect:string};
export class BrowserAuth {
 private refreshing?:Promise<string>;
 constructor(private config:Config,private storage:Store,private transport:typeof fetch=(...parameters)=>globalThis.fetch(...parameters),private now=()=>Date.now()){}
 async authorizationUrl(){
  if(!this.config.domain.startsWith('https://')||!this.config.clientId)throw new Error('CognitoのHTTPSログイン先が未設定です');
  const bytes=crypto.getRandomValues(new Uint8Array(48)),encode=(value:Uint8Array)=>btoa(String.fromCharCode(...value)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
  const verifier=encode(bytes),challenge=encode(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier)))),state=crypto.randomUUID();
  this.storage.setItem('regi-oauth-pending',JSON.stringify({verifier,state,issuedAt:this.now()}));
  return this.config.domain+'/oauth2/authorize?'+new URLSearchParams({client_id:this.config.clientId,response_type:'code',scope:'openid profile',redirect_uri:this.config.redirect,code_challenge_method:'S256',code_challenge:challenge,state});
 }
 private async exchange(parameters:Record<string,string>,priorRefresh?:string){
  const response=await this.transport(this.config.domain+'/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:this.config.clientId,...parameters})});
  if(!response.ok)throw new Error('Cognitoの認証更新に失敗しました。再ログインしてください');
  const result=await response.json();if(typeof result.id_token!=='string'||!Number.isFinite(Number(result.expires_in)))throw new Error('認証応答が不正です');
  this.storage.setItem('regi-oauth-session',JSON.stringify({token:result.id_token,refresh:result.refresh_token??priorRefresh,expiresAt:this.now()+Number(result.expires_in)*1000}));this.storage.setItem('regi-token',result.id_token);return result.id_token as string;
 }
 async callback(url:string){
  const parameters=new URL(url).searchParams,code=parameters.get('code');if(!code)return null;
  const pending=JSON.parse(this.storage.getItem('regi-oauth-pending')??'null');
  if(!pending||parameters.get('state')!==pending.state||this.now()-pending.issuedAt>600000)throw new Error('ログインのstate・有効期限が一致しません');
  this.storage.removeItem('regi-oauth-pending');return this.exchange({grant_type:'authorization_code',code,redirect_uri:this.config.redirect,code_verifier:pending.verifier});
 }
 async token(fallback:string){
  const session=JSON.parse(this.storage.getItem('regi-oauth-session')??'null');if(!session)return fallback;
  if(session.expiresAt>this.now()+30000)return session.token as string;
  if(!session.refresh)throw new Error('再ログインしてください');
  this.refreshing??=this.exchange({grant_type:'refresh_token',refresh_token:session.refresh},session.refresh).finally(()=>{this.refreshing=undefined;});return this.refreshing;
 }
 logout(){for(const key of ['regi-token','regi-oauth-session','regi-oauth-pending'])this.storage.removeItem(key);}
}
const config=import.meta.env??{};
export const hostedDomain=config.VITE_COGNITO_DOMAIN as string|undefined;
let instance:BrowserAuth|undefined;
const auth=()=>instance??=new BrowserAuth({domain:hostedDomain??'',clientId:config.VITE_COGNITO_CLIENT_ID??'',redirect:location.origin+'/'},sessionStorage);
export async function login(){location.assign(await auth().authorizationUrl());}
export async function callback(){const token=await auth().callback(location.href);if(token)history.replaceState(null,'','/');return token;}
export const freshToken=(fallback:string)=>auth().token(fallback);
export const logout=()=>auth().logout();
