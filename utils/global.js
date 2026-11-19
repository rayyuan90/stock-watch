/**
 * 全球市场行情（独立模块，不影响现有 A股/美股/模型逻辑）
 *
 * 覆盖：恒生科技指数、恒生科技指数期货、首尔综合指数、日经225、日经225期货、
 *      标普500、纳斯达克100期货、VIX 恐慌指数期货、纽约黄金、纽约白银、美元/离岸人民币
 *
 * 三路数据源（按标的分配，互不干扰）：
 * - 东方财富 push2（已在白名单）：全球指数 / 港股期货 / 美元期货 / 汇率
 * - 腾讯行情 qt.gtimg.cn（已在白名单）：恒生科技指数
 * - 新浪财经 hq.sinajs.cn（需在白名单，仅日经期货 + VIX 期货用到）：外盘指数期货
 *
 * 任何一路失败都不影响其它：失败项回落到本地缓存，并标记 stale；页面会给出提示。
 */

var EM_URL = 'https://push2.eastmoney.com/api/qt/ulist.np/get';
var TX_URL = 'https://qt.gtimg.cn/q=';
var SINA_URL = 'https://hq.sinajs.cn/list=';
var CACHE_KEY = 'kanpan:globalCache';
var TIMEOUT = 8000;

var GROUPS = [
    { key: 'asia', title: '亚太市场', sub: '港股 · 韩股 · 日股' },
    { key: 'us', title: '美股与波动率', sub: '标普 · 纳指期货 · VIX' },
    { key: 'cmdt', title: '商品与汇率', sub: '贵金属 · 离岸人民币' }
];

var ITEMS = [
    { key: 'hstech', group: 'asia', name: '恒生科技指数', sub: '港股 · 恒生科技', src: 'tx', code: 'hkHSTECH', digits: 2 },
    { key: 'htif', group: 'asia', name: '恒生科技指数期货', sub: '港交所 · 当月', src: 'em', dyn: 'hti', digits: 1 },
    { key: 'kospi', group: 'asia', name: '首尔综合指数', sub: '韩国 · KOSPI', src: 'em', id: '100.KS11', digits: 2 },
    { key: 'n225', group: 'asia', name: '日经225指数', sub: '日本 · 现货', src: 'em', id: '100.N225', digits: 2 },
    { key: 'n225f', group: 'asia', name: '日经225指数期货', sub: 'CME · 当月连续', src: 'sina', code: 'hf_NK', digits: 1, fallback: { src: 'em', id: '100.N225', note: '期货源被拦，暂显示现货' } },
    { key: 'spx', group: 'us', name: '标普500指数', sub: '美股 · SPX', src: 'em', id: '100.SPX', digits: 2 },
    { key: 'nqf', group: 'us', name: '纳斯达克100指数期货', sub: 'CME · 当月连续', src: 'em', id: '103.NQ00Y', digits: 2 },
    { key: 'vixf', group: 'us', name: 'VIX 恐慌指数期货', sub: 'CBOE · 当月连续', src: 'sina', code: 'hf_VX', digits: 3, fallback: { src: 'em', id: '107.VIXY', note: '期货源被拦，暂用VIX期货ETF替代' } },
    { key: 'gold', group: 'cmdt', name: '纽约黄金', sub: 'COMEX · 美元/盎司', src: 'em', id: '101.GC00Y', digits: 2 },
    { key: 'silver', group: 'cmdt', name: '纽约白银', sub: 'COMEX · 美元/盎司', src: 'em', id: '101.SI00Y', digits: 3 },
    { key: 'cnh', group: 'cmdt', name: '美元/离岸人民币', sub: 'USDCNH', src: 'em', id: '133.USDCNH', digits: 4 }
];

// 恒生科技指数期货：合约月份代码（HKEX 惯例 F=1月 … Z=12月），取当月及后 3 个月做候选
var MONTH_LETTER = ['F', 'G', 'H', 'J', 'K', 'M', 'N', 'Q', 'U', 'V', 'X', 'Z'];

function htiCandidates() {
    var out = [];
    var base = new Date();
    for (var i = 0; i < 4; i++) {
        var d = new Date(base.getFullYear(), base.getMonth() + i, 1);
        out.push('134.HTI' + MONTH_LETTER[d.getMonth()] + String(d.getFullYear() % 10));
    }
    return out;
}

function num(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
}

function req(url, header) {
    return new Promise(function (resolve) {
        var done = false;
        var finish = function (res) {
            if (done) return;
            done = true;
            resolve(res);
        };
        var timer = setTimeout(function () {
            finish({ ok: false, error: '超时' });
        }, TIMEOUT);
        try {
            wx.request({
                url: url,
                method: 'GET',
                timeout: TIMEOUT,
                header: header || {},
                success: function (res) {
                    clearTimeout(timer);
                    var body = res && res.data;
                    if (res && res.statusCode === 200 && body !== '' && body !== null && body !== undefined) {
                        finish({ ok: true, data: body });
                    } else {
                        finish({ ok: false, error: 'HTTP ' + (res && res.statusCode) });
                    }
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

/** 东方财富批量：一次请求拿回所有 em 标的 */
function fetchEm(ids) {
    var url = EM_URL + '?fltt=2&secids=' + ids.join(',') + '&fields=f2,f3,f4,f12,f14,f18,f124';
    return req(url).then(function (res) {
        if (!res.ok) return { ok: false, quotes: {}, error: res.error };
        var body = res.data;
        if (typeof body === 'string') {
            try {
                body = JSON.parse(body);
            } catch (e) {
                return { ok: false, quotes: {}, error: '解析失败' };
            }
        }
        var diff = body && body.data && body.data.diff;
        if (!diff || !diff.length) return { ok: false, quotes: {}, error: '无数据' };
        var quotes = {};
        for (var i = 0; i < diff.length; i++) {
            var d = diff[i];
            if (!d || !d.f12) continue;
            var price = num(d.f2);
            if (price === null) continue;
            quotes[String(d.f12)] = {
                price: price,
                pct: num(d.f3),
                prev: num(d.f18),
                name: d.f14 || '',
                at: d.f124 ? Number(d.f124) * 1000 : 0
            };
        }
        return { ok: true, quotes: quotes, error: '' };
    });
}

/** 腾讯：港股指数。字段用 ~ 分隔 */
function fetchTx(code) {
    return req(TX_URL + code).then(function (res) {
        if (!res.ok) return { ok: false, quote: null, error: res.error };
        var text = String(res.data || '');
        var i = text.indexOf('="');
        if (i < 0) return { ok: false, quote: null, error: '无数据' };
        var body = text.slice(i + 2, text.lastIndexOf('"'));
        var f = body.split('~');
        if (f.length < 33) return { ok: false, quote: null, error: '字段不足' };
        var price = num(f[3]);
        if (price === null || price <= 0) return { ok: false, quote: null, error: '无成交' };
        var at = 0;
        try {
            at = new Date(String(f[30]).replace(/\//g, '-')).getTime() || 0;
        } catch (e) { at = 0; }
        return {
            ok: true,
            quote: {
                price: price,
                pct: num(f[32]),
                prev: num(f[4]),
                name: f[1] || '',
                at: at
            },
            error: ''
        };
    });
}

/** 新浪：外盘指数期货。需要 Referer，否则 403 */
function fetchSina(codes) {
    var header = { Referer: 'https://finance.sina.com.cn' };
    return req(SINA_URL + codes.join(','), header).then(function (res) {
        if (!res.ok) return { ok: false, quotes: {}, error: res.error };
        var text = String(res.data || '');
        if (text.indexOf('hq_str_') < 0) return { ok: false, quotes: {}, error: '被拦截或返回为空' };
        var quotes = {};
        var lines = text.split('\n');
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            var p = line.indexOf('hq_str_');
            var q = line.indexOf('="');
            if (p < 0 || q < 0) continue;
            var code = line.slice(p + 7, q);
            var body = line.slice(q + 2, line.lastIndexOf('"'));
            var f = body.split(',');
            if (f.length < 9) continue;
            var price = num(f[0]);
            if (price === null) continue;
            var at = 0;
            try {
                if (f[12] && f[6]) at = new Date(f[12] + ' ' + f[6]).getTime() || 0;
            } catch (e) { at = 0; }
            quotes[code] = {
                price: price,
                prev: num(f[7]),
                at: at,
                name: ''
            };
        }
        return { ok: true, quotes: quotes, error: '' };
    });
}

// 东财被限流返回空时，用新浪（已在 request 白名单）补齐。
// 映射键是东财 secid 的短码（与回填逻辑 def.id.split('.')[1] 对齐）。
// 注意：标普必须走 gb_$inx（7323），不能用 int_sp500（6643，口径错误）；
//       纳指期货走 hf_NQ（期货对期货），不用 gb_$ndx（现货）。
// 首尔综合(KS11)、恒生科技指数期货(HTI) 新浪无可靠对应源，保持缓存。
var EM_SINA_MAP = {
    N225:   { code: 'int_nikkei', fmt: 'int' },  // 日经225现货
    SPX:    { code: 'gb_$inx',    fmt: 'gb'  },  // 标普500
    NQ00Y:  { code: 'hf_NQ',      fmt: 'hf'  },  // 纳指100期货
    GC00Y:  { code: 'hf_GC',      fmt: 'hf'  },  // COMEX黄金
    SI00Y:  { code: 'hf_SI',      fmt: 'hf'  },  // COMEX白银
    USDCNH: { code: 'fx_susdcnh', fmt: 'fx'  }   // 美元/离岸人民币
};

/** 按新浪字段格式解析出 price / pct */
function parseSinaField(f, fmt) {
    var price = null, pct = null;
    try {
        if (fmt === 'int') {          // 名称,现价,涨跌额,涨跌幅
            price = num(f[1]); pct = num(f[3]);
        } else if (fmt === 'gb') {    // 名称,现价,涨跌幅,时间,...
            price = num(f[1]); pct = num(f[2]);
        } else if (fmt === 'hf') {    // 现价,,买,卖,高,低,时间,昨收,...
            price = num(f[0]); pct = pctOf(price, num(f[7]));
        } else if (fmt === 'fx') {    // 时间,...,现价@8,...,名称,涨跌幅@10,...
            price = num(f[8]); pct = num(f[10]);
        }
    } catch (e) { /* ignore */ }
    return { price: price, pct: pct };
}

/** 东财失败时的新浪降级：missingIds 是东财 secid 数组，返回按短码索引的 quotes */
function fetchEmFromSina(missingIds) {
    var codes = [], pairs = [];
    for (var i = 0; i < missingIds.length; i++) {
        var short = String(missingIds[i]).split('.')[1];
        var map = EM_SINA_MAP[short];
        if (map) { codes.push(map.code); pairs.push({ short: short, map: map }); }
    }
    if (!codes.length) return Promise.resolve({ ok: false, quotes: {}, got: 0 });
    var header = { Referer: 'https://finance.sina.com.cn' };
    return req(SINA_URL + codes.join(','), header).then(function (res) {
        if (!res.ok) return { ok: false, quotes: {}, got: 0 };
        var text = String(res.data || '');
        if (text.indexOf('hq_str_') < 0) return { ok: false, quotes: {}, got: 0 };
        var lines = text.split('\n');
        var parsed = {};
        for (var i = 0; i < lines.length; i++) {
            var p = lines[i].indexOf('hq_str_');
            var q = lines[i].indexOf('="');
            if (p < 0 || q < 0) continue;
            parsed[lines[i].slice(p + 7, q)] = lines[i].slice(q + 2, lines[i].lastIndexOf('"')).split(',');
        }
        var quotes = {}, got = 0;
        for (var j = 0; j < pairs.length; j++) {
            var f = parsed[pairs[j].map.code];
            if (!f) continue;
            var v = parseSinaField(f, pairs[j].map.fmt);
            if (v.price === null) continue;
            quotes[pairs[j].short] = { price: v.price, pct: v.pct, prev: null, name: '', at: Date.now() };
            got++;
        }
        return { ok: got > 0, quotes: quotes, got: got };
    });
}

function readCache() {
    try {
        var raw = wx.getStorageSync(CACHE_KEY);
        if (raw && raw.quotes) return raw;
    } catch (e) { /* ignore */ }
    return { ts: 0, quotes: {} };
}

function writeCache(data) {
    try { wx.setStorageSync(CACHE_KEY, data); } catch (e) { /* ignore */ }
}

function pctOf(price, prev) {
    if (price === null || !prev) return null;
    return (price / prev - 1) * 100;
}

/** 千分位：61142.35 -> 61,142.35 */
function groupNum(text) {
    var parts = String(text).split('.');
    var intPart = parts[0];
    var neg = false;
    if (intPart.charAt(0) === '-') {
        neg = true;
        intPart = intPart.slice(1);
    }
    var out = '';
    for (var i = 0; i < intPart.length; i++) {
        if (i > 0 && (intPart.length - i) % 3 === 0) out += ',';
        out += intPart.charAt(i);
    }
    return (neg ? '-' : '') + out + (parts.length > 1 ? '.' + parts[1] : '');
}

function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
}

function monthDayClock(ms) {
    var d = new Date(Number(ms));
    if (!d.getTime()) return '';
    return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function clockOf(ms) {
    var d = new Date(ms || Date.now());
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

/** 组装成页面要用的结构 */
function decorate(freshQuotes, srcState, cache, notes) {
    notes = notes || {};
    var groups = [];
    var gi, ii;
    for (gi = 0; gi < GROUPS.length; gi++) {
        groups.push({
            key: GROUPS[gi].key,
            title: GROUPS[gi].title,
            sub: GROUPS[gi].sub,
            items: []
        });
    }
    var byGroup = {};
    for (gi = 0; gi < groups.length; gi++) byGroup[groups[gi].key] = groups[gi];

    for (ii = 0; ii < ITEMS.length; ii++) {
        var def = ITEMS[ii];
        var q = freshQuotes[def.key];
        var stale = false;
        var note = '';
        if (!q) {
            var c = cache.quotes[def.key];
            if (c && c.price) {
                q = c;
                stale = true;
                note = '缓存 ' + clockOf(c.ts);
            }
        }
        var price = q && q.price !== null && q.price !== undefined ? Number(q.price) : null;
        var pct = q ? (q.pct !== null && q.pct !== undefined ? Number(q.pct) : pctOf(price, q.prev)) : null;
        var cls = 'flat';
        if (pct !== null && pct > 0.0001) cls = 'up';
        else if (pct !== null && pct < -0.0001) cls = 'down';
        var subText = def.sub || '';
        if (note) subText = subText ? subText + ' · ' + note : note;
        if (notes[def.key]) subText = subText ? subText + ' · ' + notes[def.key] : notes[def.key];
        if (q && q.at) {
            var t = monthDayClock(q.at);
            if (t) subText = subText ? subText + ' · ' + t : t;
        }
        byGroup[def.group].items.push({
            key: def.key,
            name: def.name,
            subText: subText,
            price: price,
            pct: pct,
            cls: cls,
            stale: stale,
            priceText: price === null ? '--' : groupNum(price.toFixed(def.digits)),
            timeText: q && q.at ? monthDayClock(q.at) : '',
            pctText: pct === null ? '--' : (pct > 0 ? '+' : '') + pct.toFixed(2) + '%'
        });
    }

    var warn = '';
    var warnHint = '';
    var warnDomain = '';
    if (!srcState.em && !srcState.tx && !srcState.sina) {
        warn = '行情源暂时都不可用，显示的是本地缓存';
        warnHint = '稍后下拉重试；临时查看可点右上角「…」→ 打开调试';
    } else if (!srcState.em) {
        // 东财偶发返回空（真机常见 -324 ERR_EMPTY_RESPONSE），并非域名未加
        warn = '东方财富源暂时无响应，部分标的回落缓存';
        warnHint = '接口偶发为空，下拉重试即可；如一直如此再检查 push2.eastmoney.com 是否在 request 合法域名';
        warnDomain = 'push2.eastmoney.com';
    } else if (!srcState.sina) {
        warn = '新浪财经暂无响应，日经/VIX 期货回落缓存';
        warnHint = '如一直如此再检查 hq.sinajs.cn 是否在 request 合法域名';
        warnDomain = 'hq.sinajs.cn';
    } else if (!srcState.tx) {
        warn = '腾讯行情暂无响应，个别标的回落缓存';
        warnHint = '下拉重试即可';
    }

    return { groups: groups, warn: warn, warnHint: warnHint, warnDomain: warnDomain, ts: Date.now(), clock: clockOf(Date.now()) };
}

/**
 * 拉取全部行情
 * @returns Promise<{groups, warn, ts, clock, cacheOnly}>
 */
function fetchAll() {
    var emIds = [];
    var sinaCodes = [];
    var txCode = '';
    var i;
    for (i = 0; i < ITEMS.length; i++) {
        var it = ITEMS[i];
        if (it.src === 'em' && it.id) emIds.push(it.id);
        if (it.src === 'em' && it.dyn === 'hti') {
            var hti = htiCandidates();
            for (var j = 0; j < hti.length; j++) emIds.push(hti[j]);
        }
        if (it.src === 'sina' && it.code) sinaCodes.push(it.code);
        if (it.src === 'tx' && it.code) txCode = it.code;
    }

    var cache = readCache();
    var notes = {};
    var jobs = [
        fetchEm(emIds),
        txCode ? fetchTx(txCode) : Promise.resolve({ ok: false, quote: null }),
        sinaCodes.length ? fetchSina(sinaCodes) : Promise.resolve({ ok: false, quotes: {} })
    ];

    return Promise.all(jobs).then(function (res) {
        var em = res[0] || { ok: false, quotes: {} };
        var tx = res[1] || { ok: false, quote: null };
        var sina = res[2] || { ok: false, quotes: {} };
        // 东财被限流返回空时，用新浪补齐能覆盖的标的（含标普/纳指期货/黄金/白银/日经/汇率）。
        // 降级拿到的项打上 notes 标记，界面显示来源；em 只要部分恢复就不再误报黄条。
        var fbIds = [];
        for (var z = 0; z < ITEMS.length; z++) {
            var zd = ITEMS[z];
            if (zd.src !== 'em' || !zd.id) continue;
            var zShort = zd.id.split('.')[1];
            if (EM_SINA_MAP[zShort] && !em.quotes[zShort]) fbIds.push(zd.id);
        }
        var fbPromise = (!em.ok && fbIds.length)
            ? fetchEmFromSina(fbIds)
            : Promise.resolve({ ok: false, quotes: {}, got: 0 });
        return fbPromise.then(function (fb) {
        var emViaSina = 0;
        if (fb && fb.got > 0) {
            for (var fqk in fb.quotes) {
                if (fb.quotes.hasOwnProperty(fqk)) em.quotes[fqk] = fb.quotes[fqk];
            }
            em.ok = true;
            emViaSina = fb.got;
            for (var zn = 0; zn < ITEMS.length; zn++) {
                if (ITEMS[zn].src === 'em' && ITEMS[zn].id && fb.quotes[ITEMS[zn].id.split('.')[1]]) {
                    notes[ITEMS[zn].key] = '新浪源';
                }
            }
        }

        var fresh = {};
        // 东财：按 f12 代码回填
        for (i = 0; i < ITEMS.length; i++) {
            var def = ITEMS[i];
            if (def.src !== 'em') continue;
            if (def.dyn === 'hti') {
                var cands = htiCandidates();
                for (var k = 0; k < cands.length; k++) {
                    var code = cands[k].split('.')[1];
                    if (em.quotes[code]) {
                        var hq = em.quotes[code];
                        fresh[def.key] = hq;
                        // 合约月份从名称里取，例如「恒生科技指数期货2611」
                        var m = /(\d{4})$/.exec(hq.name || '');
                        if (m) notes[def.key] = '合约 ' + m[1];
                        break;
                    }
                }
                continue;
            }
            var shortId = def.id.split('.')[1];
            if (em.quotes[shortId]) fresh[def.key] = em.quotes[shortId];
        }
        // 腾讯：恒生科技指数
        if (tx.ok && tx.quote) {
            for (i = 0; i < ITEMS.length; i++) {
                if (ITEMS[i].src === 'tx' && ITEMS[i].code === txCode) fresh[ITEMS[i].key] = tx.quote;
            }
        }
        // 新浪：外盘期货
        for (i = 0; i < ITEMS.length; i++) {
            var sdef = ITEMS[i];
            if (sdef.src !== 'sina') continue;
            var sq = sina.quotes[sdef.code];
            if (sq) {
                sq.pct = pctOf(sq.price, sq.prev);
                fresh[sdef.key] = sq;
            }
        }
        // 兜底：新浪没拿到（被拦）时，日经期货退到东财现货
        for (i = 0; i < ITEMS.length; i++) {
            var fdef = ITEMS[i];
            if (fdef.src !== 'sina' || fresh[fdef.key] || !fdef.fallback) continue;
            var fb = fdef.fallback;
            var fbId = fb.id.split('.')[1];
            if (em.quotes[fbId]) {
                fresh[fdef.key] = em.quotes[fbId];
                notes[fdef.key] = fb.note;
            }
        }

        // 写缓存：只写本次拿到的
        var now = Date.now();
        var mergedCache = { ts: now, quotes: {} };
        for (var ck in cache.quotes) {
            if (cache.quotes.hasOwnProperty(ck)) mergedCache.quotes[ck] = cache.quotes[ck];
        }
        for (var fk in fresh) {
            if (!fresh.hasOwnProperty(fk)) continue;
            var fq = fresh[fk];
            mergedCache.quotes[fk] = {
                price: fq.price,
                pct: fq.pct,
                prev: fq.prev,
                at: fq.at || 0,
                ts: now
            };
        }
        writeCache(mergedCache);

        var state = { em: em.ok, tx: tx.ok, sina: sina.ok };
        var out = decorate(fresh, state, { ts: mergedCache.ts, quotes: cache.quotes }, notes);
        out.cacheOnly = !em.ok && !tx.ok && !sina.ok;
        return out;
        });
    }).catch(function (e) {
        var cache2 = readCache();
        var out2 = decorate({}, { em: false, tx: false, sina: false }, cache2);
        out2.cacheOnly = true;
        out2.error = (e && e.message) || '行情拉取失败';
        return out2;
    });
}

/** 先用缓存铺一版，避免白屏 */
function loadCacheView() {
    var cache = readCache();
    return decorate({}, { em: false, tx: false, sina: false }, cache);
}

module.exports = {
    ITEMS: ITEMS,
    GROUPS: GROUPS,
    CACHE_KEY: CACHE_KEY,
    fetchAll: fetchAll,
    loadCacheView: loadCacheView,
    htiCandidates: htiCandidates
};
