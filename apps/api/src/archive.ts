import {gzipSync} from 'node:zlib';
export function archive(files:{name:string;bytes:Buffer}[]){
 const blocks:Buffer[]=[];
 for(const file of files){
  if(!/^[a-zA-Z0-9_./-]{1,99}$/.test(file.name)||file.name.includes('..'))throw new Error('Invalid archive filename');
  const header=Buffer.alloc(512);header.write(file.name,0,100,'ascii');
  for(const [offset,length,value] of [[100,8,0o600],[108,8,0],[116,8,0],[124,12,file.bytes.length],[136,12,0]])header.write(value.toString(8).padStart(length-1,'0')+'\0',offset,length,'ascii');
  header.fill(32,148,156);header.write('0',156,1,'ascii');header.write('ustar\0',257,6,'ascii');header.write('00',263,2,'ascii');
  const checksum=header.reduce((sum,value)=>sum+value,0);header.write(checksum.toString(8).padStart(6,'0')+'\0 ',148,8,'ascii');
  blocks.push(header,file.bytes,Buffer.alloc((512-file.bytes.length%512)%512));
 }
 blocks.push(Buffer.alloc(1024));return gzipSync(Buffer.concat(blocks));
}
