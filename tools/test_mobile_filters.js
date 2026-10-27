'use strict';
// Permanent offline contract: actual markup, scoped CSS, and complete app in a VM.
// Pixel geometry and native keyboard interaction are checked separately in Chrome.
const fs = require('fs'), path = require('path'), vm = require('vm'), assert = require('assert');
const root = path.resolve(__dirname, '..'), read = p => fs.readFileSync(path.join(root, p), 'utf8');
const html = read('docs/equipment/index.html'), css = read('docs/equipment/css/equipment.css');
const app = read('docs/equipment/js/equipment-app.js');
let passed = 0, failed = 0;
function test(name, check) { try { check(); passed++; } catch (e) { failed++; console.error(name + ': ' + e.message); } }
function same(actual, expected) { assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected); }
const row = html.match(/<div\b[^>]*class="[^"]*\blist-filters\b[^"]*"[^>]*>([\s\S]*?)<\/div>/);
test('one dedicated accessible filter row', () => { assert(row); assert.equal((html.match(/class="toolbar list-filters"/g) || []).length, 1); assert(row[0].includes('role="search"')); assert(row[0].includes('aria-label="设备筛选"')); });
test('original three native controls retain order and unique IDs', () => { same([...row[1].matchAll(/<(input|select)\b[^>]*id="(f-[^"]+)"/g)].map(m => [m[1], m[2]]), [['input','f-q'],['select','f-line'],['select','f-cat']]); for (const id of ['f-q','f-line','f-cat']) assert.equal((html.match(new RegExp('id="' + id + '"', 'g')) || []).length, 1); });
for (const id of ['f-q','f-line','f-cat']) test(id + ' has an accessible name and no negative tabindex', () => { const tag = row[1].match(new RegExp('<(?:input|select)\\b[^>]*id="' + id + '"[^>]*>'))[0]; assert(/aria-label="[^"]+"/.test(tag)); assert(!/tabindex="-/.test(tag)); assert(!/\bdisabled\b/.test(tag)); });
test('short placeholder retains full search guidance', () => { assert(row[1].includes('placeholder="搜索设备"')); for (const word of ['编号','名称','部门','类别','规格']) assert(row[1].includes(word)); });
test('all category values and defaults are unchanged', () => { const select = row[1].match(/<select[^>]*id="f-cat"[^>]*>([\s\S]*?)<\/select>/)[1]; same([...select.matchAll(/<option value="([^"]*)"/g)].map(m => m[1]), ['', 'prod', 'admin', 'facility', 'misc']); assert(row[1].includes('<option value="">全部部门</option>')); });
const marker = '@media(max-width:600px)', start = css.indexOf(marker), begin = css.indexOf('{', start);
let depth = 1, end = begin + 1;
for (; depth && end < css.length; end++) { if (css[end] === '{') depth++; else if (css[end] === '}') depth--; }
const mobile = css.slice(begin + 1, end - 1), outside = css.slice(0, start) + css.slice(end);
test('filter-specific styles exist only in phone media query', () => { assert(start >= 0 && depth === 0); assert(!outside.includes('.list-filters')); });
test('phone layout uses three shrinkable equal columns', () => { assert(/\.toolbar\.list-filters\{[^}]*display:grid/.test(mobile)); assert(mobile.includes('grid-template-columns:repeat(3,minmax(0,1fr))')); assert(mobile.includes('gap:6px')); });
for (const declaration of ['width:100%','min-width:0','min-height:44px','font-size:16px','line-height:24px','text-overflow:ellipsis']) test('phone controls preserve ' + declaration, () => { const rule = mobile.match(/\.toolbar\.list-filters>input\[type=text\],\.toolbar\.list-filters>select\{([^}]+)\}/); assert(rule && rule[1].includes(declaration)); });
test('native select has local arrow space without a remote dependency', () => { const rule = mobile.match(/(?:^|\})\s*\.toolbar\.list-filters>select\{([^}]+)\}/)[1]; assert(rule.includes('padding-right:20px')); assert(rule.includes('background-image:url("data:image/svg+xml,')); assert(!/url\(["']?https?:\/\//.test(rule)); });
test('desktop flex fallback and adjacent toolbar remain intact', () => { assert(outside.includes('.toolbar{display:flex;flex-wrap:wrap;gap:8px')); assert(outside.includes('flex:1 1 140px')); assert(html.includes('class="toolbar list-actions"')); assert(html.includes('id="rp-place"') && /id="rp-place"[^>]*\brequired\b/.test(html)); });
const fixture = {
    'PS04-10': { code:'PS04-10', name:'平面磨床', number:'M-10', line:'精密加工车间一组', family:'磨削/抛光', model:'XYZ-450', category:'prod', records:[{status:'open'}] },
    'PS07-29': { code:'PS07-29', name:'中走丝线切割机', line:'精密加工车间一组', family:'线切割', model:'DK7732', category:'prod', records:[{status:'done'}] },
    'GEN-D07': { code:'GEN-D07', name:'通用报修', line:'精密加工车间一组', category:'facility', records:[] },
    'PS00-140': { code:'PS00-140', name:'加工中心', line:'冲压组', model:'CNC-850', records:[{status:'done', cause3:'已分类'}] }
};
function fresh(role) {
    const elements = Object.fromEntries(['f-q','f-line','f-cat'].map(id => [id, {value:''}]));
    const forbidden = () => { throw Error('Network/printing forbidden in offline test'); };
    const sandbox = {console, document:{getElementById:id => elements[id] || null, addEventListener(){}}, addEventListener(){}, fetch:forbidden, print:forbidden, navigator:{}, setTimeout:()=>0, clearTimeout(){}};
    sandbox.window = sandbox;
    const context = vm.createContext(sandbox), run = code => vm.runInContext(code, context);
    vm.runInContext(app, context, {filename:'equipment-app.js'});
    run('ROLE=' + JSON.stringify(role) + '; EQ=' + JSON.stringify(fixture));
    return {elements, run, reset(){for(const el of Object.values(elements)) el.value='';run('taskFilter="";labelCodes=null');}};
}
for (const role of ['admin','repairer']) {
    const t = fresh(role), query = (q,line='',cat='') => { t.elements['f-q'].value=q; t.elements['f-line'].value=line; t.elements['f-cat'].value=cat; return t.run('filterCodes(currentFilters())'); };
    test(role + ' supports sorted unfiltered list', () => same(query(''), ['GEN-D07','PS00-140','PS04-10','PS07-29']));
    for (const [q, expected] of [[' PS04-10 ',['PS04-10']],['磨床',['PS04-10']],['m-10',['PS04-10']],['精密加工车间一组',['GEN-D07','PS04-10','PS07-29']],['线切割',['PS07-29']],['xyz-450',['PS04-10']]]) test(role + ' keeps search semantics: ' + q, () => same(query(q), expected));
    test(role + ' preserves full long department value', () => {same(query('','精密加工车间一组'),['GEN-D07','PS04-10','PS07-29']);assert.equal(t.elements['f-line'].value,'精密加工车间一组');});
    test(role + ' combines department/category/specification', () => same(query('xyz','精密加工车间一组','prod'),['PS04-10']));
    test(role + ' category defaults missing value to prod', () => same(query('','冲压组','prod'),['PS00-140']));
    test(role + ' no-match remains empty', () => same(query('not-an-equipment'),[]));
    test(role + ' ongoing task still narrows existing filters', () => {t.reset();t.run('taskFilter="open"');same(query(''),['PS04-10']);});
    test(role + ' pending task still narrows existing filters', () => {t.reset();t.run('taskFilter="pending"');same(query(''),['PS07-29']);});
    test(role + ' label fallback respects current mobile filters', () => {t.reset();query('','精密加工车间一组','prod');same(t.run('labelTargets()'),['PS04-10','PS07-29']);});
    test(role + ' explicit single label never expands to department', () => {t.run('labelCodes=["PS04-10"]');same(t.run('labelTargets()'),['PS04-10']);});
    test(role + ' clearing filters restores the full list', () => {t.reset();same(query(''),['GEN-D07','PS00-140','PS04-10','PS07-29']);});
}
console.log('通过 ' + passed + ' / 失败 ' + failed);
if (failed) process.exitCode = 1;
