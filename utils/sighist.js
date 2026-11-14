/**
 * 次日倾向复盘记录（科技板块口径 + 云端留存）
 * - 每天 15:00 A 股收盘后：把当时「次日倾向」信号分（含 A股模型汇总）记录为预测
 * - 次日 9:30 开盘后：用科技板块一篮子标的（中韩半导体/芯片/半导体 ETF + 长鑫科技）
 *   的开盘跳空等权平均作为真实值，±3% 折算 -100..100 与信号分同轴可比
 * - 双写：本机 storage（最多 120 条）+ 云端 sig_hist 表（跨设备/重新发布不丢）
 *   本地每次改动防抖推送云端；启动时拉云端合并（云端有本地无的补入）
 */
var cloudData = require('./cloudData');
var vault = require('./vault');

var KEY = 'kanpan:sigHist';
var MAX = 120;
var REAL_SPAN = 3; // 开盘涨跌幅满刻度（%）

/** 科技板块真实值成分（等权平均开盘跳空） */
var TECH_SECS = ['1.513310', '0.159995', '1.512480', '1.688825'];
var TECH_NAMES = ['中韩半导体ETF', '芯片ETF', '半导体ETF', '长鑫科技'];

function clamp(v, lo, hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
}

function realOf(openPct) {
    return clamp(openPct / REAL_SPAN * 100, -100, 100);
}

function load() {
    var raw = wx.getStorageSync(KEY);
    if (!Array.isArray(raw)) return [];
    var out = [];
    for (var i = 0; i < raw.length; i++) {
        var it = raw[i];
        if (it && it.date && isFinite(Number(it.score))) out.push(it);
    }
    return out;
}

function save(list) {
    var out = list.slice(-MAX);
    out.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    wx.setStorageSync(KEY, out);
    // 本地文件镜像：重新发布/清缓存后由 vault 启动回灌
    try { vault.touch('sigHist'); } catch (e) { /* ignore */ }
    return out;
}

function find(list, date) {
    for (var i = 0; i < list.length; i++) {
        if (list[i].date === date) return list[i];
    }
    return null;
}

// ---------- 云端同步（失败静默，本地始终有底） ----------

var pushTimer = null;

function pushNow(date) {
    var row = find(load(), date);
    if (!row) return;
    cloudData.saveSigHist({
        ymd: row.date,
        score: row.score,
        close: row.close,
        openPct: row.openPct,
        real: row.real,
        breadth: row.breadth || ''
    }).then(function (res) {
        if (res && !res.ok) console.warn('[sigHist] 云端写入失败：', res.error);
    }).catch(function (e) {
        console.warn('[sigHist] 云端写入异常：', (e && e.message) || e);
    });
}

function pushSoon(date) {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(function () {
        pushTimer = null;
        pushNow(date);
    }, 1500);
}

/** 启动时与云端合并：云端有本地无的补入；本地缺真实值而云端有则采纳 */
function sync() {
    return cloudData.loadSigHist().then(function (res) {
        if (!res || !res.ok || !Array.isArray(res.data)) return load();
        var list = load();
        var dirty = false;
        var cloudKeys = {};
        for (var i = 0; i < res.data.length; i++) {
            var c = res.data[i];
            if (!c || !c.ymd) continue;
            cloudKeys[c.ymd] = 1;
            var local = find(list, c.ymd);
            var cOpen = c.open_pct === null || c.open_pct === undefined ? null : Number(c.open_pct);
            var cReal = c.real === null || c.real === undefined ? null : Number(c.real);
            if (!local) {
                list.push({
                    date: c.ymd,
                    score: c.score === null || c.score === undefined ? null : Math.round(Number(c.score)),
                    close: c.close === null || c.close === undefined ? null : Number(c.close),
                    openPct: cOpen,
                    real: cReal,
                    breadth: c.breadth || ''
                });
                dirty = true;
            } else if (cOpen !== null && (local.openPct === null || local.openPct === undefined)) {
                local.openPct = cOpen;
                local.real = cReal;
                if (c.breadth) local.breadth = c.breadth;
                dirty = true;
            }
        }
        if (dirty) save(list);
        // 云端缺的本地记录补推（历史上云端写入失败留下的空洞，最多补最近 60 天）
        var finalList = load();
        var missing = 0;
        for (var m = finalList.length - 1; m >= 0 && missing < 60; m--) {
            var fr = finalList[m];
            if (fr && fr.date && !cloudKeys[fr.date]) {
                missing++;
                pushNow(fr.date);
            }
        }
        return finalList;
    }).catch(function () {
        return load();
    });
}

/** 收盘后记录当日信号分（只记一次，避免盘中反复覆盖） */
function recordScore(date, score, close, breadth) {
    if (!isFinite(Number(score))) return load();
    var list = load();
    var rec = find(list, date);
    if (!rec) {
        rec = {
            date: date,
            score: Math.round(Number(score)),
            close: close === undefined ? null : close,
            openPct: null,
            real: null,
            breadth: breadth || ''
        };
        list.push(rec);
    } else if (rec.score === null || rec.score === undefined) {
        rec.score = Math.round(Number(score));
        if (rec.close === null || rec.close === undefined) rec.close = close === undefined ? null : close;
        if (breadth && !rec.breadth) rec.breadth = breadth;
    } else {
        return list;
    }
    save(list);
    pushSoon(date);
    return load();
}

/** 次日开盘后补真实值（只补一次） */
function fillReal(date, openPct, breadth) {
    if (!isFinite(Number(openPct))) return load();
    var list = load();
    var rec = find(list, date);
    if (!rec || (rec.openPct !== null && rec.openPct !== undefined)) return list;
    rec.openPct = Number(openPct);
    rec.real = realOf(rec.openPct);
    if (breadth) rec.breadth = breadth;
    save(list);
    pushSoon(date);
    return load();
}

/** 待补真实值的记录：有分无真实且早于 today */
function pendingReal(list, today) {
    for (var i = list.length - 1; i >= 0; i--) {
        var it = list[i];
        if (it.date < today && (it.openPct === null || it.openPct === undefined)) return it;
    }
    return null;
}

/** 方向命中率：|score|>=10 且已有真实值才计入 */
function stats(list) {
    var total = 0;
    var hit = 0;
    for (var i = 0; i < list.length; i++) {
        var it = list[i];
        if (it.openPct === null || it.openPct === undefined) continue;
        if (Math.abs(it.score) < 10) continue;
        total++;
        if ((it.score > 0 && it.openPct > 0) || (it.score < 0 && it.openPct < 0)) hit++;
    }
    return {
        total: total,
        hit: hit,
        pctText: total > 0 ? (hit / total * 100).toFixed(0) + '%' : '--'
    };
}

module.exports = {
    KEY: KEY,
    MAX: MAX,
    REAL_SPAN: REAL_SPAN,
    TECH_SECS: TECH_SECS,
    TECH_NAMES: TECH_NAMES,
    load: load,
    save: save,
    find: find,
    recordScore: recordScore,
    fillReal: fillReal,
    pendingReal: pendingReal,
    stats: stats,
    realOf: realOf,
    sync: sync
};
