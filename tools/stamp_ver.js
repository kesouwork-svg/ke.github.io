/**
 * 给 docs 下所有 HTML 里的本地 js/css 引用打「内容哈希」版本号。
 * 运行: node tools/stamp_ver.js [--check]
 *
 * 为什么需要: GitHub Pages 对所有文件都返回 Cache-Control: max-age=600,
 * 改完 JS 后用户按 F5 只会重新校验 HTML,<script src="./js/equipment-app.js">
 * 这类子资源仍从缓存走,10 分钟内一直是旧代码 —— 表现就是「界面是新的,
 * 功能还是旧的」(2026-10-26 手机端打印张数那个 bug 就是这么来的)。
 * 把引用改成 app.js?v=<内容哈希> 后,内容一变 URL 就变,浏览器必然重新下载。
 *
 * --check: 只检查不写,有需要更新的就退出码 1(用于提交前自检)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');
const CHECK = process.argv.indexOf('--check') > -1;

function walk(dir, out) {
    for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) walk(p, out);
        else if (/\.html$/i.test(name)) out.push(p);
    }
    return out;
}

function hashOf(file) {
    // 统一换行再算哈希：仓库 core.autocrlf=true，不同检出得到的 CRLF/LF 不同，
    // 直接对字节算哈希会让「同一份代码」在别的机器上算出不同版本号，
    // 钩子每次提交都会把所有 HTML 重写一遍。
    const buf = fs.readFileSync(file);
    const norm = Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
    return crypto.createHash('sha1').update(norm).digest('hex').slice(0, 8);
}

// 匹配 src="./js/x.js" / href="./css/x.css" 以及已带 ?v=xxxx 的形式
const REF = /(\b(?:src|href)=")([^"?#]+\.(?:js|css))(?:\?v=([0-9a-f]+))?(")/g;

let changedFiles = 0, changedRefs = 0, missing = 0;
const stale = [];

for (const html of walk(DOCS, [])) {
    const dir = path.dirname(html);
    const src = fs.readFileSync(html, 'utf8');
    const out = src.replace(REF, (m, pre, ref, oldVer, post) => {
        if (/^(https?:)?\/\//.test(ref) || ref.indexOf('data:') === 0) return m;
        const abs = path.resolve(dir, ref.replace(/\?.*$/, ''));
        if (!fs.existsSync(abs)) { missing++; return m; }
        const ver = hashOf(abs);
        if (ver !== oldVer) { changedRefs++; stale.push(path.relative(ROOT, html) + '  ' + ref + '  ' + (oldVer || '(无)') + ' -> ' + ver); }
        return pre + ref + '?v=' + ver + post;
    });
    if (out !== src) {
        changedFiles++;
        if (!CHECK) fs.writeFileSync(html, out, 'utf8');
    }
}

if (stale.length) console.log(stale.join('\n'));
console.log((CHECK ? '[check] ' : '') + '引用需更新 ' + changedRefs + ' 处，涉及 HTML ' + changedFiles + ' 个' + (missing ? '，找不到的目标文件 ' + missing + ' 个' : ''));
if (CHECK && changedRefs) process.exit(1);
