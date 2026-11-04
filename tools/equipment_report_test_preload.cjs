'use strict';
// Legacy VM fixture adapter ONLY: provide browser platform primitives and the real HTML dependencies.
// No product method/assertion is replaced. New denial/idempotency tests do NOT use this adapter.
const fs=require('fs'),path=require('path'),vm=require('vm'),crypto=require('crypto');
const root=path.resolve(__dirname,'..'),sources=['equipment-time.js','equipment-report-intent.js'].map(f=>({file:'docs/equipment/js/'+f,text:fs.readFileSync(path.join(root,'docs/equipment/js',f),'utf8')}));
const run=vm.runInContext,seen=new WeakSet();
function storage(s){if(!s||seen.has(s))return;seen.add(s);let keys=new Set(s.data&&typeof s.data.keys==='function'?[...s.data.keys()]:[]);if(typeof s.key!=='function'){const put=s.setItem,del=s.removeItem;if(put)s.setItem=function(k,v){const r=put.call(this,k,v);keys.add(String(k));return r;};if(del)s.removeItem=function(k){const r=del.call(this,k);keys.delete(String(k));return r;};s.key=i=>[...keys][i]??null;if(typeof s.length!=='number')Object.defineProperty(s,'length',{get:()=>keys.size,configurable:true});}}
vm.runInContext=function(code,ctx,opts){
 if(ctx&&ctx.window&&!ctx.__reportFixtureBootstrap){ctx.__reportFixtureBootstrap=true;try{
  if(!ctx.crypto)ctx.crypto={randomUUID:()=>crypto.randomUUID()};
  if(!ctx.navigator)ctx.navigator={};if(!ctx.navigator.locks){const q=new Map();ctx.navigator.locks={request(name,a,b){const cb=typeof a==='function'?a:b,r=(q.get(name)||Promise.resolve()).then(()=>cb({name}));q.set(name,r.catch(()=>{}));return r;}};}
  storage(ctx.localStorage);storage(ctx.sessionStorage);
  for(const src of sources){const key=src.file.includes('report-intent')?'EquipReportIntent':'EquipTime';if(!ctx[key]){run.call(vm,src.text,ctx,{filename:src.file});if(!ctx[key]&&ctx.window[key])ctx[key]=ctx.window[key];}}
 }finally{delete ctx.__reportFixtureBootstrap;}}
 return run.call(vm,code,ctx,opts);
};
