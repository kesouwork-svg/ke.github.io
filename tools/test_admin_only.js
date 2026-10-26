/* Account-management permission regression. Run: node tools/test_admin_only.js
 * Offline VM behaviour + SQL contracts. Does not replace a deployed-token check.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const HTML = read('docs/index.html');
const API = read('docs/roi/js/app-api.js');
const SESSION = read('docs/js/session.js');
const SQL = read('supabase/schema.sql');
const DELTA = read('supabase/delta_admin_only.sql');
let pass = 0, fail = 0;
function ok(name, value) {
    if (value) { pass++; console.log('  ✓ ' + name); }
    else { fail++; console.error('  ✗ ' + name); }
}
function inline(html) {
    return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
        .filter(m => !/\bsrc\s*=/.test(m[1]) && m[2].trim()).pop()[2];
}
function element() {
    const classes = new Set();
    return { style: {}, value: '', innerHTML: '', textContent: '', children: [],
        classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) },
        appendChild(c) { this.children.push(c); }, addEventListener() {}, click() {}, focus() {}, remove() {} };
}
function context(session) {
    const store = {
        roi_users: JSON.stringify({
            admin: { account: 'admin', name: '管理员', pwd: 'hash', status: 'active', level: 1, tools: ['roi','equipment-admin'] },
            boss: { account: 'boss', name: '负责人', pwd: 'hash', status: 'active', level: 1 },
            user: { account: 'user', name: '测试用户', pwd: 'hash', status: 'active', level: 2 }
        }),
        roi_calculator_projects: JSON.stringify({ other: { name: 'other', owners: ['其他人'] } })
    };
    if (session) store.roi_session = JSON.stringify(session);
    const storage = { getItem: k => store[k] || null, setItem: (k,v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
    const els = {};
    for (const m of HTML.matchAll(/\bid="([^"]+)"/g)) els[m[1]] = element();
    els['p-accounts'].style.display = 'none';
    const sb = {
        console, localStorage: storage, sessionStorage: storage,
        setTimeout: () => 0, clearTimeout() {}, confirm: () => true, prompt: () => null,
        location: { search: '', href: '', pathname: '/index.html' }, navigator: { userAgent: 'node' },
        document: { getElementById: id => els[id] || null, querySelector: () => null, querySelectorAll: () => [],
            createElement: () => element(), addEventListener() {}, head: element(), body: element() }
    };
    sb.window = sb;
    const ctx = vm.createContext(sb);
    const run = code => vm.runInContext(code, ctx);
    run(SESSION); run(API); run('AppConfig.cloud=false;'); run(inline(HTML));
    return { store, els, run, ctx };
}
const session = (account, level, extra) => Object.assign({ account, level, token: 'local-test', name: account, tools: ['roi'] }, extra);
const calls = [
    ['adminUsers', []], ['adminAudit', ['user',1]], ['adminReject', ['user']],
    ['adminLevel', ['user',1]], ['adminToggle', ['user']], ['adminResetpwd', ['user','newpass123']],
    ['adminCreateUser', ['newuser','新号','newpass123',1,['roi'],'']],
    ['adminSetDept', ['user','模具部']], ['adminUpdate', ['user','newname','新姓名']],
    ['adminDelete', ['user']], ['adminSetTools', ['user',['equipment-admin']]]
];
const uiCalls = [
    'openAccounts()', 'renderAccounts()', 'auditUser("user",1)', 'rejectUser("user")',
    'cycleLevel("user",2)', 'setLevel("user",1)', 'toggleUser("user")', 'resetPwd("user")',
    'editUser("user")', 'cycleTools("user","reporter")', 'deleteUser("user")',
    'toggleNewUser()', 'createUser()', 'setDept("user")', 'doBackup()', 'pickRestoreFile()',
    'onRestoreFile({files:[]})', 'restoreSeq([],0,"local-test",function(){},function(){})',
    'runRestore({equipments:[],users:[]})'
];
function sqlFunction(source, name) {
    const result = source.match(new RegExp('create or replace function public\\.' + name + '\\([\\s\\S]*?end \\$\\$;', 'i'));
    return result && result[0].replace(/\r\n/g, '\n');
}
(async () => {
    console.log('=== Non-admins cannot enter or operate ===');
    for (const [label, s] of [
        ['ROI1', session('boss',1)], ['ROI2', session('user',2)], ['ROI0', session('user',0)],
        ['Equipment admin', session('boss',1,{tools:['roi','equipment-admin']})],
        ['Guest', session('admin',1,{guest:true})], ['No token', session('admin',1,{token:''})], ['Anonymous', null]
    ]) {
        const t = context(s);
        ok(label + ': account button hidden', t.els['p-accounts'].style.display === 'none');
        const before = t.store.roi_users;
        for (const [fn,args] of calls) {
            const result = await t.run('AppApi.' + fn + '(' + ['local-test',...args].map(v => JSON.stringify(v)).join(',') + ')');
            ok(label + ': API ' + fn + ' denied', result.ok === false && /admin/.test(result.msg));
        }
        ok(label + ': no account mutation', t.store.roi_users === before);
        t.run('var observedCalls=0; Object.keys(AppApi).forEach(function(k){if(k.indexOf("admin")===0)AppApi[k]=function(){observedCalls++;return Promise.resolve({ok:true});};});');
        for (const call of uiCalls) {
            t.run(call);
            ok(label + ': UI ' + call.split('(')[0] + ' blocked before API', t.run('observedCalls') === 0);
        }
        ok(label + ': modal remains closed', !t.els['acc-modal'].classList.contains('show'));
    }
    console.log('=== Valid admin and lockout protection ===');
    const t = context(session('admin',1));
    ok('admin: button visible', t.els['p-accounts'].style.display === '');
    ok('admin: list allowed', (await t.run('AppApi.adminUsers("local-test")')).ok);
    ok('admin: wrong token denied', !(await t.run('AppApi.adminUsers("wrong")')).ok);
    t.run('var u=localGetUsers();u.admin.status="disabled";localSetUsers(u);');
    ok('admin: disabled profile denied', !(await t.run('AppApi.adminUsers("local-test")')).ok);
    t.run('var u=localGetUsers();u.admin.status="active";localSetUsers(u);');
    for (const call of [
        'adminAudit("local-test","admin",0)', 'adminAudit("local-test","admin",2)',
        'adminLevel("local-test","admin",0)', 'adminLevel("local-test","admin",null)',
        'adminToggle("local-test","admin")', 'adminReject("local-test","admin")',
        'adminDelete("local-test","admin")', 'adminUpdate("local-test","admin","renamed","管理员")'
    ]) ok('admin self-protection: ' + call, !(await t.run('AppApi.' + call)).ok);
    ok('admin display-name edit still allowed', (await t.run('AppApi.adminUpdate("local-test","admin","admin","新姓名")')).ok);
    ok('admin creating ROI1 still allowed', (await t.run('AppApi.adminCreateUser("local-test","newboss","新负责人","testpass123",1,["roi"],"")')).ok);
    ok('admin creating ROI0 preserves zero', (await t.run('AppApi.adminCreateUser("local-test","no_roi","无ROI","testpass123",0,["roi"],"")')).ok && t.run('localGetUsers().no_roi.level') === 0);
    for (const bad of [[], [{account:'admin',level:1,status:'disabled',pwd:'hash'}],
        [{account:'admin',level:0,status:'active',pwd:'hash'}], [{account:'admin',level:1,status:'active',pwd:''}],
        [{account:'admin',level:1,status:'active',pwd:'hash'},{account:'admin',level:1,status:'active',pwd:'hash'}]]) {
        t.ctx.badBackup = { equipments: [], users: bad };
        t.run('var restoreCalls=0;AppApi.adminBackup=function(){restoreCalls++;return Promise.resolve({ok:true});};runRestore(badBackup);');
        ok('invalid backup rejected before destructive sequence: ' + JSON.stringify(bad), t.run('restoreCalls') === 0);
    }
    ok('valid backup accepted', t.run('validRestoreAdmin({users:[{account:"admin",level:1,status:"active",pwd:"hash"}]})'));
    console.log('=== ROI1 project permissions remain independent ===');
    const boss = context(session('boss',1));
    ok('non-admin ROI1 reads all projects', !!(await boss.run('AppApi.projectsList("local-test")')).data.projects.other);
    ok('non-admin ROI1 edits another owner project', (await boss.run('AppApi.projectSave("local-test","other",{owners:["其他人"]})')).ok);
    ok('non-admin ROI1 deletes another owner project', (await boss.run('AppApi.projectDelete("local-test","other")')).ok);
    console.log('=== Lazy-loaded account dependency cache busting ===');
    const crypto = require('crypto');
    const hash = s => crypto.createHash('sha1').update(s.replace(/\r\n/g,'\n')).digest('hex').slice(0,8);
    const expectedHash = hash(API);
    ok('portal lazy API uses current content hash', HTML.includes("accLoad('./roi/js/app-api.js?v=" + expectedHash + "')"));
    ok('portal lazy Supabase SDK also uses content hash', HTML.includes("accLoad('./js/supabase.js?v=" + hash(read('docs/js/supabase.js')) + "')"));
    // Exercise the actual stamping tool in a fake filesystem, not just its regex.
    function stampFixture(source, options = {}) {
        let updated = source;
        const fakeFs = {
            readdirSync: () => ['index.html'], statSync: () => ({isDirectory: () => false}),
            existsSync: p => fs.existsSync(p),
            readFileSync: (p, enc) => {
                if (p === path.join(ROOT,'docs','index.html')) return enc ? source : Buffer.from(source);
                let text = fs.readFileSync(p,'utf8');
                if (options.changed && p === path.join(ROOT,'docs','roi','js','app-api.js')) text += '\n// changed';
                return enc ? text : Buffer.from(text);
            },
            writeFileSync: (p, text) => { updated = text; }
        };
        let exitCode = 0;
        try {
            vm.runInNewContext(read('tools/stamp_ver.js'), {
                require: key => key === 'fs' ? fakeFs : require(key), __dirname: path.join(ROOT,'tools'), Buffer,
                process: {argv: options.check ? ['node','stamp_ver.js','--check'] : [], exit: code => { exitCode = code; throw new Error('CHECK_EXIT'); }},
                console: {log() {}}
            });
        } catch(e) { if(e.message !== 'CHECK_EXIT') throw e; }
        return {text: updated, exitCode};
    }
    const fixture = '<script src="./roi/js/app-api.js"></script>;accLoad(\'./roi/js/app-api.js\');accLoad("./roi/js/app-api.js?v=deadbeef");accLoad(\'https://example.com/external.js\');';
    const stamped = stampFixture(fixture).text;
    ok('stamping covers static, single- and double-quoted lazy imports', (stamped.match(new RegExp('app-api\\.js\\?v=' + expectedHash,'g')) || []).length === 3);
    ok('stamping preserves external URLs', stamped.includes("accLoad('https://example.com/external.js')"));
    ok('stamping is idempotent', stampFixture(stamped).text === stamped);
    ok('lazy reference changes version when API changes', stampFixture(stamped,{changed:true}).text.includes('app-api.js?v=' + hash(API + '\n// changed')));
    ok('--check rejects unversioned lazy-only reference', stampFixture("accLoad('./roi/js/app-api.js')",{check:true}).exitCode === 1);
    ok('--check accepts current version without writing', stampFixture(stamped,{check:true}).exitCode === 0 && stampFixture(stamped,{check:true}).text === stamped);
    console.log('=== Backend SQL contracts (not deployed runtime) ===');
    const names = ['admin_users','admin_audit','admin_reject','admin_level','admin_toggle','admin_resetpwd',
        'admin_create_user','admin_set_dept','admin_update_user','admin_delete_user','admin_set_tools',
        'admin_backup','admin_restore_clear','admin_restore_device','admin_restore_users','admin_restore_meta'];
    for (const name of names) {
        const body = sqlFunction(SQL,name), delta = sqlFunction(DELTA,name);
        ok(name + ': delta equals canonical schema', !!body && body === delta);
        const guard = body && body.indexOf("if u.account <> 'admin' then");
        const nullGuard = body && body.indexOf('if u.account is null then');
        ok(name + ': authenticated fixed account guard, no ROI-level guard', !!body && nullGuard > 0 && guard > nullGuard && !/if u\.level <> 1/.test(body));
        const work = body && body.search(/\n  (?:update|delete|insert|select coalesce|return jsonb_build_object\('ok', true)/);
        ok(name + ': admin guard precedes data access/mutation', work > guard);
    }
    ok('migration preflight rejects missing/disabled admin', /do \$preflight\$[\s\S]*?account = 'admin' and status = 'active'[\s\S]*?raise exception/.test(DELTA));
    ok('admin_restore_users validates unique admin before delete', /count\(\*\)[\s\S]*?<> 1[\s\S]*?delete from public.users/.test(sqlFunction(SQL,'admin_restore_users')));
    ok('admin_restore_users validates active level1 and password', /status[\s\S]*?active[\s\S]*?level' = '1'[\s\S]*?pwd/.test(sqlFunction(SQL,'admin_restore_users')));
    for (const name of ['projects_list','project_get','project_save','project_delete','project_trash_list','project_trash_restore','project_trash_purge']) {
        const body = sqlFunction(SQL,name);
        ok(name + ': ROI access not restricted to fixed admin', !!body && !/if u\.account <> 'admin' then/.test(body));
    }
    console.log('通过 ' + pass + ' / 失败 ' + fail);
    process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
