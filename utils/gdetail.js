/**
 * 全球市场详情页数据层（独立新增，不改动 pages/detail）
 *
 * 覆盖矩阵（实测 2026-11-16）：
 *  - 东财 trends2 分时：KS11 / N225 / SPX / NQ00Y / GC00Y / SI00Y / USDCNH / VIXY / HTI期货 ✓
 *  - 东财 kline 日K：SPX / NQ00Y / GC00Y / SI00Y / USDCNH / VIXY / HTI期货 ✓；KS11 / N225 ✗
 *  - 腾讯 minute + fqkline：hkHSTECH ✓（东财对港指无历史数据）
 *  - 期货无独立源的（日经期货、VIX期货）用现货/ETF 基准并标注
 */

var EM_HIS = 'https://push2his.eastmoney.com/api/qt/stock';
var EM_ULIST = 'https://push2.eastmoney.com/api/qt/ulist.np/get';
var TX_MINUTE = 'https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=';
var TX_KLINE = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=';
var TIMEOUT = 9000;

function req(url, header) {
    return new Promise(function (resolve) {
        var done = false;
        var finish = function (res) {
            if (done) return;
            done = true;
            resolve(res);
        };
        var timer = setTimeout(function () { finish({ ok: false, error: '超时' }); }, TIMEOUT);
        try {
            wx.request({
                url: url,
                method: 'GET',
                timeout: TIMEOUT,
                header: header || {},
                success: function (res) {
                    clearTimeout(timer);
                    if (res && res.statusCode === 200 && res.data) finish({ ok: true, data: res.data });
                    else finish({ ok: false, error: 'HTTP ' + (res && res.statusCode) });
                },
                fail: function (e) {
                    clearTimeout(timer);
                    finish({ ok: false, error: (e && e.errMsg) || '请求失败' });
                }
            });
        } catch (e) {
            clearTimeout(timer);
            finish({ ok: false, error: (e && e.message) || '请求异常' });
        }
    });
}

function num(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
}

function jparse(body) {
    if (typeof body !== 'string') return body;
    try { return JSON.parse(body); } catch (e) { return null; }
}

/* ---------------- 标的解析 ---------------- */

var CHART_MAP = {
    hstech: { mode: 'tx', code: 'hkHSTECH' },
    htif: { mode: 'em', dyn: 'hti' },
    kospi: { mode: 'em', id: '100.KS11', noDaily: true },
    n225: { mode: 'em', id: '100.N225', noDaily: true },
    n225f: { mode: 'em', id: '100.N225', noDaily: true, note: '期货无独立K线源，以日经现货为基准' },
    spx: { mode: 'em', id: '100.SPX' },
    nqf: { mode: 'em', id: '103.NQ00Y' },
    vixf: { mode: 'em', id: '107.VIXY', note: '期货源以VIX期货ETF为基准' },
    gold: { mode: 'em', id: '101.GC00Y' },
    silver: { mode: 'em', id: '101.SI00Y' },
    cnh: { mode: 'em', id: '133.USDCNH' }
};

/** 恒生科技期货候选（与 global.js 同一套月份字母规则） */
function htiCandidates() {
    var MONTH_LETTER = ['F', 'G', 'H', 'J', 'K', 'M', 'N', 'Q', 'U', 'V', 'X', 'Z'];
    var out = [];
    var base = new Date();
    for (var i = 0; i < 4; i++) {
        var d = new Date(base.getFullYear(), base.getMonth() + i, 1);
        out.push('134.HTI' + MONTH_LETTER[d.getMonth()] + String(d.getFullYear() % 10));
    }
    return out;
}

/**
 * 解析 key → 图表数据源
 * @returns Promise<{mode, secid, code, name, digits, note, noDaily}>
 */
function resolve(key) {
    var def = null;
    var items = require('./global').ITEMS;
    for (var i = 0; i < items.length; i++) {
        if (items[i].key === key) { def = items[i]; break; }
    }
    if (!def) return Promise.reject(new Error('未知标的: ' + key));
    var plan = CHART_MAP[key];
    if (!plan) return Promise.reject(new Error('该标的暂不支持图表'));
    var base = {
        mode: plan.mode,
        name: def.name,
        digits: def.digits,
        note: plan.note || '',
        noDaily: !!plan.noDaily,
        secid: plan.id || '',
        code: plan.code || ''
    };
    if (plan.dyn === 'hti') {
        // 动态合约：批量查候选，取第一个有价的
        var ids = htiCandidates();
        return req(EM_ULIST + '?fltt=2&secids=' + ids.join(',') + '&fields=f2,f12,f14').then(function (res) {
            if (!res.ok) throw new Error(res.error);
            var body = jparse(res.data);
            var diff = body && body.data && body.data.diff;
            if (!diff || !diff.length) throw new Error('合约无数据');
            for (var k = 0; k < diff.length; k++) {
                if (num(diff[k].f2) !== null) {
                    base.secid = '134.' + diff[k].f12;
                    return base;
                }
            }
            throw new Error('当前无有效合约');
        });
    }
    return Promise.resolve(base);
}

/* ---------------- 分时 ---------------- */

/** 东财分时：trends 数组 "时间,价,量,均价" */
function fetchTrendEm(secid) {
    var url = EM_HIS + '/trends2/get?secid=' + secid + '&ndays=1&iscr=0&fields1=f1,f2,f3,f7,f8&fields2=f51,f53,f56,f58';
    return req(url).then(function (res) {
        if (!res.ok) throw new Error(res.error);
        var body = jparse(res.data);
        var d = body && body.data;
        var trends = d && d.trends;
        if (!trends || !trends.length) throw new Error('分时数据为空');
        var points = [];
        for (var i = 0; i < trends.length; i++) {
            var f = trends[i].split(',');
            points.push({
                t: f[0],
                p: num(f[1]),
                v: num(f[2]) || 0,
                avg: num(f[3])
            });
        }
        return { points: points, preClose: num(d.preClose), name: d.name || '' };
    });
}

/** 腾讯分时：行 "HHMM 价 累计量 累计额"，量做差分 */
function fetchTrendTx(code) {
    return req(TX_MINUTE + code).then(function (res) {
        if (!res.ok) throw new Error(res.error);
        var body = jparse(res.data);
        var node = body && body.data && body.data[code];
        var arr = node && node.data && node.data.data;
        if (!arr || !arr.length) throw new Error('分时数据为空');
        var points = [];
        var prevCum = 0;
        for (var i = 0; i < arr.length; i++) {
            var f = arr[i].split(' ');
            if (f.length < 3) continue;
            var cum = num(f[2]) || 0;
            points.push({
                t: f[0],
                p: num(f[1]),
                v: Math.max(0, cum - prevCum),
                avg: null
            });
            prevCum = cum;
        }
        var pre = null;
        try {
            pre = num(node.qt[code][4]);
        } catch (e) { pre = null; }
        return { points: points, preClose: pre, name: '' };
    });
}

/* ---------------- 日K ---------------- */

/** 东财日K："日期,开,收,高,低,量,额" */
function fetchDailyEm(secid, lmt) {
    var url = EM_HIS + '/kline/get?secid=' + secid + '&klt=101&fqt=1&lmt=' + (lmt || 120)
        + '&end=20500101&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57';
    return req(url).then(function (res) {
        if (!res.ok) throw new Error(res.error);
        var body = jparse(res.data);
        var d = body && body.data;
        var klines = d && d.klines;
        if (!klines || !klines.length) throw new Error('日K数据为空');
        var bars = [];
        for (var i = 0; i < klines.length; i++) {
            var f = klines[i].split(',');
            bars.push({
                d: f[0],
                o: num(f[1]),
                c: num(f[2]),
                h: num(f[3]),
                l: num(f[4]),
                v: num(f[5]) || 0
            });
        }
        return { bars: bars, name: d.name || '' };
    });
}

/** 腾讯日K：[日期,开,收,高,低,量,...] */
function fetchDailyTx(code, lmt) {
    return req(TX_KLINE + code + ',day,,,' + (lmt || 120) + ',qfq').then(function (res) {
        if (!res.ok) throw new Error(res.error);
        var body = jparse(res.data);
        var node = body && body.data && body.data[code];
        var arr = node && (node.qfqday || node.day);
        if (!arr || !arr.length) throw new Error('日K数据为空');
        var bars = [];
        for (var i = 0; i < arr.length; i++) {
            bars.push({
                d: arr[i][0],
                o: num(arr[i][1]),
                c: num(arr[i][2]),
                h: num(arr[i][3]),
                l: num(arr[i][4]),
                v: num(arr[i][5]) || 0
            });
        }
        return { bars: bars, name: '' };
    });
}

/* ---------------- 现价报价（页头用） ---------------- */

function fetchQuoteEm(secid) {
    return req(EM_ULIST + '?fltt=2&secids=' + secid + '&fields=f2,f3,f12,f14,f18,f124').then(function (res) {
        if (!res.ok) throw new Error(res.error);
        var body = jparse(res.data);
        var diff = body && body.data && body.data.diff;
        if (!diff || !diff.length || num(diff[0].f2) === null) throw new Error('无报价');
        var d = diff[0];
        return { price: num(d.f2), pct: num(d.f3), prev: num(d.f18), name: d.f14 || '' };
    });
}

function fetchQuoteTx(code) {
    return req('https://qt.gtimg.cn/q=' + code, { }).then(function (res) {
        if (!res.ok) throw new Error(res.error);
        var text = String(res.data || '');
        var i = text.indexOf('="');
        if (i < 0) throw new Error('无报价');
        var f = text.slice(i + 2, text.lastIndexOf('"')).split('~');
        if (f.length < 33) throw new Error('字段不足');
        return { price: num(f[3]), pct: num(f[32]), prev: num(f[4]), name: f[1] || '' };
    });
}

module.exports = {
    resolve: resolve,
    fetchTrendEm: fetchTrendEm,
    fetchTrendTx: fetchTrendTx,
    fetchDailyEm: fetchDailyEm,
    fetchDailyTx: fetchDailyTx,
    fetchQuoteEm: fetchQuoteEm,
    fetchQuoteTx: fetchQuoteTx
};
