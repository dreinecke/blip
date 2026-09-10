import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,mkdirSync,symlinkSync,readdirSync,readFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {vcardBytes,writeVcard,copyContactVcard} from './contact-vcard';
const card=Buffer.from('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Example Person\r\nEND:VCARD\r\n');
const token='sha256:'+'a'.repeat(64), handle='+15551234567';
const body={ok:true,token,handle,vcard:card.toString('base64')};
test('validates exact-card identity and bounded canonical vCard bytes',()=>{
  expect(vcardBytes(body,handle,token)).toEqual(card);
  for(const value of [null,{...body,token:'bad'},{...body,handle:'+15551234568'},
    {...body,vcard:'!!!!'}, {...body,vcard:Buffer.from('BEGIN:VCARD\r\ntruncated').toString('base64')},
    {...body,vcard:'A'.repeat(3*1024*1024+4)}]) expect(()=>vcardBytes(value,handle,token)).toThrow();
});
test('copies a runtime file through clipboard stdin and reports failure honestly',()=>{
  const dir=mkdtempSync(join(tmpdir(),'blip-vcard-'));
  try {
    const calls:any[]=[];
    const runner=((command:string,args:string[],options:any)=>{
      calls.push({command,args,input:options.input});
      return {status:0,stdout:command.endsWith('/contacts')?JSON.stringify(body):''};
    }) as any;
    expect(copyContactVcard({handle,token},runner,dir).view).toBe('copied');
    expect(calls[0].args).toEqual(['--json','resolve']);
    expect(JSON.parse(calls[0].input)).toEqual({operation:'vcard',handle,token});
    expect(calls[1].args).toEqual(['--type','text/uri-list']);
    expect(calls[1].input.endsWith('\r\n')).toBe(true);
    const uri=calls[1].input.trim(),path=fileURLToPath(uri);
    expect(readFileSync(path)).toEqual(card);
    expect(statSync(path).mode&0o777).toBe(0o600);
    expect(()=>copyContactVcard({handle,token},((command:string)=>({status:command.endsWith('/contacts')?0:1,stdout:JSON.stringify(body)})) as any,dir)).toThrow('clipboard');
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('rejects symlink directories and keeps at most 32 prior clipboard files',()=>{
  const dir=mkdtempSync(join(tmpdir(),'blip-vcard-')),target=mkdtempSync(join(tmpdir(),'blip-vcard-target-'));
  try {
    symlinkSync(target,join(dir,'blip'));
    expect(()=>writeVcard(card,dir)).toThrow();
    rmSync(join(dir,'blip'));
    for(let i=0;i<34;i++) writeVcard(card,dir);
    expect(readdirSync(join(dir,'blip','vcards'))).toHaveLength(32);
    expect(()=>writeVcard(card,'relative')).toThrow('runtime');
  } finally {rmSync(dir,{recursive:true,force:true});rmSync(target,{recursive:true,force:true});}
});
