/**
 * 设备履历卡 - 界面逻辑(移动优先,电脑端双栏)
 */
var EQ = {};              // {code: data}
var canEdit = false;
var currentCode = '';     // 当前查看的设备编号
var currentRecordId = ''; // 正在编辑的履历(空=新增)
var editingArchive = false;
var qrLibReady = false;

var TYPES = {
    fault: { txt: '故障维修' },
    maintain: { txt: '定期保养' },
    overhaul: { txt: '大修' },
    modify: { txt: '改造' },
    inspect: { txt: '点检' }
};
var CAUSES = {
    '': '未分类',
    mechanical: '机械',
    electrical: '电气',
    pneumatic: '气动',
    hydraulic: '液压',
    software: '软件/程序',
    operation: '操作不当',
    wear: '备件老化',
    other: '其他'
};
var STATUS = { active: '在用', idle: '闲置', scrapped: '报废' };
var QUICK_SYMPTOMS = ['伺服报警停机', '气缸漏气', '传感器无信号', '定位精度偏差', '异响', '过热', '通讯中断', '皮带跑偏'];

// ---------- 工具 ----------
function $(id) { return document.getElementById(id); }
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function money(n) { n = Number(n) || 0; return '¥' + n.toLocaleString('zh-CN', { maximumFractionDigits: 2 }); }
function num(n) { return Number(n) || 0; }
function today() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function showToast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(window._toastT);
    window._toastT = setTimeout(function () { t.classList.remove('show'); }, 2200);
}
function switchView(name) {
    var vs = document.querySelectorAll('.view');
    for (var i = 0; i < vs.length; i++) vs[i].classList.remove('show');
    var el = $('view-' + name);
    if (el) el.classList.add('show');
    window.scrollTo(0, 0);
}

// ---------- 统计 ----------
function recordCost(r) {
    var s = 0;
    var ps = r.parts || [];
    for (var i = 0; i < ps.length; i++) s += num(ps[i].qty || 1) * num(ps[i].price);
    return s + num(r.laborFee) + num(r.outsourceFee);
}
function computeStats(eq) {
    var recs = (eq.records || []).slice().sort(function (a, b) { return (a.date || '') < (b.date || '') ? 1 : -1; });
    var total = 0, partsCost = 0, faultCount = 0, downHours = 0, faultDown = 0;
    var first = '', last = '';
    for (var i = 0; i < recs.length; i++) {
        var r = recs[i];
        total += recordCost(r);
        var ps = r.parts || [];
        for (var j = 0; j < ps.length; j++) partsCost += num(ps[j].qty || 1) * num(ps[j].price);
        downHours += num(r.downHours);
        if (r.type === 'fault') { faultCount++; faultDown += num(r.downHours); }
        if (r.date) {
            if (!first || r.date < first) first = r.date;
            if (!last || r.date > last) last = r.date;
        }
    }
    var spanDays = 0;
    if (first) {
        var d1 = new Date(first).getTime();
        var d2 = Math.max(new Date(last || today()).getTime(), Date.now());
        spanDays = Math.max(1, Math.round((d2 - d1) / 86400000));
    }
    return {
        count: recs.length,
        total: total,
        partsCost: partsCost,
        faultCount: faultCount,
        downHours: downHours,
        mtbf: faultCount > 0 ? Math.round(spanDays / faultCount) : 0,
        mttr: faultCount > 0 ? (faultDown / faultCount) : 0,
        lastDate: recs.length ? (recs[0].date || '') : ''
    };
}

// ---------- 启动 ----------
function eqInit() {
    var s = EquipApi.session();
    if (!s) {
        location.href = '../login.html?next=' + encodeURIComponent('equipment/index.html' + (getQuery('code') ? ('?code=' + getQuery('code')) : ''));
        return;
    }
    // 记住本工具,供登录页「直接进入上次使用的工具」使用
    try { localStorage.setItem('last_tool', 'equipment'); } catch (e) {}
    var u = EquipApi.user();
    $('eq-user').textContent = (u && u.name) || '';
    EquipApi.list().then(function (r) {
        if (!r.ok) {
            $('eq-list').innerHTML = '<div class="empty">' + esc(r.msg || '加载失败') + '</div>';
            return;
        }
        canEdit = !!r.canEdit;
        EQ = r.equipments || {};
        applyReadonly();
        renderList();
        var code = getQuery('code');
        if (code && EQ[code]) openDetail(code, true);
    });
}
function applyReadonly() {
    var b = $('ro-banner');
    if (canEdit) { b.classList.remove('show'); return; }
    b.classList.add('show');
    b.textContent = '只读模式:你没有设备履历的编辑权限,金额相关信息已隐藏';
}
function getQuery(k) {
    var m = location.search.match(new RegExp('[?&]' + k + '=([^&]*)'));
    return m ? decodeURIComponent(m[1]) : '';
}

// ---------- 列表 ----------
function renderList() {
    var q = ($('f-q').value || '').trim().toLowerCase();
    var line = $('f-line').value;
    var status = $('f-status').value;
    // 产线下拉
    var lines = {};
    for (var c in EQ) if (EQ[c].line) lines[EQ[c].line] = 1;
    var opts = '<option value="">全部产线</option>';
    for (var l in lines) opts += '<option value="' + esc(l) + '"' + (l === line ? ' selected' : '') + '>' + esc(l) + '</option>';
    $('f-line').innerHTML = opts;

    var codes = Object.keys(EQ).filter(function (c) {
        var e = EQ[c];
        if (line && e.line !== line) return false;
        if (status && (e.status || 'active') !== status) return false;
        if (!q) return true;
        return (c + ' ' + (e.name || '') + ' ' + (e.model || '') + ' ' + (e.owner || '')).toLowerCase().indexOf(q) > -1;
    });
    codes.sort(function (a, b) { return a < b ? -1 : 1; });
    $('eq-count').textContent = '共 ' + codes.length + ' 台';
    if (!codes.length) {
        $('eq-list').innerHTML = '<div class="empty">' + (Object.keys(EQ).length ? '没有匹配的设备' : '还没有设备,点「新增设备」开始建档') + '</div>';
        return;
    }
    var html = '';
    for (var i = 0; i < codes.length; i++) {
        var c = codes[i], e = EQ[c], st = computeStats(e);
        html += '<div class="eq-card' + (c === currentCode ? ' active' : '') + '" onclick="openDetail(\'' + esc(c) + '\')">'
            + '<div class="eq-card-main">'
            + '<div class="eq-card-name">' + esc(e.name || '(未命名)')
            + '<span class="st st-' + esc(e.status || 'active') + '">' + esc(STATUS[e.status] || '在用') + '</span></div>'
            + '<div class="eq-card-sub">' + esc(c) + ' · ' + esc(e.line || '未分产线') + ' · ' + esc(e.owner || '未指定责任人')
            + (canEdit ? (' · 最近 ' + (st.lastDate || '无记录')) : '') + '</div>'
            + '</div>'
            + (canEdit ? ('<div class="eq-card-stat"><div class="eq-card-cost">' + money(st.total) + '</div><div class="eq-card-cost-label">累计维修</div></div>') : '')
            + '</div>';
    }
    $('eq-list').innerHTML = html;
}

// ---------- 详情 ----------
function openDetail(code, keepScroll) {
    currentCode = code;
    var e = EQ[code];
    if (!e) { showToast('设备不存在'); return; }
    var st = computeStats(e);
    var head = '<div class="detail-head">'
        + '<div class="detail-title">' + esc(e.name || '(未命名)')
        + '<span class="st st-' + esc(e.status || 'active') + '">' + esc(STATUS[e.status] || '在用') + '</span></div>'
        + '<div class="detail-meta">'
        + '编号 ' + esc(code) + (e.model ? (' · 型号 ' + esc(e.model)) : '') + (e.vendor ? (' · 厂商 ' + esc(e.vendor)) : '') + '<br>'
        + '产线 ' + esc(e.line || '未填') + ' · 责任人 ' + esc(e.owner || '未填') + ' · 投用 ' + esc(e.installDate || '未填')
        + (e.remark ? ('<br>备注:' + esc(e.remark)) : '')
        + '</div>'
        + '<div class="detail-actions">'
        + (canEdit ? '<button class="btn btn-primary btn-sm" onclick="openRecordForm()">＋ 录入履历</button>' : '')
        + (canEdit ? '<button class="btn btn-sm" onclick="openArchiveForm(\'' + esc(code) + '\')">编辑档案</button>' : '')
        + '<button class="btn btn-sm" onclick="showLabels([\'' + esc(code) + '\'])">二维码</button>'
        + '<button class="btn btn-sm" onclick="openAudit()">编辑记录</button>'
        + (canEdit ? '<button class="btn btn-danger btn-sm" onclick="deleteEquipment(\'' + esc(code) + '\')">删除设备</button>' : '')
        + '</div></div>';

    var stats = '<div class="stat-grid">'
        + (canEdit ? '<div class="stat-box"><div class="stat-label">累计维修费</div><div class="stat-value">' + money(st.total) + '</div></div>' : '')
        + '<div class="stat-box"><div class="stat-label">维修次数</div><div class="stat-value">' + st.faultCount + ' 次</div></div>'
        + '<div class="stat-box"><div class="stat-label">累计停机</div><div class="stat-value">' + st.downHours.toFixed(1) + ' h</div></div>'
        + '<div class="stat-box"><div class="stat-label">MTBF 估算</div><div class="stat-value">' + (st.mtbf ? st.mtbf + ' 天' : '—') + '</div></div>'
        + '<div class="stat-box"><div class="stat-label">MTTR 平均修复</div><div class="stat-value">' + (st.mttr ? st.mttr.toFixed(1) + ' h' : '—') + '</div></div>'
        + '</div>';

    var recs = (e.records || []).slice().sort(function (a, b) { return (a.date || '') < (b.date || '') ? 1 : -1; });
    var tl = '';
    if (!recs.length) {
        tl = '<div class="empty">还没有履历记录</div>';
    } else {
        tl = '<div class="timeline">';
        for (var i = 0; i < recs.length; i++) {
            var r = recs[i];
            var cost = recordCost(r);
            tl += '<div class="tl-item">'
                + '<div class="tl-dot ' + esc(r.type || 'fault') + '"></div>'
                + '<div class="tl-body">'
                + '<div class="tl-top"><span class="tl-date">' + esc(r.date || '') + '</span>'
                + '<span class="tl-type">' + esc((TYPES[r.type] || TYPES.fault).txt) + '</span>'
                + (r.handler ? '<span class="tl-date">处理人 ' + esc(r.handler) + '</span>' : '')
                + (r.downHours ? '<span class="tl-date">停机 ' + num(r.downHours) + 'h</span>' : '')
                + '</div>'
                + '<div class="tl-symptom">' + esc(r.symptom || '(无描述)') + '</div>'
                + (r.action ? '<div class="tl-sub">处理:' + esc(r.action) + '</div>' : '')
                + ((r.parts && r.parts.length) ? '<div class="tl-sub">备件:' + r.parts.map(function (p) { return esc(p.name || '') + (p.qty ? ('×' + num(p.qty)) : ''); }).join('、') + '</div>' : '')
                + (canEdit ? ('<div class="tl-money">本次费用 ' + money(cost) + '</div>') : '')
                + (canEdit ? ('<div class="tl-top" style="margin-top:6px"><span class="tl-date" style="cursor:pointer;color:#4a90d9" onclick="openRecordForm(\'' + esc(r.id) + '\')">编辑</span>'
                    + '<span class="tl-date" style="cursor:pointer;color:#c53030" onclick="deleteRecord(\'' + esc(r.id) + '\')">删除</span></div>') : '')
                + '</div></div>';
        }
        tl += '</div>';
    }

    $('detail-content').innerHTML = head + stats + '<div class="sec-title"><span>履历时间轴</span><span>' + st.count + ' 条</span></div>' + tl;
    switchView('list');
    $('view-list').classList.add('show');
    // 电脑双栏 / 手机滚动到详情
    if (window.innerWidth < 900) {
        $('detail-panel').scrollIntoView({ behavior: keepScroll ? 'auto' : 'smooth' });
    }
}

// ---------- 档案表单 ----------
function openArchiveForm(code) {
    if (!canEdit) { showToast('只读模式,无编辑权限'); return; }
    editingArchive = !!code;
    var e = code ? EQ[code] : { status: 'active', installDate: today() };
    $('archive-title').textContent = code ? ('编辑档案 · ' + code) : '新增设备';
    $('a-code').value = code || '';
    $('a-code').readOnly = !!code;
    $('a-name').value = e.name || '';
    $('a-model').value = e.model || '';
    $('a-vendor').value = e.vendor || '';
    $('a-line').value = e.line || '';
    $('a-owner').value = e.owner || '';
    $('a-install').value = e.installDate || '';
    $('a-status').value = e.status || 'active';
    $('a-remark').value = e.remark || '';
    switchView('archive');
}
function saveArchive() {
    var code = ($('a-code').value || '').trim();
    var name = ($('a-name').value || '').trim();
    if (!code) { showToast('请填写设备编号'); return; }
    if (!name) { showToast('请填写设备名称'); return; }
    if (!editingArchive && EQ[code]) { showToast('编号已存在,请换一个'); return; }
    var data = editingArchive ? EQ[code] : { code: code, records: [], photos: [] };
    data.code = code;
    data.name = name;
    data.model = ($('a-model').value || '').trim();
    data.vendor = ($('a-vendor').value || '').trim();
    data.line = ($('a-line').value || '').trim();
    data.owner = ($('a-owner').value || '').trim();
    data.installDate = $('a-install').value || '';
    data.status = $('a-status').value;
    data.remark = ($('a-remark').value || '').trim();
    EquipApi.save(code, data, (editingArchive ? '修改设备档案' : '新增设备') + ':' + name).then(function (r) {
        if (!r.ok) { showToast(r.msg || '保存失败'); return; }
        EQ[code] = data;
        showToast('已保存');
        renderList();
        openDetail(code);
    });
}
function deleteEquipment(code) {
    if (!canEdit) return;
    var e = EQ[code] || {};
    if (!confirm('确定删除设备【' + (e.name || code) + '】?\n该设备的全部履历会一起删除,操作会留痕。')) return;
    EquipApi.remove(code).then(function (r) {
        if (!r.ok) { showToast(r.msg || '删除失败'); return; }
        delete EQ[code];
        currentCode = '';
        $('detail-content').innerHTML = '<div class="empty">从左侧选择设备,或点「新增设备」建档</div>';
        renderList();
        showToast('已删除');
    });
}

// ---------- 履历表单 ----------
function openRecordForm(recordId) {
    if (!canEdit) { showToast('只读模式,无编辑权限'); return; }
    currentRecordId = recordId || '';
    var r = {};
    if (recordId) {
        var rs = EQ[currentCode].records || [];
        for (var i = 0; i < rs.length; i++) if (rs[i].id === recordId) { r = JSON.parse(JSON.stringify(rs[i])); break; }
    }
    $('record-title').textContent = recordId ? '编辑履历' : ('录入履历 · ' + (EQ[currentCode].name || currentCode));
    $('r-type').value = r.type || 'fault';
    $('r-date').value = r.date || today();
    $('r-handler').value = r.handler || (EquipApi.user() || {}).name || '';
    $('r-symptom').value = r.symptom || '';
    $('r-causeCat').value = r.causeCat || '';
    $('r-cause').value = r.cause || '';
    $('r-action').value = r.action || '';
    $('r-resolved').value = (r.resolved === false) ? 'no' : 'yes';
    $('r-down').value = r.downHours || '';
    $('r-labor').value = r.laborFee || '';
    $('r-outsource').value = r.outsourceFee || '';
    $('r-remark').value = r.remark || '';
    window._parts = (r.parts || []).map(function (p) { return { name: p.name || '', model: p.model || '', qty: p.qty || 1, price: p.price || '' }; });
    renderParts();
    renderQuickChips();
    switchView('record');
}
function renderQuickChips() {
    var h = '';
    for (var i = 0; i < QUICK_SYMPTOMS.length; i++) {
        h += '<span class="chip" onclick="addSymptom(\'' + QUICK_SYMPTOMS[i] + '\')">' + QUICK_SYMPTOMS[i] + '</span>';
    }
    $('quick-chips').innerHTML = h;
}
function addSymptom(t) {
    var el = $('r-symptom');
    el.value = el.value ? (el.value.replace(/[,,、\s]*$/, '') + ',' + t) : t;
    el.focus();
}
function renderParts() {
    var ps = window._parts || [];
    var h = '';
    for (var i = 0; i < ps.length; i++) {
        var p = ps[i];
        h += '<div class="part-row">'
            + '<div class="part-line">'
            + '<input type="text" placeholder="备件名称" list="part-pool" value="' + esc(p.name) + '" oninput="_parts[' + i + '].name=this.value;updatePartsTotal()">'
            + '<input type="text" placeholder="型号" value="' + esc(p.model) + '" oninput="_parts[' + i + '].model=this.value">'
            + '</div>'
            + '<div class="part-line">'
            + '<input type="number" inputmode="decimal" min="0" step="1" placeholder="数量" value="' + esc(p.qty) + '" oninput="_parts[' + i + '].qty=this.value;updatePartsTotal()">'
            + '<input type="number" inputmode="decimal" min="0" step="0.01" placeholder="单价(元)" value="' + esc(p.price) + '" oninput="_parts[' + i + '].price=this.value;updatePartsTotal()">'
            + '<button type="button" class="part-del" onclick="_parts.splice(' + i + ',1);renderParts()">✕</button>'
            + '</div></div>';
    }
    h += '<button class="btn btn-block" type="button" onclick="addPart()">＋ 添加备件</button>';
    h += '<div class="part-total-line"><span>备件金额合计</span><b id="parts-sum">¥0</b></div>';
    $('parts-wrap').innerHTML = h;
    updatePartsTotal();
    renderPartPool();
}
function addPart() {
    window._parts = window._parts || [];
    window._parts.push({ name: '', model: '', qty: 1, price: '' });
    renderParts();
}
function updatePartsTotal() {
    var ps = window._parts || [], s = 0;
    for (var i = 0; i < ps.length; i++) s += num(ps[i].qty || 1) * num(ps[i].price);
    var el = $('parts-sum');
    if (el) el.textContent = money(s);
    var box = $('r-total');
    if (box) box.textContent = money(s + num($('r-labor').value) + num($('r-outsource').value));
}
// 备件池:从历史履历里自动汇总名称(去掉重复)
function renderPartPool() {
    var names = {}, models = {};
    for (var c in EQ) {
        var recs = EQ[c].records || [];
        for (var i = 0; i < recs.length; i++) {
            var ps = recs[i].parts || [];
            for (var j = 0; j < ps.length; j++) {
                if (ps[j].name) names[ps[j].name] = ps[j].model || '';
            }
        }
    }
    var h = '';
    for (var n in names) h += '<option value="' + esc(n) + '">' + esc(names[n]) + '</option>';
    var dl = $('part-pool');
    if (dl) dl.innerHTML = h;
}
function saveRecord() {
    var rs = EQ[currentCode].records || [];
    var obj = {
        id: currentRecordId || ('r' + Date.now()),
        type: $('r-type').value,
        date: $('r-date').value || today(),
        handler: ($('r-handler').value || '').trim(),
        symptom: ($('r-symptom').value || '').trim(),
        causeCat: $('r-causeCat').value,
        cause: ($('r-cause').value || '').trim(),
        action: ($('r-action').value || '').trim(),
        resolved: $('r-resolved').value === 'yes',
        downHours: num($('r-down').value),
        parts: (window._parts || []).filter(function (p) { return (p.name || '').trim() || num(p.price); }).map(function (p) {
            return { name: (p.name || '').trim(), model: (p.model || '').trim(), qty: num(p.qty) || 1, price: num(p.price) };
        }),
        laborFee: num($('r-labor').value),
        outsourceFee: num($('r-outsource').value),
        remark: ($('r-remark').value || '').trim(),
        photos: []
    };
    if (!obj.symptom) { showToast('请填写故障现象/事项'); return; }
    var u = EquipApi.user() || {};
    var isEdit = false;
    for (var i = 0; i < rs.length; i++) {
        if (rs[i].id === obj.id) {
            obj.createdAt = rs[i].createdAt || '';
            obj.createdBy = rs[i].createdBy || '';
            obj.updatedAt = new Date().toLocaleString('zh-CN');
            obj.updatedBy = u.name || '';
            rs[i] = obj;
            isEdit = true;
            break;
        }
    }
    if (!isEdit) {
        obj.createdAt = new Date().toLocaleString('zh-CN');
        obj.createdBy = u.name || '';
        rs.push(obj);
    }
    EQ[currentCode].records = rs;
    var summary = (isEdit ? '修改履历:' : '新增履历:') + obj.date + ' ' + obj.symptom.substring(0, 30);
    EquipApi.save(currentCode, EQ[currentCode], summary).then(function (r) {
        if (!r.ok) { showToast(r.msg || '保存失败'); return; }
        showToast(isEdit ? '已更新履历' : '已录入履历');
        renderList();
        openDetail(currentCode);
    });
}
function deleteRecord(recordId) {
    if (!canEdit) return;
    if (!confirm('删除这条履历?操作会留痕。')) return;
    var e = EQ[currentCode];
    var rs = e.records || [];
    var target = null;
    for (var i = 0; i < rs.length; i++) if (rs[i].id === recordId) target = rs[i];
    e.records = rs.filter(function (r) { return r.id !== recordId; });
    EquipApi.save(currentCode, e, '删除履历:' + ((target && target.date) || '') + ' ' + ((target && target.symptom) || '').substring(0, 30)).then(function (r) {
        if (!r.ok) { showToast(r.msg || '删除失败'); return; }
        showToast('已删除');
        renderList();
        openDetail(currentCode);
    });
}

// ---------- 编辑留痕 ----------
function openAudit() {
    EquipApi.auditList(currentCode).then(function (r) {
        var logs = (r && r.logs) || [];
        var h = '';
        if (!logs.length) h = '<div class="empty">暂无编辑记录</div>';
        else {
            h = '<div class="timeline">';
            for (var i = 0; i < logs.length; i++) {
                var g = logs[i];
                h += '<div class="tl-item"><div class="tl-dot ' + (g.action === 'delete' ? 'fault' : 'maintain') + '"></div>'
                    + '<div class="tl-body"><div class="tl-top"><span class="tl-date">' + esc(g.at) + '</span>'
                    + '<span class="tl-type">' + esc(g.action === 'delete' ? '删除' : '保存') + '</span>'
                    + '<span class="tl-date">' + esc(g.name || g.account || '') + '</span></div>'
                    + '<div class="tl-sub">' + esc(g.summary || '') + '</div></div></div>';
            }
            h += '</div>';
        }
        $('audit-content').innerHTML = '<div class="sec-title">设备 ' + esc(currentCode) + ' 的编辑记录</div>' + h
            + '<div class="bottom-bar"><button class="btn btn-block" onclick="openDetail(\'' + esc(currentCode) + '\')">返回设备</button></div>';
        switchView('audit');
    });
}

// ---------- 二维码标签 ----------
function makeQrSvg(text, sizeMm) {
    try {
        var qr = qrcode(0, 'M');
        qr.addData(text);
        qr.make();
        return qr.createSvgTag({ cellSize: 3, margin: 2, scalable: true });
    } catch (e) {
        return '<div style="font-size:10px;color:#999">二维码生成失败</div>';
    }
}
function eqUrl(code) {
    var base = location.origin + location.pathname.replace(/index\.html$/, '');
    return base + '?code=' + encodeURIComponent(code);
}
function showLabels(codes) {
    codes = codes || Object.keys(EQ);
    if (!codes.length) { showToast('还没有设备'); return; }
    var h = '';
    for (var i = 0; i < codes.length; i++) {
        var c = codes[i], e = EQ[c] || {};
        h += '<div class="label-card">'
            + '<div class="label-qr">' + makeQrSvg(eqUrl(c)) + '</div>'
            + '<div class="label-info"><div class="label-name">' + esc(e.name || c) + '</div>'
            + '<div class="label-code">' + esc(c) + (e.line ? (' · ' + esc(e.line)) : '') + '</div></div>'
            + '</div>';
    }
    $('labels-wrap').innerHTML = h;
    switchView('labels');
}
function printLabels() { window.print(); }

// ---------- 折叠面板 ----------
function toggleFold(el) {
    el.parentNode.classList.toggle('open');
}

// ---------- 初始化 ----------
window.addEventListener('DOMContentLoaded', function () {
    eqInit();
    $('f-q').addEventListener('input', renderList);
    $('f-line').addEventListener('change', renderList);
    $('f-status').addEventListener('change', renderList);
    var folds = document.querySelectorAll('.fold-head');
    for (var i = 0; i < folds.length; i++) folds[i].addEventListener('click', function () { toggleFold(this); });
});
