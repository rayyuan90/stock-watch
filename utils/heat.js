/**
 * 板块热力图 + 机构/主力/大户/散户资金流 数据层（独立模块，不依赖现有页面逻辑）
 *
 * 数据源（均在 request 白名单内的 push2.eastmoney.com）：
 *  - 板块列表: /api/qt/clist/get  fs=m:90+t:2(行业) / m:90+t:3(概念)
 *      f14 板块名  f3 涨跌幅%  f2 板块指数  f62 主力净流入(元)
 *  - 大盘资金: /api/qt/ulist.np/get secids=1.000001,0.399001
 *      f62 主力净流入(超大+大)  f66 超大单  f72 大单  f78 中单  f84 小单
 *      校验：f62 + f78 + f84 ≈ 0（全市场资金守恒）
 */

var EM = 'https://push2.eastmoney.com/api/qt';

var HEAT_CACHE_KEY = 'kanpan:heatCache';
var FLOW_CACHE_KEY = 'kanpan:mflowCache';
var CACHE_MS = 15 * 60 * 1000; // 缓存 15 分钟内视为可用降级数据

/* ---------------- 通用 ---------------- */

function request(url) {
    return new Promise(function (resolve, reject) {
        wx.request({
            url: url,
            timeout: 8000,
            header: { 'User-Agent': 'Mozilla/5.0' },
            success: function (res) {
                if (res.statusCode !== 200 || !res.data) {
                    reject(new Error('HTTP ' + res.statusCode));
                    return;
                }
                resolve(res.data);
            },
            fail: function (e) {
                reject(new Error((e && e.errMsg) || 'request fail'));
            }
        });
    });
}

function readCache(key) {
    try {
        var v = wx.getStorageSync(key);
        if (v && v.ts && Date.now() - v.ts < CACHE_MS) return v;
    } catch (e) { /* ignore */ }
    return null;
}

function writeCache(key, val) {
    try { wx.setStorageSync(key, val); } catch (e) { /* ignore */ }
}

/** 金额（元）→ 亿/万 字符串 */
function fmtFlow(v) {
    if (v === null || v === undefined || isNaN(v)) return '--';
    var sign = v > 0 ? '+' : '';
    var a = Math.abs(v);
    if (a >= 1e8) return sign + (v / 1e8).toFixed(2) + '亿';
    if (a >= 1e4) return sign + (v / 1e4).toFixed(0) + '万';
    return sign + v.toFixed(0) + '元';
}

function fmtPct(p) {
    if (p === null || p === undefined || isNaN(p)) return '--';
    return (p > 0 ? '+' : '') + Number(p).toFixed(2) + '%';
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function clockOf(ts) {
    if (!ts) return '';
    var d = new Date(Number(ts));
    return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/* ---------------- 热力图 ---------------- */

/** 按涨跌幅强度给底色（A股习惯：涨红跌绿） */
function tileBg(pct) {
    var a, red = pct >= 0;
    var m = Math.abs(pct || 0);
    if (m >= 5) a = 0.96;
    else if (m >= 3) a = 0.84;
    else if (m >= 1.5) a = 0.68;
    else if (m >= 0.6) a = 0.52;
    else if (m >= 0.05) a = 0.38;
    else a = 0.22;
    var rgb = red ? '222,54,74' : '24,132,84';
    return 'background:rgba(' + rgb + ',' + a + ')';
}

/**
 * 拉全部板块并返回排序后的原始列表（涨幅榜 top60 + 跌幅榜 top60）
 * 注意：clist 接口服务端每页最多返回 100 条（pz 写再大也会被截成 100），
 * 一次降序请求只能拿到涨幅前 100，普涨日跌幅板块根本不在返回里。
 * 所以分两次请求：po=1 降序（涨幅榜）+ po=0 升序（跌幅榜）。
 * type: 'ind' 行业 | 'con' 概念
 */
function fetchBoards(type) {
    var fs = type === 'con' ? 'm:90+t:3+f:!50' : 'm:90+t:2+f:!50';
    function page(po) {
        var url = EM + '/clist/get?pn=1&pz=100&po=' + po + '&np=1&fltt=2&invt=2&fid=f3&fs='
            + encodeURIComponent(fs) + '&fields=f2,f3,f12,f14,f62';
        return request(url).then(function (data) {
            var diff = data && data.data && data.data.diff;
            if (!diff || !diff.length) throw new Error('板块数据为空');
            var out = [];
            for (var i = 0; i < diff.length; i++) {
                var d = diff[i];
                var pct = Number(d.f3);
                if (isNaN(pct)) continue;
                out.push({
                    code: d.f12,
                    name: d.f14,
                    pct: pct,
                    price: isNaN(Number(d.f2)) ? null : Number(d.f2),
                    flow: isNaN(Number(d.f62)) ? null : Number(d.f62)
                });
            }
            return out;
        });
    }
    return Promise.all([page(1), page(0)]).then(function (rs) {
        // rs[0] 降序（涨幅在前），rs[1] 升序（跌幅在前）
        var up = rs[0].filter(function (x) { return x.pct >= 0; }).slice(0, 60);
        var down = rs[1].filter(function (x) { return x.pct < 0; }).slice(0, 60);
        return { type: type, list: up.concat(down), ts: Date.now() };
    });
}

/** 从缓存的列表里取前十里并渲染成瓦片 */
function buildTiles(list, dir, size) {
    var src = (dir === 'down' ? list.filter(function (x) { return x.pct < 0; })
        .sort(function (a, b) { return a.pct - b.pct; })
        : list.filter(function (x) { return x.pct >= 0; })
            .sort(function (a, b) { return b.pct - a.pct; })).slice(0, size || 10);
    return src.map(function (x, i) {
        return {
            code: x.code,
            name: x.name,
            pctText: fmtPct(x.pct),
            flowText: '主力净流入: ' + fmtFlow(x.flow),
            bg: tileBg(x.pct),
            w: i === 0 ? 'w-full' : 'w-half'
        };
    });
}

function heatCache() { return readCache(HEAT_CACHE_KEY); }

/**
 * 取热力图数据
 * @param type 'ind'|'con'
 * @param dir  'up'|'down'
 * @returns Promise<{tiles, updatedAt, fromCache}>
 */
function getHeat(type, dir) {
    var cached = heatCache();
    var mine = cached && cached[type];
    var jobs = [fetchBoards(type).then(function (r) {
        return { fresh: r };
    })];
    return Promise.all(jobs).then(function (res) {
        var fresh = res[0].fresh;
        // 更新缓存
        var store = cached || { ind: null, con: null, ts: 0 };
        store[type] = fresh.list;
        store.ts = fresh.ts;
        writeCache(HEAT_CACHE_KEY, store);
        return {
            tiles: buildTiles(fresh.list, dir),
            updatedAt: clockOf(fresh.ts),
            fromCache: false
        };
    }).catch(function (e) {
        if (mine && mine.list && mine.list.length) {
            return {
                tiles: buildTiles(mine.list, dir),
                updatedAt: clockOf(mine.ts || cached.ts) + ' 缓存',
                fromCache: true
            };
        }
        throw e;
    });
}

/* ---------------- 机构/主力/大户/散户 ---------------- */

/**
 * 沪深两市合计的四类资金（单位：元，净流入）
 * 口径（东财）：
 *   主力 = 超大单 + 大单（f62）
 *   机构 = 超大单（f66）
 *   大户 = 大单（f72）
 *   散户 = 中单 + 小单（f78 + f84）
 */
function getFlow() {
    var url = EM + '/ulist.np/get?fltt=2&invt=2&secids=1.000001,0.399001'
        + '&fields=f12,f14,f62,f66,f72,f78,f84,f124';
    return request(url).then(function (data) {
        var diff = data && data.data && data.data.diff;
        if (!diff || !diff.length) throw new Error('资金流数据为空');
        var sum = { main: 0, inst: 0, big: 0, retail: 0, ts: 0, parts: [] };
        for (var i = 0; i < diff.length; i++) {
            var d = diff[i];
            var num = function (x) { return isNaN(Number(x)) ? 0 : Number(x); };
            var main = num(d.f62), inst = num(d.f66), big = num(d.f72);
            var mid = num(d.f78), small = num(d.f84);
            sum.main += main;
            sum.inst += inst;
            sum.big += big;
            sum.retail += mid + small;
            sum.ts = Math.max(sum.ts, Number(d.f124) * 1000 || 0);
            sum.parts.push({
                name: d.f14,
                main: fmtFlow(main),
                inst: fmtFlow(inst),
                big: fmtFlow(big),
                retail: fmtFlow(mid + small)
            });
        }
        var out = {
            ts: sum.ts,
            updatedAt: clockOf(sum.ts),
            items: [
                { key: 'inst', label: '机构', sub: '超大单口径', val: sum.inst, dot: '#e2506a' },
                { key: 'main', label: '主力', sub: '超大单+大单', val: sum.main, dot: '#e8a23c' },
                { key: 'big', label: '大户', sub: '大单口径', val: sum.big, dot: '#4cc3c9' },
                { key: 'retail', label: '散户', sub: '中单+小单', val: sum.retail, dot: '#6aa9e9' }
            ],
            parts: sum.parts
        };
        writeCache(FLOW_CACHE_KEY, out);
        return out;
    }).catch(function (e) {
        var cached = readCache(FLOW_CACHE_KEY);
        if (cached) {
            cached.fromCache = true;
            cached.updatedAt = (cached.updatedAt || '') + ' 缓存';
            return cached;
        }
        throw e;
    });
}

module.exports = {
    getHeat: getHeat,
    getFlow: getFlow,
    buildTiles: buildTiles,
    fmtFlow: fmtFlow,
    fmtPct: fmtPct,
    clockOf: clockOf,
    HEAT_CACHE_KEY: HEAT_CACHE_KEY,
    FLOW_CACHE_KEY: FLOW_CACHE_KEY
};
