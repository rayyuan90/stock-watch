/**
 * 本地数据仓（vault）—— 把「只在本机算出来、线上查不到」的数据落成磁盘文件
 *
 * 背景：多空博弈复盘（kanpan:bgHist）、次日倾向复盘（kanpan:sigHist）、净空单历史
 * （kanpan:posHistory）、看盘配置、自选、持仓缓存，这些都是本机计算/本机录入的，
 * 一旦重新发布小程序、清缓存、切换开发版/体验版，storage 被清空就彻底没了。
 *
 * 做法：
 * 1) 每次这些数据发生改动（各模块 save），防抖 1.5s 把全部 kanpan:* 键写成一份 JSON
 *    文件，放在 wx.env.USER_DATA_PATH/vault/ 下（真机/开发者工具都是磁盘文件，
 *    不随代码包更新而清空）；另外每天留一份按日期的快照，最多保留 12 份。
 * 2) 小程序启动（app.onLaunch）时先读这份文件回灌 storage，再让页面读数据，
 *    所以重新发布后打开就能看到历史复盘，而不是空白。
 * 3) 合并策略「有值优先」：同一条记录里 null/空 的字段不会覆盖已有值，
 *    因此新算的预测不会把旧的真实涨跌幅冲掉，反之亦然。
 * 4) 回灌后把 bgHist / sigHist 再推一次云端（云表 bgame_pred / sig_hist），
 *    让「本地文件 + storage + 云端」三份互为主备。
 * 5) 另提供导出/导入文本（复制到剪贴板 / 从剪贴板恢复），换手机时可手工搬运。
 */
var PREFIX = 'kanpan:';
var SKIP_PREFIX = ['barscache_'];   // 行情K线缓存可重算，且体积大，不备份
var META_KEY = 'vault:meta';        // 注意不带 kanpan: 前缀，避免自我递归

var KNOWN = [
    'kanpan:bgHist',
    'kanpan:sigHist',
    'kanpan:posHistory',
    'kanpan:config',
    'kanpan:citPos',
    'kanpan:watch',
    'kanpan:watchMeta'
];

/** 列表型数据的条数上限，回灌时按原模块的上限截断 */
var MAX_LIST = {
    'kanpan:bgHist': 180,
    'kanpan:sigHist': 120,
    'kanpan:posHistory': 60,
    'kanpan:watch': 20
};

/** 列表型数据的唯一键，用来合并文件与 storage 里的同一批记录 */
var ID_FIELDS = {
    'kanpan:bgHist': ['ymd', 'model'],
    'kanpan:sigHist': ['date'],
    'kanpan:posHistory': ['date'],
    'kanpan:watch': ['sec']
};

var KEEP_DAYS = 12;
var DEBOUNCE_MS = 1500;
var CLOUD_MIN_GAP = 20000;   // 云端整包镜像最小间隔，避免频繁写

var _timer = null;
var _fs = null;
var _lastCloud = 0;
var _listeners = [];

function fm() {
    if (_fs) return _fs;
    try {
        _fs = wx.getFileSystemManager();
    } catch (e) {
        _fs = null;
    }
    return _fs;
}

function baseDir() {
    var root = '';
    try {
        root = wx.env && wx.env.USER_DATA_PATH ? wx.env.USER_DATA_PATH : '';
    } catch (e) {
        root = '';
    }
    return root ? root + '/vault' : '';
}

function latestPath() {
    var d = baseDir();
    return d ? d + '/kanpan-vault.json' : '';
}

function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
}

function dayTag(d) {
    var t = d || new Date();
    return t.getFullYear() + pad2(t.getMonth() + 1) + pad2(t.getDate());
}

function ensureDir() {
    var d = baseDir();
    if (!d) return false;
    var f = fm();
    if (!f) return false;
    try {
        f.accessSync(d);
        return true;
    } catch (e) {
        try {
            f.mkdirSync(d, true);
            return true;
        } catch (e2) {
            return false;
        }
    }
}

function writeText(path, text) {
    var f = fm();
    if (!f || !path) return false;
    try {
        f.writeFileSync(path, text, 'utf8');
        return true;
    } catch (e) {
        return false;
    }
}

function readText(path) {
    var f = fm();
    if (!f || !path) return '';
    try {
        return f.readFileSync(path, 'utf8') || '';
    } catch (e) {
        return '';
    }
}

function skipKey(k) {
    for (var i = 0; i < SKIP_PREFIX.length; i++) {
        if (k.indexOf(SKIP_PREFIX[i]) === 0) return true;
    }
    return false;
}

function allKeys() {
    var out = [];
    var i;
    try {
        var info = wx.getStorageInfoSync();
        var keys = (info && info.keys) || [];
        for (i = 0; i < keys.length; i++) {
            var k = keys[i];
            if (k.indexOf(PREFIX) === 0 && !skipKey(k) && out.indexOf(k) < 0) out.push(k);
        }
    } catch (e) {
        // 某些基础库没有 getStorageInfoSync，退回已知键表
    }
    for (i = 0; i < KNOWN.length; i++) {
        if (out.indexOf(KNOWN[i]) < 0) out.push(KNOWN[i]);
    }
    out.sort();
    return out;
}

function isEmpty(v) {
    if (v === null || v === undefined || v === '') return true;
    if (v instanceof Array && v.length === 0) return true;
    if (typeof v === 'object' && !(v instanceof Array)) {
        for (var k in v) {
            if (v.hasOwnProperty(k)) return false;
        }
        return true;
    }
    return false;
}

function countOf(v) {
    if (v instanceof Array) return v.length;
    if (isEmpty(v)) return 0;
    return 1;
}

/** 生成当前本机数据的完整快照 */
function snapshot() {
    var keys = allKeys();
    var bag = {};
    var rows = 0;
    for (var i = 0; i < keys.length; i++) {
        var v;
        try {
            v = wx.getStorageSync(keys[i]);
        } catch (e) {
            v = '';
        }
        if (isEmpty(v)) continue;
        bag[keys[i]] = v;
        rows += countOf(v);
    }
    return {
        v: 1,
        app: 'kanpan',
        at: new Date().toISOString(),
        rows: rows,
        keys: bag
    };
}

function idOf(key, item) {
    var fields = ID_FIELDS[key];
    if (!fields || !item || typeof item !== 'object') return '';
    var parts = [];
    for (var i = 0; i < fields.length; i++) {
        var f = fields[i];
        parts.push(item[f] === null || item[f] === undefined ? '' : String(item[f]));
    }
    return parts.join('|');
}

/** 合并两个同 key 的记录：b 中有值的字段覆盖 a，null/空不覆盖 */
function prefer(a, b) {
    var out = {};
    var k;
    for (k in a) {
        if (a.hasOwnProperty(k)) out[k] = a[k];
    }
    for (k in b) {
        if (!b.hasOwnProperty(k)) continue;
        var bv = b[k];
        if (bv === null || bv === undefined || bv === '') continue;
        out[k] = bv;
    }
    return out;
}

/** 合并两个列表：按唯一键对齐，字段级「有值优先」 */
function mergeList(key, base, extra) {
    var map = {};
    var order = [];
    var i;
    var put = function (item) {
        var id = idOf(key, item);
        if (!id) return;
        if (map[id]) map[id] = prefer(map[id], item);
        else {
            map[id] = item;
            order.push(id);
        }
    };
    for (i = 0; i < base.length; i++) put(base[i]);
    for (i = 0; i < extra.length; i++) put(extra[i]);
    var out = [];
    for (i = 0; i < order.length; i++) out.push(map[order[i]]);
    var max = MAX_LIST[key];
    if (max && out.length > max) out = out.slice(out.length - max);
    return out;
}

/** 核心数据条数（复盘类）：为 0 说明本机是空的，不能拿它去覆盖云端 */
function coreRows(snap) {
    if (!snap || !snap.keys) return 0;
    var n = 0;
    var k = 'kanpan:bgHist';
    var v = snap.keys[k];
    if (v instanceof Array) n += v.length;
    k = 'kanpan:sigHist';
    v = snap.keys[k];
    if (v instanceof Array) n += v.length;
    return n;
}

function readMeta() {
    try {
        return wx.getStorageSync(META_KEY) || {};
    } catch (e) {
        return {};
    }
}

/** 写入本地文件（latest + 每日快照） */
function persist(reason) {
    var snap = snapshot();
    var ok = false;
    if (ensureDir()) {
        snap.reason = reason || 'auto';
        var text = JSON.stringify(snap);
        ok = writeText(latestPath(), text);
        if (ok) {
            writeText(baseDir() + '/kanpan-vault-' + dayTag() + '.json', text);
            prune();
        }
    }
    var meta = readMeta();
    try {
        meta.at = snap.at;
        meta.rows = snap.rows;
        meta.reason = snap.reason || reason || 'auto';
        meta.fileOk = ok;
        wx.setStorageSync(META_KEY, meta);
    } catch (e) { /* ignore */ }
    cloudMirror(snap, reason, meta);
    snap.fileOk = ok;
    return snap;
}

/** 云端整包镜像：本机没有可用文件系统时（托管预览/H5）就靠它兜底 */
function cloudMirror(snap, reason, meta) {
    var force = reason === 'hide' || reason === 'manual' || reason === 'import' || reason === 'setup';
    var now = Date.now();
    if (!force && now - _lastCloud < CLOUD_MIN_GAP) return;
    // 守卫：没有核心数据 / 条数明显缩水（storage 疑似被清）时，宁可不动云端
    var core = coreRows(snap);
    if (!core) return;
    var prev = (meta && meta.cloudRows) || 0;
    if (!force && prev && snap.rows < prev - 5) return;
    var cloudData;
    try {
        cloudData = require('./cloudData');
    } catch (e) {
        return;
    }
    if (!cloudData || !cloudData.available) return;
    _lastCloud = now;
    var m = meta || {};
    m.cloudRows = snap.rows;
    m.cloudAt = new Date().toISOString();
    try { wx.setStorageSync(META_KEY, m); } catch (e2) { /* ignore */ }
    cloudData.saveVaultBackup(snap).catch(function () { });
}

/** 从云端整包快照恢复（本机文件也没有时用） */
function cloudRestore() {
    var cloudData;
    try {
        cloudData = require('./cloudData');
    } catch (e) {
        return Promise.resolve({ restored: 0, merged: 0 });
    }
    if (!cloudData || !cloudData.available) return Promise.resolve({ restored: 0, merged: 0 });
    return cloudData.loadVaultBackup().then(function (res) {
        if (!res || !res.ok || !res.data || !res.data.payload) return { restored: 0, merged: 0 };
        var out = applySnapshot({ keys: res.data.payload, at: res.data.savedAt });
        out.cloud = true;
        out.at = res.data.savedAt;
        if (out.restored || out.merged) {
            persist('cloud-restore');
            emitApplied(out);
        }
        return out;
    }).catch(function () {
        return { restored: 0, merged: 0 };
    });
}

/** 注册「数据已被回灌」的回调，页面可以据此重绘；返回取消函数 */
function onApplied(fn) {
    if (typeof fn !== 'function') return function () { };
    _listeners.push(fn);
    return function () {
        var i = _listeners.indexOf(fn);
        if (i >= 0) _listeners.splice(i, 1);
    };
}

function emitApplied(res) {
    for (var i = 0; i < _listeners.length; i++) {
        try {
            _listeners[i](res);
        } catch (e) { /* ignore */ }
    }
}

/** 只保留最近 KEEP_DAYS 份按日快照 */
function prune() {
    var f = fm();
    var d = baseDir();
    if (!f || !d) return;
    var files = [];
    try {
        files = f.readdirSync(d) || [];
    } catch (e) {
        return;
    }
    var daily = [];
    for (var i = 0; i < files.length; i++) {
        if (files[i].indexOf('kanpan-vault-') === 0) daily.push(files[i]);
    }
    daily.sort();
    while (daily.length > KEEP_DAYS) {
        var victim = daily.shift();
        try {
            f.unlinkSync(d + '/' + victim);
        } catch (e2) { /* ignore */ }
    }
}

/** 防抖写盘：各模块 save() 后调用，避免连续写入 */
function touch(reason) {
    if (_timer) {
        try { clearTimeout(_timer); } catch (e) { /* ignore */ }
    }
    var why = reason || 'auto';
    _timer = setTimeout(function () {
        _timer = null;
        persist(why);
    }, DEBOUNCE_MS);
}

/** 立即写盘（页面隐藏 / 手动备份时用） */
function flush(reason) {
    if (_timer) {
        try { clearTimeout(_timer); } catch (e) { /* ignore */ }
        _timer = null;
    }
    return persist(reason || 'flush');
}

function readLatest() {
    var text = readText(latestPath());
    if (!text) return null;
    try {
        var obj = JSON.parse(text);
        if (!obj || !obj.keys) return null;
        return obj;
    } catch (e) {
        return null;
    }
}

/** 把一份快照合并进 storage，返回 { restored, merged, keys } */
function applySnapshot(snap) {
    if (!snap || !snap.keys) return { restored: 0, merged: 0, keys: 0 };
    var restored = 0;
    var merged = 0;
    var used = 0;
    for (var key in snap.keys) {
        if (!snap.keys.hasOwnProperty(key)) continue;
        used++;
        var fileVal = snap.keys[key];
        if (isEmpty(fileVal)) continue;
        var cur;
        try {
            cur = wx.getStorageSync(key);
        } catch (e) {
            cur = '';
        }
        var next = null;
        var isRestore = false;
        if (isEmpty(cur)) {
            next = fileVal;
            // 回灌时按原模块的条数上限截断，避免把旧版本写的超长列表塞回去
            var cap = MAX_LIST[key];
            if (cap && next instanceof Array && next.length > cap) next = next.slice(next.length - cap);
            isRestore = true;
        } else if (cur instanceof Array && fileVal instanceof Array) {
            var m = mergeList(key, fileVal, cur);
            if (JSON.stringify(m) !== JSON.stringify(cur)) next = m;
        } else if (typeof cur === 'object' && typeof fileVal === 'object') {
            var f2 = {};
            var k;
            for (k in fileVal) {
                if (fileVal.hasOwnProperty(k)) f2[k] = fileVal[k];
            }
            for (k in cur) {
                if (cur.hasOwnProperty(k) && !isEmpty(cur[k])) f2[k] = cur[k];
            }
            if (JSON.stringify(f2) !== JSON.stringify(cur)) next = f2;
        }
        if (next === null) continue;
        try {
            wx.setStorageSync(key, next);
            if (isRestore) restored++;
            else merged++;
        } catch (e2) { /* ignore */ }
    }
    return { restored: restored, merged: merged, keys: used };
}

/** 回灌后把复盘数据补推云端（云端表若此前为空，这一步就把历史补齐了） */
function pushCloud() {
    var cloudData;
    try {
        cloudData = require('./cloudData');
    } catch (e) {
        return Promise.resolve(0);
    }
    if (!cloudData || !cloudData.available) return Promise.resolve(0);
    var jobs = [];
    var list = [];
    try {
        list = wx.getStorageSync('kanpan:bgHist') || [];
    } catch (e) { list = []; }
    var i;
    for (i = 0; i < list.length; i++) {
        var r = list[i];
        if (!r || !r.ymd || !r.model) continue;
        jobs.push(cloudData.saveBgamePred({
            ymd: r.ymd,
            model: r.model,
            pred: r.pred,
            lo: r.lo,
            hi: r.hi,
            m: r.m,
            quad: r.quad,
            actual_pct: r.actual
        }));
    }
    var sig = [];
    try {
        sig = wx.getStorageSync('kanpan:sigHist') || [];
    } catch (e2) { sig = []; }
    for (i = 0; i < sig.length; i++) {
        var s = sig[i];
        if (!s || !s.date) continue;
        jobs.push(cloudData.saveSigHist({
            ymd: s.date,
            score: s.score,
            close: s.close,
            openPct: s.openPct,
            real: s.real,
            breadth: s.breadth
        }));
    }
    if (!jobs.length) return Promise.resolve(0);
    return Promise.all(jobs).then(function () {
        return jobs.length;
    }).catch(function () {
        return 0;
    });
}

/**
 * 启动回灌：storage 为空/缺记录时用文件补齐
 * @param {Object} opt { push: 是否顺带推云端 }
 */
function restore(opt) {
    var o = opt || {};
    var snap = readLatest();
    if (!snap) {
        if (ensureDir()) persist('init');
        return { ok: !!baseDir(), restored: 0, merged: 0, error: baseDir() ? '暂无本机备份文件' : '本机无文件系统' };
    }
    var res = applySnapshot(snap);
    res.ok = true;
    res.at = snap.at;
    res.rows = snap.rows || 0;
    if (res.restored || res.merged) {
        if (o.push !== false) pushCloud().catch(function () { });
        emitApplied(res);
    }
    return res;
}

/** 导出为可复制/可保存的 JSON 文本 */
function exportText() {
    var snap = snapshot();
    return JSON.stringify(snap);
}

/** 从 JSON 文本导入（剪贴板恢复用） */
function importText(text) {
    if (!text) return { ok: false, restored: 0, merged: 0, error: '内容为空' };
    var obj = null;
    try {
        obj = JSON.parse(text);
    } catch (e) {
        return { ok: false, restored: 0, merged: 0, error: '不是合法 JSON' };
    }
    if (!obj || !obj.keys) return { ok: false, restored: 0, merged: 0, error: '不是本项目的备份' };
    var res = applySnapshot(obj);
    res.ok = true;
    res.at = obj.at || '';
    persist('import');
    pushCloud().catch(function () { });
    return res;
}

/** 备份状态，给设置页展示 */
function status() {
    var snap = readLatest();
    var meta = {};
    try {
        meta = wx.getStorageSync(META_KEY) || {};
    } catch (e) { meta = {}; }
    var keys = 0;
    if (snap && snap.keys) {
        for (var k in snap.keys) {
            if (snap.keys.hasOwnProperty(k)) keys++;
        }
    }
    return {
        exists: !!snap,
        at: (snap && snap.at) || meta.at || '',
        rows: (snap && snap.rows) || meta.rows || 0,
        keys: keys,
        hasFs: !!baseDir(),
        fileOk: meta.fileOk !== false,
        cloudAt: meta.cloudAt || '',
        cloudRows: meta.cloudRows || 0,
        path: latestPath() || '本机无文件系统（已改用云端整包备份）'
    };
}

/** 启动钩子：先回灌本机文件，没有就拉云端整包快照；随后起自动备份 */
function boot() {
    var res = { restored: 0, merged: 0, ok: false };
    try {
        res = restore({ push: true });
    } catch (e) {
        res.error = (e && e.message) || '本地备份回灌失败';
    }
    // 本机文件之后再拉一次云端整包快照：本地缺的记录用它补齐（合并是「有值优先」，不会覆盖本机新数据）
    setTimeout(function () {
        cloudRestore();
    }, 600);
    // 启动 8 秒后强制镜像一次，保证云端副本始终跟手
    setTimeout(function () {
        persist('boot-timer');
    }, 8000);
    return res;
}

module.exports = {
    boot: boot,
    restore: restore,
    cloudRestore: cloudRestore,
    onApplied: onApplied,
    persist: flush,
    flush: flush,
    touch: touch,
    snapshot: snapshot,
    exportText: exportText,
    importText: importText,
    status: status,
    pushCloud: pushCloud,
    latestPath: latestPath,
    baseDir: baseDir,
    META_KEY: META_KEY
};
