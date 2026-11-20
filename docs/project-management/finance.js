(function(){
  // ROI card definitions and units follow the original calculator.
  const defs={
    equipment:{name:'设备采购/开发费',type:'invest',icon:'设',detail:true,fields:[{key:'amount',label:'金额',unit:'万元'}],formula:'直接填入金额(或按明细汇总)'},
    install:{name:'安装调试费',type:'invest',icon:'安',fields:[{key:'amount',label:'金额',unit:'万元'}],formula:'直接填入金额'},
    fixture:{name:'夹具/模具费',type:'invest',icon:'夹',detail:true,fields:[{key:'amount',label:'金额',unit:'万元'}],formula:'直接填入金额(或按明细汇总)'},
    electrical:{name:'电气/控制系统',type:'invest',icon:'控',detail:true,fields:[{key:'amount',label:'金额',unit:'万元'}],formula:'直接填入金额(或按明细汇总)'},
    site:{name:'场地改造费',type:'invest',icon:'场',fields:[{key:'amount',label:'金额',unit:'万元'}],formula:'直接填入金额'},
    training:{name:'培训费',type:'invest',icon:'培',fields:[{key:'amount',label:'金额',unit:'万元'}],formula:'直接填入金额'},
    trial:{name:'试产损耗',type:'invest',icon:'试',fields:[{key:'months',label:'爬坡月数',unit:'月'},{key:'monthly_loss',label:'月均损失',unit:'万元'}],formula:'爬坡月数 × 月均损失',calcFn:function(v){return (v.months??0)*(v.monthly_loss??0)}},
    mgmt:{name:'项目管理成本',type:'invest',icon:'管',fields:[{key:'amount',label:'金额',unit:'万元'}],formula:'直接填入金额'},
    labor:{name:'人工节省',type:'benefit',icon:'人',fields:[{key:'persons',label:'减少人数',unit:'人'},{key:'salary',label:'月薪',unit:'元'},{key:'factor',label:'综合系数',unit:''},{key:'months',label:'年工时月',unit:'月'}],formula:'人数×月薪×系数×年工时月÷10000',calcFn:function(v){return (v.persons??0)*(v.salary??0)*(v.factor??1.5)*(v.months??12)/10000}},
    capacity:{name:'产能提升',type:'benefit',icon:'产',fields:[{key:'old_uph',label:'旧UPH',unit:'pcs/h'},{key:'new_uph',label:'新UPH',unit:'pcs/h'},{key:'annual_output',label:'年总产量',unit:'万件'},{key:'profit',label:'单件利润',unit:'元'}],formula:'年总产量×(新-旧)÷旧UPH×单件利润',calcFn:function(v){if(!v.old_uph||v.old_uph===0)return 0;return (v.annual_output??0)*((v.new_uph??0)-(v.old_uph??0))/v.old_uph*(v.profit??0)}},
    yield:{name:'良率提升',type:'benefit',icon:'良',fields:[{key:'annual_output',label:'年产量',unit:'万件'},{key:'old_yield',label:'旧良率',unit:'%'},{key:'new_yield',label:'新良率',unit:'%'},{key:'unit_cost',label:'单件成本',unit:'元'}],formula:'年产量×(新-旧)÷100×单件成本',calcFn:function(v){return (v.annual_output??0)*((v.new_yield??0)-(v.old_yield??0))/100*(v.unit_cost??0)}},
    overtime:{name:'加班费减少',type:'benefit',icon:'加',fields:[{key:'persons',label:'人数',unit:'人'},{key:'hours',label:'月加班时数',unit:'h'},{key:'rate',label:'加班时薪',unit:'元'},{key:'months',label:'年工时月',unit:'月'}],formula:'人数×月加班时数×时薪×年工时月÷10000',calcFn:function(v){return (v.persons??0)*(v.hours??0)*(v.rate??0)*(v.months??12)/10000}},
    quality:{name:'质量损失减少',type:'benefit',icon:'质',fields:[{key:'annual_loss',label:'年质量损失',unit:'万元'},{key:'reduce_pct',label:'减少比例',unit:'%'}],formula:'年质量损失×减少比例÷100',calcFn:function(v){return (v.annual_loss??0)*(v.reduce_pct??0)/100}},
    structure:{name:'结构优化收益',type:'benefit',icon:'构',fields:[{key:'old_cost',label:'原成本',unit:'元/PCS'},{key:'new_cost',label:'现成本',unit:'元/PCS'},{key:'annual_output',label:'年总产量',unit:'万件'}],formula:'(原成本-现成本)×年总产量',calcFn:function(v){return ((v.old_cost??0)-(v.new_cost??0))*(v.annual_output??0)}},
    electricity:{name:'电费',type:'cost',icon:'电',fields:[{key:'power',label:'功率',unit:'kW'},{key:'hours',label:'日时长',unit:'h'},{key:'days',label:'年工作日',unit:'天'},{key:'price',label:'电价',unit:'元/kWh'}],formula:'功率×日时长×年工作日×电价÷10000',calcFn:function(v){return (v.power??0)*(v.hours??0)*(v.days??250)*(v.price??0.8)/10000}},
    maintenance:{name:'维护保养费',type:'cost',icon:'维',fields:[{key:'equip_value',label:'设备总额',unit:'万元'},{key:'ratio',label:'维护比例',unit:'%'}],formula:'设备总额×维护比例÷100',calcFn:function(v){return (v.equip_value??0)*(v.ratio??5)/100}},
    spare:{name:'备件耗材费',type:'cost',icon:'备',detail:true,fields:[{key:'amount',label:'年费用',unit:'万元'}],formula:'直接填入金额(或按明细汇总)'},
    operator:{name:'操作人工费',type:'cost',icon:'操',fields:[{key:'persons',label:'人数',unit:'人'},{key:'salary',label:'月薪',unit:'元'},{key:'factor',label:'综合系数',unit:''},{key:'months',label:'年工时月',unit:'月'}],formula:'人数×月薪×系数×年工时月÷10000',calcFn:function(v){return (v.persons??0)*(v.salary??0)*(v.factor??1.5)*(v.months??12)/10000}}
};
  const groups={invest:'一次性投入',benefit:'收益',cost:'运行成本'};
  for(const [group,label] of Object.entries(groups)){
    defs['other_'+group]={type:group,name:'其他'+(group==='invest'?'投入':label),detail:true,fields:[{key:'amount',label:'金额',unit:'万元'}]};
  }
  function amount(card){
    const def=defs[card.key];
    if(def.detail && card.lines?.length) return card.lines.reduce((sum,line)=>sum+line.qty*line.price,0)/10000;
    return def.calcFn?def.calcFn(card.values):card.values.amount??0;
  }
  function summaryCards(data,withLabor=false){
    const cards=[];
    for(const [field,group] of [['investment','invest'],['benefit','benefit'],['cost','cost']]){
      if(data[field]!=null) cards.push({key:'other_'+group,values:{amount:data[field]},note:'原有汇总金额'});
    }
    if(withLabor && data.people!=null && data.salary!=null && data.months!=null){
      cards.push({key:'labor',values:{persons:data.people,salary:data.salary,months:data.months,factor:1}});
    }
    return cards;
  }
  function legacyYear(p){
    if(p.legacy_book_year) return p.legacy_book_year;
    if(!p.books?.plan && !summaryCards(p.plan,true).length) return null;
    const dated=Object.keys({...p.annual,...p.books}).filter(y=>/^(20|21)\d{2}$/.test(y)).sort();
    return dated[0] || p.plan.due?.slice(0,4) || p.updated_at?.slice(0,4);
  }
  function years(p){
    return [...new Set([...Object.keys({...p.annual,...p.books,...p.ledger}),legacyYear(p)])]
      .filter(y=>/^(20|21)\d{2}$/.test(y)).sort().reverse();
  }
  function cardsFor(p,year){
    if(Array.isArray(p.ledger?.[year])) return p.ledger[year];
    const itemized=p.books?.[year];
    const recorded=itemized || summaryCards(p.annual?.[year]||{});
    if(year!==legacyYear(p) || (itemized && !itemized.length)) return recorded;
    const original=p.books?.plan || summaryCards(p.plan,true);
    // A group total with no itemization cannot be attributed to a particular card.
    const carry=original.filter(card=>{
      const group=defs[card.key].type;
      return !recorded.some(r=>r.key===card.key || (defs[r.key].type===group &&
        (card.key==='other_'+group || r.key==='other_'+group)));
    });
    return [...recorded,...carry];
  }
  function totals(p,period){
    const cards=cardsFor(p,period);
    const values={invest:null,benefit:null,cost:null,labor:null,otherBenefit:null};
    for(const card of cards){
      const group=defs[card.key].type, value=amount(card);
      values[group]=(values[group]??0)+value;
      if(group==='benefit'){
        const field=card.key==='labor'?'labor':'otherBenefit';
        values[field]=(values[field]??0)+value;
      }
    }
    return values;
  }
  window.ProjectFinance={defs,groups,amount,cardsFor,totals,years};
})();
