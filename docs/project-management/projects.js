(function(){
  'use strict';
  const $ = id => document.getElementById(id);
  const session = SessionStore.get();
  const path = 'project-management/index.html';
  const login = '../login.html?next=' + encodeURIComponent(path);
  const labels = {planned:'计划中',active:'进行中',paused:'已暂停',done:'已完成',terminated:'已终止'};
  const finance = window.ProjectFinance;
  let section = 'progress';
  const money = new Intl.NumberFormat('zh-CN', {maximumFractionDigits:2});
  const cardMoney = new Intl.NumberFormat('zh-CN', {maximumFractionDigits:6});
  let client, records = [], current = null, busy = false, dirty = false, ready = false;
  let canViewAll = false;
  let bookYear, expandedKey='equipment';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const today = () => new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date());
  const beijingTime=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const formatTime=value=>beijingTime.format(new Date(value));
  const latestStatus=p=>(p.status_history||[]).filter(e=>e.to).at(-1);
  const tag = stage => `<span class="tag ${esc(stage)}">${esc(labels[stage])}</span>`;
  const stat = (name,value) => `<div class="stat">${esc(name)}<strong>${esc(value)}</strong></div>`;
  const field = (name,label,value='',type='text',attrs='') => `<label>${esc(label)}<input name="${name}" type="${type}" value="${esc(value)}" ${attrs}></label>`;
  const area = (name,label,value='',attrs='') => `<label class="wide">${esc(label)}<textarea name="${name}" maxlength="1500" ${attrs}>${esc(value)}</textarea></label>`;
  const button = (action,label,primary=false) => `<button type="submit" name="action" value="${action}"${primary?' class="primary"':''}>${label}</button>`;
  const panel = (title,body) => `<section class="panel"><h2>${esc(title)}</h2>${body}</section>`;

  function notice(message='',signIn=false){
    $('notice').hidden = !message;
    $('notice').textContent = message;
    if(signIn){
      const link = document.createElement('a');
      link.href = login;
      link.textContent = '前往登录';
      link.onclick = () => SessionStore.clear();
      $('notice').append(link);
    }
    if(message) $('notice').focus();
  }

  function reportError(error){
    if(error.code==='PGRST202'){
      notice('项目管理接口尚未部署，请联系管理员安装项目管理数据库脚本。');
    }else{
      const msg = error.message || '连接失败，请稍后重试';
      notice(msg,/重新登录/.test(msg));
    }
  }

  async function rpc(name,params){
    if(SessionStore.get()?.token !== session.token) throw Error('登录账号已变化，请重新登录');
    const {data,error} = await client.rpc(name,{p_token:session.token,...params});
    if(SessionStore.get()?.token !== session.token) throw Error('登录账号已变化，请重新登录');
    if(error) throw error;
    return data;
  }


  function byDate(p){
    return [...p.progress].reverse().sort((a,b)=>b.date.localeCompare(a.date));
  }

  function ownerLabel(p){
    return p.owner_name && p.owner_name!==p.owner_account
      ? p.owner_name+'（'+p.owner_account+'）' : p.owner_account || '原账号已删除';
  }

  function renderOverview(){
    const query=$('overview-search').value.trim().toLowerCase(), stage=$('overview-stage').value;
    const mine=!canViewAll || $('scope').value==='mine', year=$('overview-year').value;
    const filtered=records.filter(p=>(!mine || p.owner_account===session.account) &&
      (!stage || p.status===stage) && (!query || [p.plan.title,ownerLabel(p),...p.progress.map(e=>e.note)]
        .some(value=>value.toLowerCase().includes(query))));
    const values=filtered.map(p=>({p,figures:yearFigures(p,year)}));
    const totals={invest:null,net:null};
    for(const {figures} of values){
      for(const key of Object.keys(totals)) if(figures[key]!=null) totals[key]=(totals[key]??0)+figures[key];
    }
    const rows=values.map(({p,figures})=>{
      const latest=byDate(p)[0];
      const changed=latestStatus(p);
      return `<tr><th scope="row"><a href="?project=${encodeURIComponent(p.id)}&amp;year=${esc(year)}">${esc(p.plan.title)}</a><small>${esc(ownerLabel(p))}</small></th>
        <td>${tag(p.status)}${changed?`<small>${formatTime(changed.at)}</small>`:''}</td><td class="num">${amount(figures.invest)}</td><td class="num">${amount(figures.benefit)}</td>
        <td class="num">${amount(figures.net)}</td><td>${esc(p.plan.due||'—')}</td>
        <td>${latest?`<small>${esc(latest.date)}</small>${esc(latest.note)}`:'—'}</td></tr>`;
    }).join('');
    const active=filtered.filter(p=>p.status==='active').length, done=filtered.filter(p=>p.status==='done').length;
    $('overview-results').innerHTML=`<div class="project-stats">${stat(mine?'我的项目':'全部项目',filtered.length)}
      ${stat('进行中 / 已完成',active+' / '+done)}${stat('本年投入合计（万元）',amount(totals.invest))}
      ${stat('本年净收益合计（万元）',amount(totals.net))}</div>
      <div class="table-wrap"><table class="overview-table"><caption>${esc(year)} 年项目清单 · 金额单位为万元</caption>
      <thead><tr><th>项目 / 所属人</th><th>状态</th><th class="num">本年投入</th><th class="num">本年收益</th>
      <th class="num">本年净收益</th><th>计划完成日</th><th>最近进展</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
      ${rows?'':'<p class="empty">当前范围内没有符合条件的项目。</p>'}`;
  }

  function showOverview(){
    current=null;dirty=false;
    $('detail').replaceChildren();
    $('ledger').hidden=$('detail').hidden=true;
    $('overview').hidden=false;
    $('scope-label').hidden=!canViewAll;
    const select=$('overview-year'), previous=select.value, thisYear=today().slice(0,4);
    const years=new Set([thisYear]);
    for(const p of records){
      for(const y of finance.years(p)) years.add(y);
    }
    select.innerHTML=[...years].sort().reverse().map(y=>`<option>${esc(y)}</option>`).join('');
    select.value=years.has(previous)?previous:thisYear;
    renderOverview();
  }

  function renderList(){
    $('counts').textContent=records.length+' 个项目';
    const status = $('stage').value, query = $('search').value.trim().toLowerCase();
    const filtered = records.filter(p=>(!status || p.status===status) && (!query ||
      [p.plan.title,...p.progress.map(entry=>entry.note)].some(value=>value.toLowerCase().includes(query))));
    if(!filtered.length){
      $('rows').innerHTML = `<p class="empty">${records.length?'没有符合条件的项目':'台账里还没有项目，点击「登记项目」即可开始记录。'}</p>`;
      return;
    }
    $('rows').innerHTML=filtered.map(p=>`<button class="directory-project" data-open="${esc(p.id)}" aria-current="${current?.id===p.id}">
      <strong>${esc(p.plan.title)}</strong><small>${tag(p.status)}<span>${p.plan.due?esc(p.plan.due)+' 到期':'未设完成日'}</span></small></button>`).join('');

  }

  async function loadList(){
    if(busy) return;
    busy = true;
    $('refresh').disabled = $('new').disabled = true;
    notice();
    try{
      records = await rpc('pm_list',{});
      ready = true;
      canViewAll = records.length?records[0].can_view_all===true:session.level===1;
      const requested=new URLSearchParams(location.search).get('project');
      const selected=records.find(p=>p.id===(current?.id||requested));
      if(selected) show(selected,'book');
      else {
        showOverview();
        if(requested) notice('项目不存在或当前账号无访问权限。');
      }
    }catch(error){
      records=[];current=null;dirty=false;ready=false;
      $('detail').replaceChildren();$('overview-results').replaceChildren();
      $('detail').hidden=$('overview').hidden=true;$('ledger').hidden=false;
      $('counts').textContent='';$('rows').textContent='台账尚未载入。';
      reportError(error);
    }finally{
      busy = false;
      $('refresh').disabled = false;
      $('new').disabled = !ready;
    }
  }


  const amount = value => value == null ? '—' : money.format(value);
  function yearFigures(p,year){
    const v=finance.totals(p,year);
    const net=v.benefit==null && v.cost==null?null:(v.benefit??0)-(v.cost??0);
    const roi=net!=null && v.invest>0?amount(net/v.invest*100)+'%':'—';
    const payback=net>0 && v.invest>0?amount(v.invest/net*12)+' 个月':'—';
    return {...v,net,roi,payback};
  }
  function planEditor(p){
    const v = p.plan;
    const options = Object.entries(labels).map(([key,label])=>`<option value="${key}" ${p.status===key?'selected':''}>${label}</option>`).join('');
    return `<form id="plan-form">${panel('项目资料',`<div class="grid">
      ${field('title','项目名称',v.title,'text','required maxlength="100"')}
      <label>项目状态<select name="status">${options}</select></label>
      <div id="status-clock" ${p.revision?'hidden':''}>${field('effective_at',p.revision?'状态生效时间':'创建时间','','datetime-local')}
        <small>北京时间，留空取保存时刻。</small></div>
      ${field('due','计划完成日',v.due,'date')}
      ${area('problem','项目背景',v.problem)}${area('target','预期目标',v.target)}</div>`)}
      ${panel('测算依据',area('basis','数据来源或假设',v.basis))}
      <div class="actions">${button(p.revision?'save':'create',p.revision?'保存资料':'保存项目',true)}</div></form>`;
  }

  function eventName(e){
    if(e.kind==='created') return e.to?'创建项目 · '+labels[e.to]:'创建项目';
    return e.from?labels[e.from]+' → '+labels[e.to]:labels[e.to];
  }
  function historyView(p){
    const events=p.status_history||[];
    const rows=[...events].reverse().map(e=>`<li><div><strong>${esc(eventName(e))}</strong>
      <p>${formatTime(e.at)}</p></div><button type="button" data-time-id="${esc(e.id)}">修改时间</button></li>`).join('');
    const missing=[];
    if(!events.some(e=>e.kind==='created')) missing.push('<button type="button" data-missing="created">补录创建时间</button>');
    if(!latestStatus(p)) missing.push(`<button type="button" data-missing="status">补录「${esc(labels[p.status])}」时间</button>`);
    return panel('状态记录（北京时间）',`<ul class="tasks">${rows}</ul>
      ${rows?'':'<p class="muted">尚无时间记录。</p>'}<div class="actions">${missing.join('')}</div>
      <form id="time-form" hidden><label><span id="time-label"></span><input name="effective_at" type="datetime-local"></label>
        <small>留空取保存时刻。</small><div class="actions">${button('status_time','保存时间',true)}
        <button type="button" id="cancel-time">取消</button></div></form>`);
  }

  function breakdown(card,index){
    const def=finance.defs[card.key], lines=card.lines||[];
    const rows=lines.map(l=>`<tr><td>${esc(l.name)}</td><td>${esc(l.qty)}</td><td>${amount(l.price)}</td><td>${amount(l.qty*l.price)}</td><td>${esc(l.note||'—')}</td></tr>`).join('');
    return `<div class="breakdown"><div class="break-head"><b>${lines.length?lines.length+' 笔明细':'科目记录'}</b>
      <button type="button" class="link" data-edit-card="${index}">编辑科目</button></div>
      ${rows?`<div class="table-wrap"><table class="entries"><thead><tr><th>名称</th><th>数量</th><th>单价（元）</th><th>小计（元）</th><th>备注</th></tr></thead><tbody>${rows}</tbody></table></div>`:
      `<p class="parameters">${def.fields.map(f=>esc(f.label)+' '+esc(card.values[f.key]??'—')+' '+esc(f.unit)).join('　 ')}${def.calcFn?' · '+esc(def.formula):''}</p>`}
      ${card.note?`<p class="parameters">${esc(card.note)}</p>`:''}
      ${def.detail && (lines.length || !finance.amount(card))?`<form class="quick-line" data-index="${index}">
        ${field('lineName','明细名称','','text','required maxlength="120" placeholder="新增一笔"')}
        ${field('qty','数量',1,'number','required min="0.000001" step="any"')}
        ${field('price','单价（元）','','number','required min="0" step="0.01"')}
        ${field('lineNote','备注','','text','maxlength="300"')}
        <button type="submit" class="primary">保存一笔</button></form>`:''}</div>`;
  }
  function bookView(p){
    const cards=finance.cardsFor(p,bookYear), totals=finance.totals(p,bookYear);
    const groupNames={invest:'一次性投入',benefit:'年度收益',cost:'年度运行成本'};
    const summary=Object.entries(groupNames).map(([group,label])=>`<tr><th scope="row"><a href="#group-${group}">${label}</a></th><td>${amount(totals[group])}</td></tr>`).join('');
    const groups=Object.entries(groupNames).map(([group,label])=>{
      const rows=cards.map((card,index)=>{
        const def=finance.defs[card.key];
        if(def.type!==group) return '';
        return `<details class="account-row" data-key="${card.key}" ${expandedKey===card.key?'open':''}>
          <summary class="ledger-cols"><span>${esc(def.name)}</span><span>${cardMoney.format(finance.amount(card))}</span></summary>
          ${breakdown(card,index)}</details>`;
      }).join('');
      return `<section class="account-group" id="group-${group}"><div class="ledger-cols group-line"><h3>${label}</h3><b>${amount(totals[group])}</b></div>
        ${rows}<button class="add-item" type="button" data-add-card="${group}">＋ 添加科目</button></section>`;
    }).join('');
    return `<section class="book-panel"><div class="book-head"><h2>年度收支</h2><div class="book-controls">
      <label>记账年度<input id="book-year" type="number" min="2000" max="2199" required value="${bookYear}"></label></div></div>
      <p class="muted entry-help">金额待确定时可先填估值，确认后编辑原记录。</p>
      <table class="balance"><thead><tr><th>项目汇总</th><th>金额（万元）</th></tr></thead><tbody>${summary}</tbody></table>
      <div class="ledger-cols column-names"><span>科目明细</span><span>金额（万元）</span></div>${groups}</section>`;
  }

  const dialog=$('card-dialog');
  let cardIndex=null, cardChanged=false;
  function readCard(){
    const form=$('card-form'), values={};
    for(const input of form.querySelectorAll('[data-parameter]')){
      const value=input.disabled?input.dataset.manual:input.value;
      if(value!=null && value!=='') values[input.name]=Number(value);
    }
    const lines=Array.from(form.querySelectorAll('.line-entry'),row=>({
      name:row.querySelector('[name=lineName]').value.trim(),qty:Number(row.querySelector('[name=qty]').value||1),
      price:Number(row.querySelector('[name=price]').value),note:row.querySelector('[name=lineNote]').value.trim()
    }));
    return {key:form.elements.kind.value,values,lines,note:form.elements.note.value.trim()};
  }
  function lineEntry(line={}){
    return `<div class="line-entry">
      ${field('lineName','名称',line.name,'text','required maxlength="120" placeholder="如：电批控制器"')}
      ${field('qty','数量',line.qty??1,'number','min="0.000001" step="any" required')}
      ${field('price','单价（元）',line.price,'number','min="0" step="0.01" required')}
      ${field('lineNote','备注',line.note,'text','maxlength="300"')}
      <div class="line-result"><output></output><button type="button" data-remove-line>移除此笔</button></div></div>`;
  }
  function cardFields(c){
    const def=finance.defs[c.key];
    const defaults={factor:1.5,months:12,days:250,price:0.8,ratio:5};
    const fields=def.fields.map(f=>{
      const useDefault=f.key!=='months'||['labor','overtime','operator'].includes(c.key);
      const value=c.values[f.key]??(useDefault?defaults[f.key]:undefined);
      const max=f.unit==='%'?100:f.key==='months'&&useDefault?12:999999999;
      return field(f.key,f.label+(f.unit?`（${f.unit}）`:''),value,'number',`data-parameter required min="0" max="${max}" step="any"`);
    });
    return `<div class="grid">${fields.join('')}</div>
      ${def.calcFn?`<p class="formula">${esc(def.formula)}</p>`:''}
      ${def.detail?`<div class="lines-box"><div class="subhead"><h3>逐笔明细</h3><button type="button" id="add-line">＋ 添加一笔</button></div>
        <p class="muted">可直接填总额，也可逐笔填数量和单价。添加明细后按明细合计。</p>
        <div id="line-entries">${(c.lines||[]).map(lineEntry).join('')}</div></div>`:''}`;
  }
  function updateSubtotal(){
    const card=readCard(), direct=$('card-form').elements.amount;
    if(direct && card.lines.length){
      if(!direct.disabled) direct.dataset.manual=direct.value;
      direct.disabled=true;
      direct.value=Number(finance.amount(card).toFixed(6));
    }else if(direct?.disabled){
      direct.disabled=false;
      direct.value=direct.dataset.manual||'';
    }
    const rows=$('card-form').querySelectorAll('.line-entry');
    card.lines.forEach((line,i)=>{rows[i].querySelector('output').textContent='小计 '+amount(line.qty*line.price)+' 元';});
    $('card-subtotal').textContent=cardMoney.format(finance.amount(readCard()))+' 万元';
  }
  function openCard(target){
    const cards=finance.cardsFor(current,bookYear);
    cardIndex=target.hasAttribute('data-edit-card')?Number(target.dataset.editCard):null;
    const existing=cardIndex!=null?cards[cardIndex]:null;
    const group=existing?finance.defs[existing.key].type:target.dataset.addCard;
    const kinds=Object.entries(finance.defs).filter(([,d])=>d.type===group);
    const c=existing||{key:kinds[0][0],values:{}};
    const options=kinds.map(([key,d])=>`<option value="${key}" ${c.key===key?'selected':''}>${esc(d.name)}</option>`).join('');
    dialog.innerHTML=`<form id="card-form"><div class="modal-head"><div><small>${esc(bookYear)+' 年'} · ${finance.groups[group]}</small>
      <h2 id="card-title">${existing?'编辑科目':'添加科目'}</h2></div><button type="button" data-close aria-label="关闭">×</button></div>
      <div class="modal-body"><label>收支科目<select name="kind">${options}</select></label>
      <div id="card-fields">${cardFields(c)}</div>${area('note','科目备注',c.note)}</div>
      <div class="modal-footer"><div><small>科目小计</small><strong id="card-subtotal"></strong></div>
      <div class="modal-actions">${existing?'<button type="button" id="remove-card">删除科目</button>':''}<button class="primary" type="submit">保存科目</button></div></div>
      <p id="card-error" role="alert" hidden></p></form>`;
    cardChanged=false;
    updateSubtotal();
    dialog.showModal();
  }
  function closeCard(){
    if(busy || (cardChanged && !confirm('放弃尚未保存的科目修改？'))) return;
    dialog.close();
  }
  async function saveBook(cards){
    if(busy) return;
    dialog.inert=true;
    try{
      if(await apply('book',{period:bookYear,cards})){
        cardChanged=false;dialog.close();
      }else{
        const err=$('card-error');err.hidden=false;err.textContent=$('notice').textContent;
      }
    }finally{dialog.inert=false;}
  }
  dialog.addEventListener('cancel',event=>{event.preventDefault();closeCard();});
  dialog.addEventListener('close',()=>{if(!dialog.open) dialog.replaceChildren();});
  dialog.addEventListener('click',event=>{
    const target=event.target.closest('button');
    if(!target||busy)return;
    if(target.hasAttribute('data-close')) closeCard();
    if(target.id==='add-line'){
      $('line-entries').insertAdjacentHTML('beforeend',lineEntry());
      $('line-entries').lastElementChild.querySelector('input').focus();
      cardChanged=true;updateSubtotal();
    }
    if(target.hasAttribute('data-remove-line')){
      target.closest('.line-entry').remove();cardChanged=true;updateSubtotal();
    }
    if(target.id==='remove-card' && confirm('删除此科目及其明细记录？')){
      const cards=finance.cardsFor(current,bookYear).filter((_,i)=>i!==cardIndex);saveBook(cards);
    }
  });
  dialog.addEventListener('input',event=>{
    if(event.target.name==='kind')return;
    cardChanged=true;updateSubtotal();
  });
  dialog.addEventListener('change',event=>{
    if(event.target.name!=='kind')return;
    const select=event.target, previous=select.dataset.previous||select.querySelector('option[selected]').value;
    if((cardChanged||cardIndex!=null) && !confirm('切换科目会清除当前科目的金额和明细，是否继续？')){
      select.value=previous;return;
    }
    select.dataset.previous=select.value;
    $('card-fields').innerHTML=cardFields({key:select.value,values:{}});
    cardChanged=true;updateSubtotal();
  });
  dialog.addEventListener('submit',event=>{
    event.preventDefault();
    const card=readCard();
    const cards=finance.cardsFor(current,bookYear).slice();
    if(cardIndex===null) cards.push(card);else cards[cardIndex]=card;
    saveBook(cards);
  });


  function progress(p){
    const rows = byDate(p).map(e=>`<li><div><small>${esc(e.date)}</small><p>${esc(e.note)}</p></div>
      <button type="button" data-entry="${esc(e.id)}">编辑</button></li>`);
    return panel('记一条进展',`<form id="progress-form" data-entry-id="">
      <div class="grid">${field('date','发生日期',today(),'date','required')}${area('note','进展内容','','required')}</div>
      <div class="actions">${button('progress','保存进展',true)}<button type="button" id="cancel-edit" hidden>取消编辑</button></div></form>`) +
      panel('进展记录',rows.length?`<ul class="tasks">${rows.join('')}</ul>`:'<p class="muted">尚未记录进展。</p>');
  }
  function annualTable(p,editable){
    const years=finance.years(p);
    const rows = [...years].sort((a,b)=>b-a).map(year=>{
      const t=yearFigures(p,year);
      const r={...p.annual[year],investment:t.invest,benefit:t.benefit,cost:t.cost};
      const net=t.net;
      return `<tr><td>${esc(year)}</td><td data-label="实际投入">${amount(r.investment)}</td><td data-label="实际收益">${amount(r.benefit)}</td><td data-label="运行成本">${amount(r.cost)}</td><td data-label="净收益">${amount(net)}</td><td data-label="备注">${esc(r.note || '—')}</td>
        ${editable?`<td><button type="button" data-year="${esc(year)}">编辑</button></td>`:''}</tr>`;
    });
    return rows.length?`<div class="table-wrap"><table><thead><tr><th>年度</th><th>投入</th><th>收益</th><th>运行成本</th><th>净收益</th><th>备注</th>${editable?'<th></th>':''}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`:'<p class="muted">尚未登记年度数据。</p>';
  }
  function annual(p){
    return panel('历年收支（万元）',annualTable(p,true)) +
      panel('年度备注',`<form id="annual-form"><div class="grid">
      ${field('year','年度',bookYear,'number','min="2000" max="2199" required')}
      ${area('note','成效或备注',p.annual[bookYear]?.note)}</div>
      <div class="actions"><button type="button" id="annual-book">打开本年收支明细</button>${button('annual','保存备注',true)}</div></form>`);
  }

  function show(p,view='book'){
    const requestedYear=new URLSearchParams(location.search).get('year');
    if(!bookYear) bookYear=/^(20|21)\d{2}$/.test(requestedYear)?requestedYear:today().slice(0,4);
    current = p;
    section = p.revision?view:'plan';
    dirty = false;
    $('ledger').hidden = false;
    $('overview').hidden = true;
    $('detail').hidden = false;
    if(p.revision){
      const url=new URL(location.href);url.searchParams.set('project',p.id);url.searchParams.set('year',bookYear);
      history.replaceState(null,'',url);
    }
    renderList();
    const sections = {book:'收支明细',progress:'进展记录',plan:'项目资料',history:'状态记录',annual:'历年收支'};
    const tabs = Object.entries(sections).map(([key,label])=>`<button type="button" data-view="${key}" aria-pressed="${section===key}">${label}</button>`);
    const latest=byDate(p)[0], v=yearFigures(p,bookYear);
    $('detail').innerHTML = `<button id="back" class="back">返回台账</button><div class="heading">
      <h1>${esc(p.plan.title || '登记项目')}</h1>${p.revision?tag(p.status):''}</div>
      ${p.revision?`<div class="project-meta">所属人　${esc(ownerLabel(p))}　 ·　计划完成　${esc(p.plan.due||'—')}</div>
      <div class="project-stats">${stat(bookYear+' 年投入（万元）',amount(v.invest))}${stat('本年净收益（万元）',amount(v.net))}
      ${stat('静态回收期',v.payback)}${stat('本年 ROI',v.roi)}</div>
      <div class="latest"><small>最近进展</small><span>${latest?esc(latest.date)+'　'+esc(latest.note):'暂无记录'}</span>
      <button class="link" data-view="progress">记进展</button></div>
      <div class="actions views" role="group" aria-label="项目记录栏目">${tabs.join('')}</div>`:''}
      ${section==='plan'?planEditor(p):section==='progress'?progress(p):section==='book'?bookView(p):section==='history'?historyView(p):annual(p)}`;
    if(section==='annual') selectYear(bookYear);
    if(!busy && matchMedia('(max-width:760px)').matches) $('detail').scrollIntoView({block:'start'});
  }

  function formValues(form){
    const data = Object.fromEntries(new FormData(form));
    for(const input of form.querySelectorAll('input[type=number]')) data[input.name] = input.value === '' ? null : input.valueAsNumber;
    return data;
  }

  async function apply(action,input){
    if(busy) return;
    busy = true;
    $('detail').inert = true;
    notice();
    try{
      const p = await rpc('pm_apply',{p_id:current.id,p_revision:current.revision,p_action:action,p_input:input});
      p.owner_name=records.find(item=>item.id===p.id)?.owner_name || (p.owner_account===session.account?session.name:null);
      records = [p,...records.filter(item=>item.id!==p.id)];
      if(action==='annual') bookYear=String(input.year);
      show(p,action==='create'?'book':section);
      notice('记录已保存。');
      return true;
    }catch(error){
      reportError(error);
      if(/重新载入/.test(error.message || '')){
        const reload = document.createElement('button');
        reload.textContent = '返回台账并刷新';
        reload.onclick = async () => {if(back()) await loadList();};
        $('notice').append(reload);
      }
    }finally{
      busy = false;
      $('detail').inert = false;
    }
  }

  function back(){
    if(busy || (dirty && !confirm('放弃当前未保存的填写内容？'))) return false;
    dirty = false;
    current = null;
    notice();
    const url=new URL(location.href);url.searchParams.delete('project');
    history.replaceState(null,'',url);
    showOverview();
    $('overview-new').focus();
    return true;
  }

  if(!session){location.replace(login);return;}
  window.addEventListener('storage',()=>{
    if(SessionStore.get()?.token!==session.token) location.reload();
  });
  if(SessionStore.guardPwd('../changepwd.html?next='+encodeURIComponent(path))) return;
  $('identity').textContent = session.name || session.account;
  if(session.guest || !session.token){
    $('ledger').hidden = true;
    notice('请使用正式账号登录后查看自己的项目记录。',true);
    return;
  }
  try{localStorage.setItem('last_tool','project-management');}catch{}
  client = window.supabase.createClient(AppConfig.supabaseUrl,AppConfig.supabaseKey);
  $('refresh').onclick = ()=>{if(canSwitch()) loadList();};
  $('overview-refresh').onclick=loadList;
  for(const id of ['overview-search','overview-stage','scope','overview-year']) $(id).oninput=renderOverview;
  $('overview-new').onclick=()=>$('new').click();
  for(const id of ['stage','search']) $(id).addEventListener('input',()=>{if(ready) renderList();});
  $('new').onclick = ()=>{
    if(busy || !canSwitch()) return;
    notice();
    show({id:crypto.randomUUID(),revision:0,status:'planned',plan:{},progress:[],annual:{}});
    $('plan-form').elements.title.focus();
  };
  $('rows').onclick = event=>{
    const item=event.target.closest('[data-open]');
    if(!item || busy || !canSwitch()) return;
    expandedKey='equipment';notice();
    show(records.find(p=>p.id===item.dataset.open));
  };

  const canSwitch = () => !dirty || confirm('放弃当前未保存的填写内容？');
  function selectYear(year){
    const form = $('annual-form'), r = current.annual[year] || {};
    form.elements.year.value = year;
    form.elements.note.value=r.note??'';
    form.dataset.year = year;
    dirty = false;
  }
  $('detail').onclick = event=>{
    const target = event.target.closest('button');
    if(!target || busy) return;
    if(target.id==='back') return back();
    if(target.id==='cancel-time' && canSwitch()) return show(current,'history');
    if(target.dataset.timeId || target.dataset.missing){
      if(!canSwitch()) return;
      const form=$('time-form'),entry=(current.status_history||[]).find(e=>e.id===target.dataset.timeId);
      form.dataset.id=entry?.id||'';
      form.dataset.missing=target.dataset.missing||'';
      $('time-label').textContent=entry?eventName(entry):target.textContent;
      form.elements.effective_at.value=entry?formatTime(entry.at).replace(' ','T'):'';
      form.hidden=false;dirty=false;form.elements.effective_at.focus();return;
    }
    if(target.dataset.addCard || target.hasAttribute('data-edit-card')){if(canSwitch()) openCard(target);return;}
    if(target.id==='annual-book'){
      const year=$('annual-form').elements.year;
      if(year.reportValidity() && canSwitch()){bookYear=year.value;show(current,'book');}
      return;
    }
    if(target.dataset.view && target.dataset.view!==section && canSwitch()) show(current,target.dataset.view);
    if(target.matches('.latest [data-view="progress"]')) $('progress-form')?.elements.note.focus();
    if(target.id==='cancel-edit' && canSwitch()) show(current,'progress');
    if(target.dataset.entry && canSwitch()){
      const entry = current.progress.find(e=>e.id===target.dataset.entry);
      const form = $('progress-form');
      form.dataset.entryId = entry.id;
      for(const k of ['date','note']) form.elements[k].value = entry[k];
      form.closest('section').querySelector('h2').textContent = '编辑进展';
      $('cancel-edit').hidden = false;
      form.elements.note.focus();
      dirty = false;
    }
    if(target.dataset.year && canSwitch()){
      selectYear(target.dataset.year);
      $('annual-form').elements.note.focus();
    }
  };
  $('detail').oninput = event=>{
    if(event.target.name && event.target.name!=='year') dirty = true;
    if(event.target.form?.matches('.quick-line')) event.target.form.dataset.edited='true';
  };
  $('detail').onchange = event=>{
    const input = event.target;
    if(input.name==='status'){
      $('status-clock').hidden=!!current.revision && input.value===current.status;
      if($('status-clock').hidden) input.form.elements.effective_at.value='';
    }
    if(input.id==='book-year'){
      if(!input.reportValidity()) return;
      if(!canSwitch()){input.value=bookYear;return;}
      bookYear=input.value;show(current,'book');return;
    }
    if(input.name==='year' && input.validity.valid){
      const previous = input.form.dataset.year || today().slice(0,4);
      if(input.value===previous) return;
      if(canSwitch()) selectYear(input.value);
      else input.value = previous;
    }
  };
  $('detail').onsubmit = event=>{
    event.preventDefault();
    const form = event.target, action = event.submitter?.value;
    if(form.matches('.quick-line')){
      const otherDraft=[...$('detail').querySelectorAll('.quick-line[data-edited]')].some(other=>other!==form);
      if(otherDraft && !confirm('保存这一笔时将放弃其他科目尚未保存的输入，是否继续？')) return;
      const cards=finance.cardsFor(current,bookYear).slice(), index=Number(form.dataset.index);
      const line={name:form.elements.lineName.value.trim(),qty:form.elements.qty.valueAsNumber,price:form.elements.price.valueAsNumber,note:form.elements.lineNote.value.trim()};
      cards[index]={...cards[index],lines:[...(cards[index].lines||[]),line]};
      expandedKey=form.closest('details').dataset.key;
      apply('book',{period:bookYear,cards});return;
    }
    if(!action) return;
    const values = formValues(form);
    if(form.id==='plan-form'){
      const {status,effective_at,...plan} = values;
      apply(action,{status,effective_at:effective_at?effective_at+'+08:00':null,plan:{...current.plan,...plan}});
    }else if(form.id==='time-form'){
      const ref=form.dataset.id?{id:form.dataset.id}:{missing:form.dataset.missing};
      apply('status_time',{...ref,effective_at:values.effective_at?values.effective_at+'+08:00':null});
    }else{
      if(form.dataset.entryId) values.id = form.dataset.entryId;
      apply(action,values);
    }
  };
  window.addEventListener('beforeunload',event=>{if(dirty || (dialog.open && cardChanged)){event.preventDefault();event.returnValue='';}});
  loadList();
})();
