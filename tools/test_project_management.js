'use strict';
// Runs the new module's actual RPCs against an isolated PostgreSQL database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const { PGlite } = require(require.resolve('@electric-sql/pglite', {paths:[process.env.PGLITE_MODULE_ROOT || path.join(root, 'outputs/sql-fixture')]}));
const migration = fs.readFileSync(path.join(root, 'supabase/project_management.sql'), 'utf8');
const schema = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8');
const financeContext={window:{}};
require('node:vm').runInNewContext(fs.readFileSync(path.join(root,'docs/project-management/finance.js'),'utf8'),financeContext);
const finance=financeContext.window.ProjectFinance;

async function fixture() {
  const db = new PGlite();
  await db.exec('create role anon; create role authenticated;');
  for(const table of ['users','sessions']){
    const definition = schema.slice(schema.indexOf('create table if not exists public.'+table+' (')).split(');')[0];
    await db.exec(definition+');');
  }
  const auth = schema.slice(schema.indexOf('create or replace function public._get_user_by_token')).split('$$;')[0];
  await db.exec(auth+'$$;');
  await db.exec(migration);
  await db.exec(migration);
  for(const [account,level] of [['owner',2],['other',2],['lead',1],['blocked',0]]){
    await db.query("insert into public.users(account,name,pwd,status,level) values($1,$1,'dummy','active',$2)",[account,level]);
    await db.query('insert into public.sessions values($1,$1,4102444800000)',[account]);
  }
  await db.exec('set role anon');
  return db;
}

async function test(){
  const db = await fixture();
  const id = '3e5c756f-58c9-46e8-8bb4-67fd7e04edd8';
  const plan = {title:'工位改造',problem:'双人作业',target:'单人作业',due:'2027-12-01',basis:'现场测量',investment:10,cost:1,benefit:2,people:1,salary:5000,months:12};
  const initial = {plan:{title:plan.title}};
  let revision = 0;
  const apply = async (account,action,input={},rev=revision) => {
    const r = await db.query('select public.pm_apply($1,$2,$3,$4,$5) as p',[account,id,rev,action,JSON.stringify(input)]);
    revision = r.rows[0].p.revision;
    return r.rows[0].p;
  };
  const list = async account => (await db.query('select public.pm_list($1) as result',[account])).rows[0].result;
  try {
    await assert.rejects(db.query('select * from public.pm_projects'),/permission denied/);
    await assert.rejects(list('guest'),/登录/);
    await assert.rejects(list('blocked'),/无项目台账权限/);
    await assert.rejects(apply('blocked','create',initial),/无项目台账权限/);

    const p = await apply('owner','create',initial);
    assert.deepEqual(await apply('owner','create',initial,0),p);
    assert.equal(p.status,'planned');
    assert.equal(p.status_history[0].kind,'created');
    assert.equal(p.status_history[0].at,p.status_history[0].recorded_at);
    assert.equal((await list('owner')).length,1);
    assert.deepEqual(await list('other'),[]);
    await assert.rejects(apply('other','progress',{date:'2027-01-15',note:'测试'}),/访问权限/);
    await assert.rejects(apply('owner','save',{plan},0),/重新载入/);
    for(const action of ['approve','submit','return','accept']) await assert.rejects(apply('owner',action),/未知记录操作/);
    const first = await apply('owner','progress',{date:'2026-11-21',note:'现场观察'});
    const entryId = first.progress[0].id;
    await apply('owner','progress',{date:'2026-11-01',note:'补录启动情况'});
    const edited = await apply('owner','progress',{id:entryId,date:'2026-11-21',note:'完成现场测量'});
    assert.equal(edited.progress.length,2);
    assert.equal(edited.progress[0].note,'完成现场测量');
    await apply('owner','annual',{year:2026,investment:1});
    await apply('owner','annual',{year:2027,note:'暂无收益数据'});
    await assert.rejects(apply('owner','annual',{year:2028,investment:null}),/至少填写/);
    for(const status of ['active','paused','active','paused','done','terminated']){
      const result = await apply('owner','save',{plan,status});
      assert.equal(result.status,status);
      assert.deepEqual(result.plan,plan);
      assert.deepEqual(result.progress,edited.progress);
      assert.deepEqual(result.annual,{'2026':{investment:1},'2027':{note:'暂无收益数据'}});
    }
    const events=(await list('owner'))[0].status_history;
    assert.deepEqual(events.slice(1).map(e=>e.to),['active','paused','active','paused','done','terminated']);
    const chosen='2026-11-18T08:23:00+08:00';
    await apply('owner','save',{plan,status:'terminated'});
    assert.equal((await list('owner'))[0].status_history.length,events.length);
    const changed=await apply('owner','status_time',{id:events[2].id,effective_at:chosen});
    assert.equal(Date.parse(changed.status_history[2].at),Date.parse(chosen));
    assert.equal(changed.status_history[2].recorded_at,events[2].recorded_at);
    assert.equal(changed.status,'terminated');
    await assert.rejects(apply('other','status_time',{id:events[2].id}),/访问权限/);
    await assert.rejects(apply('owner','status_time',{missing:'created'}),/已记录/);
    const resumed=await apply('owner','save',{plan,status:'active',effective_at:chosen});
    assert.equal(Date.parse(resumed.status_history.at(-1).at),Date.parse(chosen));
    const equipment={key:'equipment',values:{amount:9},lines:[
      {name:'主机',qty:2,price:15000,note:''},{name:'工装',qty:1,price:20000,note:''}
    ]};
    const budget={period:'2026',cards:[equipment]};
    await assert.rejects(apply('owner','book',{...budget,period:'plan'}),/格式无效/);
    const budgetRecord=await apply('owner','book',budget);
    assert.deepEqual(budgetRecord.ledger['2026'],[equipment]);
    const corrected={...equipment,lines:[{...equipment.lines[0],price:12000},equipment.lines[1]]};
    const correction=await apply('owner','book',{...budget,cards:[corrected]});
    assert.equal(correction.ledger['2026'].length,1);
    assert.equal(finance.totals(correction,'2026').invest,4.4);
    await assert.rejects(apply('other','book',budget),/访问权限/);
    await assert.rejects(apply('owner','book',budget,1),/重新载入/);
    await assert.rejects(apply('owner','book',{period:'2026',cards:[{...equipment,lines:[{name:'主机',qty:0,price:900}]}]}),/数量与单价/);
    await apply('owner','book',{period:'2027',cards:[{key:'spare',values:{amount:0.014}}]});
    await apply('owner','annual',{year:2027,note:'备件已入库'});
    const saved=(await list('owner'))[0];
    assert.deepEqual(saved.ledger['2026'],[corrected]);
    assert.equal(saved.ledger['2027'][0].values.amount,0.014);
    assert.deepEqual(saved.annual['2026'],{investment:1});
    assert.equal(saved.annual['2027'].note,'备件已入库');
    const legacy={plan:{due:'2027-12-01'},books:{plan:[equipment,{key:'install',values:{amount:1}}]},annual:{'2026':{investment:0}},ledger:{}};
    assert.equal(finance.totals(legacy,'2026').invest,0);
    assert.equal(finance.totals(legacy,'2027').invest,null);
    legacy.books['2026']=[corrected];
    assert.equal(finance.totals(legacy,'2026').invest,5.4);
    legacy.ledger['2026']=[];
    assert.equal(finance.totals(legacy,'2026').invest,null);
    const secondId='9a36fe21-0264-49d8-8349-3bf20dbbf2a5';
    const created=await db.query('select pm_apply($1,$2,0,$3,$4) as p', ['other',secondId,'create',JSON.stringify({...initial,effective_at:chosen})]);
    assert.equal(Date.parse(created.rows[0].p.status_history[0].at),Date.parse(chosen));
    assert.deepEqual((await list('lead')).map(r=>r.id).sort(),[id,secondId].sort());
    assert.deepEqual((await list('other')).map(r=>r.id),[secondId]);
    assert.equal((await list('lead'))[0].can_view_all,true);
    for(const action of ['save','progress','annual','book']){
      await assert.rejects(apply('other',action),/访问权限/);
      await assert.rejects(apply('blocked',action),/无项目台账权限/);
    }
    const prior=revision;
    await apply('lead','save',{plan,status:'done',owner_account:'lead'});
    await apply('lead','progress',{date:'2027-01-16',note:'复测完成'});
    await apply('lead','annual',{year:2028,investment:3});
    assert.equal((await apply('lead','book',budget)).owner_account,'owner');
    await assert.rejects(apply('owner','book',budget,prior),/重新载入/);
    await db.exec("reset role; update users set level=2 where account='lead'; set role anon;");
    assert.deepEqual(await list('lead'),[]);
    await assert.rejects(apply('lead','book',budget),/访问权限/);
    console.log('Passed project records, itemized budgets, independent annual books, permissions and revision checks.');
  } finally { await db.close(); }
}
module.exports = {fixture};
if(require.main===module) test().catch(error=>{console.error(error);process.exitCode=1;});
