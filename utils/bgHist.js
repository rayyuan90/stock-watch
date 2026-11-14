/**
 * 多空博弈模型预测复盘
 * - 每次模型计算（A股 ASFMM-A / 美股 SFMM）把当日预测落库：ymd+model 唯一
 * - 该交易日的次次日（保证次日K线已完整收盘）用日K收盘价回填真实涨跌幅
 * - 云端表 bgame_pred 同步：本地记录立即推送；启动时拉取云端合并
 *   -> 换设备 / 清缓存后历史不丢（云端为准）
 * 本地 storage 最多 180 条 × 每天两条(a/us)
 */
var cloudData = require('./cloudData');

var KEY = 'kanpan:bgHist';
var MAX = 180;

function load() {
    var raw = wx.getStorageSync(KEY);
    if (!Array.isArray(raw)) return [];
    var out = [];
    for (var i = 0; i < raw.length; i++) {
        var it = raw[i];
        if (it && it.ymd && it.model && isFinite(Number(it.pred))) out.push(it);
    }
    return out;
}

function save(list) {
    var out = list.slice(-MAX);
    wx.setStorageSync(KEY, out);
    return out;
}

function keyOf(r) {
    return r.ymd + '|' + r.model;
}

function find(list, ymd, model) {
    for (var i = 0; i < list.length; i++) {
        if (list[i].ymd === ymd && list[i].model === model) return list[i];
    }
    return null;
}

/** 记录/更新一条预测（已回填真实值的记录不再改动预测字段） */
function record(rec) {
    if (!rec || !rec.ymd || !rec.model || !isFinite(Number(rec.pred))) return load();
    var list = load();
    var old = find(list, rec.ymd, rec.model);
    var row = {
        ymd: rec.ymd,
        model: rec.model,
        pred: Number(rec.pred),
        lo: Number(rec.lo),
        hi: Number(rec.hi),
        m: isFinite(Number(rec.m)) ? Number(rec.m) : null,
        quad: rec.quad || '',
        actual: old && old.actual !== null && old.actual !== undefined ? old.actual : null
    };
    if (old) {
        // 已评分的保留真实值；未评分的允许盘中刷新预测值
        if (row.actual === null) {
            old.pred = row.pred;
            old.lo = row.lo;
            old.hi = row.hi;
            old.m = row.m;
            old.quad = row.quad;
        }
    } else {
        list.push(row);
    }
    save(list);
    push(row.ymd, row.model);
    return load();
}

/** 用日K回填真实值：预测日 D 的次日真实涨跌 = close(D+1)/close(D)-1。
 *  只回填「D+1 之后再有一根完整日K」的记录，避免盘中用未收盘价提前评分 */
function fillActual(model, dates, closes) {
    if (!dates || dates.length < 3) return load();
    var list = load();
    var changed = [];
    for (var i = 0; i < list.length; i++) {
        var r = list[i];
        if (r.model !== model || (r.actual !== null && r.actual !== undefined)) continue;
        var idx = -1;
        for (var j = 0; j < dates.length; j++) {
            if (dates[j] === r.ymd) { idx = j; break; }
        }
        if (idx < 0 || idx + 2 > dates.length - 1) continue; // 次日K线须已完整
        var d0 = closes[idx];
        var d1 = closes[idx + 1];
        if (!d0) continue;
        r.actual = (d1 / d0 - 1) * 100;
        changed.push(r);
    }
    if (!changed.length) return load();
    save(list);
    for (var k = 0; k < changed.length; k++) {
        push(changed[k].ymd, changed[k].model);
    }
    return load();
}

/** 推送单条到云端（异步、失败静默，本地始终有底） */
function push(ymd, model) {
    var list = load();
    var row = find(list, ymd, model);
    if (!row) return;
    cloudData.saveBgamePred({
        ymd: row.ymd,
        model: row.model,
        pred: row.pred,
        lo: row.lo,
        hi: row.hi,
        m: row.m,
        quad: row.quad,
        actual_pct: row.actual
    }).catch(function () { });
}

/** 启动时与云端合并：云端有本地没有的补进来；云端已评分而本地未评分的采纳真实值 */
function sync() {
    return cloudData.loadBgamePred().then(function (res) {
        if (!res || !res.ok || !Array.isArray(res.data)) return load();
        var list = load();
        var dirty = false;
        for (var i = 0; i < res.data.length; i++) {
            var c = res.data[i];
            if (!c || !c.ymd || !c.model) continue;
            var local = find(list, c.ymd, c.model);
            var cActual = c.actual_pct === null || c.actual_pct === undefined ? null : Number(c.actual_pct);
            if (!local) {
                list.push({
                    ymd: c.ymd,
                    model: c.model,
                    pred: Number(c.pred),
                    lo: c.lo === null ? null : Number(c.lo),
                    hi: c.hi === null ? null : Number(c.hi),
                    m: c.m === null ? null : Number(c.m),
                    quad: c.quad || '',
                    actual: cActual
                });
                dirty = true;
            } else if (cActual !== null && (local.actual === null || local.actual === undefined)) {
                local.actual = cActual;
                dirty = true;
            }
        }
        if (dirty) save(list);
        return load();
    }).catch(function () {
        return load();
    });
}

/** 命中率统计：方向命中（预测|pred|>=0.05% 才计），区间命中（真实值落在 lo~hi 内） */
function stats(list, model) {
    var dirTotal = 0, dirHit = 0, rngTotal = 0, rngHit = 0;
    for (var i = 0; i < list.length; i++) {
        var r = list[i];
        if (model && r.model !== model) continue;
        if (r.actual === null || r.actual === undefined) continue;
        var p = Number(r.pred);
        if (Math.abs(p) >= 0.05) {
            dirTotal++;
            if ((p > 0 && r.actual > 0) || (p < 0 && r.actual < 0)) dirHit++;
        }
        if (r.lo !== null && r.hi !== null) {
            rngTotal++;
            if (r.actual >= Math.min(r.lo, r.hi) && r.actual <= Math.max(r.lo, r.hi)) rngHit++;
        }
    }
    return {
        dirTotal: dirTotal,
        dirHit: dirHit,
        dirPct: dirTotal ? Math.round(dirHit / dirTotal * 100) : null,
        rngTotal: rngTotal,
        rngHit: rngHit,
        rngPct: rngTotal ? Math.round(rngHit / rngTotal * 100) : null
    };
}

module.exports = {
    KEY: KEY,
    MAX: MAX,
    load: load,
    record: record,
    fillActual: fillActual,
    sync: sync,
    stats: stats
};
