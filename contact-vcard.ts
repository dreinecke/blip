#!/usr/bin/env bun
/** Copy or save an explicitly selected source card as a private .vcf file.
 * Adapted from contact-management's vCard export; no Contacts writes. */
import {spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {closeSync,constants,fstatSync,openSync,writeSync,mkdirSync,opendirSync,lstatSync,unlinkSync,linkSync,fsyncSync,realpathSync} from 'node:fs';
import {join,isAbsolute,basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {homedir} from 'node:os';
import {normalizeHandle,identityKey,readStdinBounded} from './contact-review';
const MAX_CARD_BYTES=2*1024*1024, MAX_RESPONSE_BYTES=3*1024*1024;
const TOKEN=/^sha256:[0-9a-f]{64}$/;
const FILE=/^contact-[0-9a-f]{32}\.vcf$/;
export function vcardBytes(body:any,handle:string,token:string): Buffer {
  if (!body || body.ok!==true || identityKey(body.handle)!==identityKey(handle) || body.token!==token)
    throw new Error('Contacts did not return the selected card');
  if (typeof body.vcard!=='string' || body.vcard.length>MAX_RESPONSE_BYTES
    || (body.vcard.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.vcard)))
    throw new Error('Invalid contact vCard');
  const bytes=Buffer.from(body.vcard,'base64');
  if (bytes.toString('base64') !== body.vcard || !bytes.length || bytes.length>MAX_CARD_BYTES || !bytes.toString('utf8').startsWith('BEGIN:VCARD\r\n')
    || !bytes.toString('utf8').trimEnd().endsWith('END:VCARD')) throw new Error('Invalid contact vCard');
  return bytes;
}
function directory(path:string): number {
  const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const st=fstatSync(fd);
  if (!st.isDirectory() || st.uid!==process.getuid!() || (st.mode&0o077)!==0) {
    closeSync(fd); throw new Error('Unsafe vCard runtime directory');
  }
  return fd;
}
export function writeVcard(bytes:Buffer,runtimeRoot:string): string {
  if (!isAbsolute(runtimeRoot)) throw new Error('A private runtime directory is required');
  if (bytes.length>MAX_CARD_BYTES) throw new Error('Contact vCard is too large');
  let parent=directory(runtimeRoot);
  try {
    for(const component of ['blip','vcards']) {
      const pinned=`/proc/self/fd/${parent}/${component}`;
      try {mkdirSync(pinned,{mode:0o700});} catch(e:any) {if(e.code!=='EEXIST') throw e;}
      const child=directory(pinned); closeSync(parent); parent=child;
    }
    const root=`/proc/self/fd/${parent}`;
    const entries: string[]=[];
    const listing=opendirSync(root,{bufferSize:32});
    try {
      let entry;
      while((entry=listing.readSync())!==null) {
        if(entries.length===256) throw new Error('Too many files in the vCard cache');
        entries.push(entry.name);
      }
    } finally {listing.closeSync();}
    const copies=entries.filter(name=>FILE.test(name)).map(name=>({name,stat:lstatSync(join(root,name))}))
      .filter(file=>file.stat.isFile()).sort((a,b)=>b.stat.mtimeMs-a.stat.mtimeMs);
    for(const [index,file] of copies.entries()) {
      if(index>=31 || Date.now()-file.stat.mtimeMs>24*60*60*1000) unlinkSync(join(root,file.name));
    }
    const name='contact-'+randomBytes(16).toString('hex')+'.vcf';
    const fd=openSync(join(root,name),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try {let written=0;while(written<bytes.length) written+=writeSync(fd,bytes,written,bytes.length-written);} finally {closeSync(fd);}
    return pathToFileURL(join(runtimeRoot,'blip','vcards',name)).href;
  } finally {closeSync(parent);}
}
function fetchContactVcard(request:any,runner:typeof spawnSync) {
  const handle=normalizeHandle(request?.handle),token=request?.token;
  if(typeof token!=='string' || !TOKEN.test(token)) throw new Error('Invalid contact card token');
  const result=runner(join(process.env.HOME??homedir(),'bin','contacts'),['--json','resolve'], {
    encoding:'utf8',input:JSON.stringify({operation:'vcard',handle,token}),timeout:35000,maxBuffer:MAX_RESPONSE_BYTES,
  });
  if(result.error || result.status!==0) throw new Error('Could not export the contact vCard');
  const output=String(result.stdout||'');
  if(Buffer.byteLength(output)>MAX_RESPONSE_BYTES) throw new Error('Contact vCard response is too large');
  let body:any;try {body=JSON.parse(output);} catch {throw new Error('Invalid contact vCard response');}
  return {bytes:vcardBytes(body,handle,token),name:body.name};
}
export function copyContactVcard(request:any,runner=spawnSync,runtimeRoot=process.env.XDG_RUNTIME_DIR || '') {
  const {bytes}=fetchContactVcard(request,runner);
  const uri=writeVcard(bytes,runtimeRoot);
  const copied=runner('/usr/bin/wl-copy',['--type','text/uri-list'], {
    input:uri+'\r\n',encoding:'utf8',timeout:5000,maxBuffer:1024,
  });
  if(copied.error || copied.status!==0) throw new Error('Could not copy the vCard to the clipboard');
  return {ok:true,view:'copied',title:'Contact review',detail:'Copied vCard — paste it as a contact file',rows:[]};
}
/** A display name becomes only a suggested basename, never a directory. */
export function vcardFileName(value:unknown):string {
  let name=typeof value==='string' && value.length<=160 ? value : '';
  name=name.replace(/[^\p{L}\p{N} _.-]/gu,' ').replace(/\s+/g,' ').replace(/^\.+/,'').trim();
  while(Buffer.byteLength(name)>120) name=Array.from(name).slice(0,-1).join('');
  return (name.trim() || 'Contact')+'.vcf';
}
/** Pin the chosen folder; create privately and publish without replacing files. */
export function saveVcardInFolder(bytes:Buffer,folder:string,name:unknown):string {
  if(typeof folder!=='string' || folder.length>4096 || !isAbsolute(folder) || /[\x00-\x1f\x7f-\x9f]/.test(folder))
    throw new Error('Invalid destination folder');
  if(!bytes.length || bytes.length>MAX_CARD_BYTES) throw new Error('Contact vCard is too large');
  const resolved=realpathSync(folder),flags=constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW|constants.O_NONBLOCK;
  let parent=openSync('/',flags);
  let staging='';
  try {
    for(const component of resolved.split('/').filter(Boolean)) {
      const child=openSync(`/proc/self/fd/${parent}/${component}`,flags);
      closeSync(parent);parent=child;
    }
    if(fstatSync(parent).uid!==process.getuid!()) throw new Error('Choose a folder you own');
    const root=`/proc/self/fd/${parent}`;
    const temporary=join(root,'.blip-vcard-'+randomBytes(16).toString('hex'));
    const fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    staging=temporary;
    try {
      let written=0;while(written<bytes.length) written+=writeSync(fd,bytes,written,bytes.length-written);
      fsyncSync(fd);
    } finally {closeSync(fd);}
    const base=vcardFileName(name).slice(0,-4);
    for(let index=1;index<=100;index++) {
      const filename=base+(index===1?'':` (${index})`)+'.vcf';
      try {linkSync(staging,join(root,filename));}
      catch(error:any) {if(error.code==='EEXIST') continue;throw error;}
      return join(resolved,filename);
    }
    throw new Error('Too many vCards with this name in the selected folder');
  } finally {
    try {if(staging) unlinkSync(staging);} finally {closeSync(parent);}
  }
}
export function saveContactVcard(request:any,runner=spawnSync) {
  const {bytes,name}=fetchContactVcard(request,runner);
  const downloads=runner('/usr/bin/xdg-user-dir',['DOWNLOAD'],{encoding:'utf8',timeout:2000,maxBuffer:4097});
  const location=String(downloads.stdout || '').trim();
  const initial=downloads.status===0 && location.length<=4096 && isAbsolute(location) && !/[\x00-\x1f\x7f-\x9f]/.test(location)
    ? location : homedir();
  const choice=runner('/usr/bin/zenity',['--file-selection','--directory','--title=Save vCard to folder',
    '--filename='+initial+'/'],{encoding:'utf8',timeout:300000,maxBuffer:4097});
  if(choice.error) throw new Error((choice.error as NodeJS.ErrnoException).code==='ENOENT'
    ? 'Save vCard requires zenity to choose a folder' : 'The folder picker failed or timed out');
  if(choice.status===1) return {ok:true,view:'cancelled',title:'Contact review',detail:'Save cancelled',rows:[]};
  if(choice.status!==0) throw new Error('Could not choose a destination folder');
  const folder=String(choice.stdout || '').replace(/\r?\n$/,'');
  const path=saveVcardInFolder(bytes,folder,name);
  return {ok:true,view:'saved',title:'Contact review',detail:'Saved '+basename(path)+' to the selected folder',rows:[]};
}
export function exportContactVcard(request:any,runner=spawnSync,runtimeRoot=process.env.XDG_RUNTIME_DIR || '') {
  if(request?.action==='save') return saveContactVcard(request,runner);
  if(request?.action!==undefined && request.action!=='copy') throw new Error('Invalid vCard action');
  return copyContactVcard(request,runner,runtimeRoot);
}
if(import.meta.main) {
  const timer=setTimeout(()=>{process.stdout.write('{"ok":false,"error":"Contact request timed out"}\n');process.exit(1);},5000);
  try {
    const request=JSON.parse(await readStdinBounded()); clearTimeout(timer);
    process.stdout.write(JSON.stringify(exportContactVcard(request))+'\n');
  }
  catch(error) {
    clearTimeout(timer);
    const message=String(error instanceof Error?error.message:error).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,' ').slice(0,180);
    process.stdout.write(JSON.stringify({ok:false,error:message})+'\n');process.exitCode=1;
  }
}
