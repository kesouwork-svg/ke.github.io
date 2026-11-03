// Test-only dependency bootstrap for legacy VM fixtures that predate equipment-time.js.
// Mirrors the real HTML script order. Does not replace any product function/assertion.
'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const source=fs.readFileSync(path.join(__dirname,'../docs/equipment/js/equipment-time.js'),'utf8');
const run=vm.runInContext;
vm.runInContext=function(code,context,options){
 if(context&&context.window&&!context.EquipTime&&!context.__equipmentTimeBootstrap){
  context.__equipmentTimeBootstrap=true;
  try{run.call(vm,source,context,{filename:'docs/equipment/js/equipment-time.js'});if(!context.EquipTime&&context.window.EquipTime)context.EquipTime=context.window.EquipTime;}
  finally{delete context.__equipmentTimeBootstrap;}
 }
 return run.call(vm,code,context,options);
};
