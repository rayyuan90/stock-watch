/**
 * 行情数据层
 * 主数据源：东方财富 push2（https、无需鉴权、可批量）
 * 补充数据源：腾讯行情（覆盖韩股，东财不提供韩国市场）
 */

var EM_URL = 'https://push2.eastmoney.com/api/qt/ulist.np/get';
var TX_URL = 'https://qt.gtimg.cn/q=';

var snapshot = require('./snapshot');
var cloudData = require('./cloudData');

var EM_FIELDS = 'f1,f2,f3,f4,f5,f6,f12,f13,f14,f15,f16,f17,f18,f402';

// 一次请求覆盖：ETF / A股指数 / 美股与海外指数 / 中金所股指期货主力合约 / 纳指期货
var EM_LIST = [
    '1.513310',   // 中韩半导体ETF 华泰柏瑞
    '0.159995',   // 芯片ETF 华夏
    '1.512480',   // 半导体ETF 国联安
    '1.688825',   // 长鑫科技（科创板 · DRAM 存储）
    '1.588000',   // 科创50ETF 华夏
    '1.000001',   // 上证指数（f6 = 沪市总成交额）
    '0.399001',   // 深证成指（f6 = 深市总成交额）
    '0.399006',   // 创业板指
    '1.000300',   // 沪深300
    '1.000905',   // 中证500
    '1.000852',   // 中证1000
    '1.000016',   // 上证50
    '100.NDX',    // 纳斯达克
    '100.KS11',   // 韩国 KOSPI
    '105.SKHY',   // SK海力士（美股 OTC）
    '105.MU',     // 美光科技
    '105.SOXX',   // 半导体 ETF-iShares（费城半导体代理）
    '105.NVDA',   // 英伟达
    '103.NQ00Y',  // 小型纳指期货当月连续（CME E-mini NQ）
    '8.040130',   // IF 主力
    '8.060130',   // IC 主力
    '8.070130',   // IH 主力
    '8.150130'    // IM 主力
];

var TX_LIST = 'kr000660,kr005930'; // SK海力士、三星电子

// 用户自选（手动添加的股票 / 期货 / ETF），由 setExtras 注入后并入批量请求
var extraSecs = [];

function setExtras(list) {
    var out = [];
    for (var i = 0; i < (list || []).length; i++) {
        var sec = String(list[i] || '');
        if (sec && sec.indexOf('.') > 0 && out.indexOf(sec) < 0) out.push(sec);
    }
    extraSecs = out;
}

function allSecs() {
    var out = EM_LIST.slice();
    for (var i = 0; i < extraSecs.length; i++) {
        if (out.indexOf(extraSecs[i]) < 0) out.push(extraSecs[i]);
    }
    return out;
}

function isUsSec(sec) {
    var m = String(sec || '').split('.')[0];
    return m === '105' || m === '106' || m === '107';
}

// 腾讯韩股代码 → 东财 secid（详情页图表用东财数据）
var TX_SECID_MAP = {
    'kr000660': '177.000660',
    'kr005930': '177.005930'
};

function req(options) {
    return new Promise(function (resolve, reject) {
        wx.request({
            url: options.url,
            method: 'GET',
            timeout: options.timeout || 8000,
            dataType: options.dataType || 'json',
            success: function (res) {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(res.data);
                    return;
                }
                reject(new Error('HTTP ' + res.statusCode));
            },
            fail: function (err) {
                reject(new Error((err && err.errMsg) || '网络请求失败'));
            }
        });
    });
}

function scaled(v, digits) {
    var n = Number(v);
    if (v === '-' || v === null || v === undefined || !isFinite(n)) return null;
    return n / Math.pow(10, digits || 0);
}

function toArray(diff) {
    if (!diff) return [];
    if (Array.isArray(diff)) return diff;
    return Object.keys(diff).map(function (k) {
        return diff[k];
    });
}

function parseEastMoney(payload) {
    var out = {};
    if (!payload || !payload.data) return out;
    var list = toArray(payload.data.diff);
    for (var i = 0; i < list.length; i++) {
        var it = list[i];
        if (!it || !it.f12) continue;
        var digits = Number(it.f1);
        if (!isFinite(digits)) digits = 2;
        var id = it.f13 + '.' + it.f12;
        out[id] = {
            id: id,
            sec: id,
            market: it.f13,
            code: String(it.f12),
            name: it.f14 || '',
            price: scaled(it.f2, digits),
            pct: scaled(it.f3, 2),
            change: scaled(it.f4, digits),
            volume: scaled(it.f5, 0),
            amount: scaled(it.f6, 0),
            high: scaled(it.f15, digits),
            low: scaled(it.f16, digits),
            open: scaled(it.f17, digits),
            prevClose: scaled(it.f18, digits),
            // ETF 折溢价率：批量接口按 0.01% 返回（-568 → -5.68%）
            premium: scaled(it.f402, 2),
            digits: digits
        };
    }
    return out;
}

// 东财单标的接口 stock/get 已被服务端封禁（连接直接重置），
// 盘前盘后改为云端表 us_ext（云定时任务从新浪同步），小程序只读
var US_EXT_LIST = ['105.SKHY', '105.MU', '105.NVDA'];

var _usExtCache = { at: 0, map: null };
var US_EXT_CACHE_MS = 60 * 1000;

/** 基础美股 + 自选里的美股，盘前盘后都从云表取 */
function usExtTargets() {
    var out = US_EXT_LIST.slice();
    for (var i = 0; i < extraSecs.length; i++) {
        if (isUsSec(extraSecs[i]) && out.indexOf(extraSecs[i]) < 0) out.push(extraSecs[i]);
    }
    return out.slice(0, 15);
}

function fetchUsExt() {
    if (_usExtCache.map && Date.now() - _usExtCache.at < US_EXT_CACHE_MS) {
        return Promise.resolve(_usExtCache.map);
    }
    return cloudData.loadUsExt().then(function (res) {
        if (!res || !res.ok || !res.data || !res.data.length) return {};
        var map = {};
        for (var i = 0; i < res.data.length; i++) {
            var row = res.data[i];
            var secid = String(row.secid || '');
            if (!secid) continue;
            map[secid] = {
                id: secid,
                prePrice: numOrNull(row.pre_price),
                prePct: numOrNull(row.pre_pct),
                afterPrice: numOrNull(row.after_price),
                afterPct: numOrNull(row.after_pct)
            };
        }
        _usExtCache = { at: Date.now(), map: map };
        return map;
    }).catch(function () {
        return {};
    });
}

function parseTencent(text) {
    var out = {};
    if (typeof text !== 'string') return out;
    var re = /v_([A-Za-z0-9_]+)="([^"]*)"/g;
    var m = re.exec(text);
    while (m !== null) {
        var parts = m[2].split('~');
        if (parts.length > 34) {
            var price = Number(parts[3]);
            var prev = Number(parts[4]);
            var txKey = 'tx.' + m[1];
            out[txKey] = {
                id: txKey,
                code: parts[2] || m[1],
                name: parts[1] || m[1],
                price: isFinite(price) ? price : null,
                prevClose: isFinite(prev) ? prev : null,
                open: Number(parts[5]) || null,
                volume: Number(parts[6]) || null,
                change: Number(parts[31]),
                pct: Number(parts[32]),
                high: Number(parts[33]) || null,
                low: Number(parts[34]) || null,
                sec: TX_SECID_MAP[m[1]] || '',
                digits: price >= 1000 ? 0 : 2
            };
        }
        m = re.exec(text);
    }
    return out;
}

function fetchEastMoney() {
    var url = EM_URL + '?secids=' + allSecs().join(',') + '&fields=' + EM_FIELDS;
    return req({ url: url }).then(parseEastMoney);
}

function fetchTencent() {
    return req({ url: TX_URL + TX_LIST, dataType: 'text' }).then(parseTencent);
}

// ---------------- 搜索 / 单个报价（手动添加自选用） ----------------

var SEARCH_URL = 'https://searchapi.eastmoney.com/api/suggest/get';
var SEARCH_TOKEN = 'D43BF722C8E33BDC906FB84D85E326E8';
var QUOTE_FIELDS = 'f57,f58,f59,f43,f44,f45,f46,f47,f48,f60,f169,f170';

/** 排序权重：代码/名称精确命中的排前面，主流市场优先于三板等冷门市场 */
function rankOf(it, input) {
    var up = String(input || '').toUpperCase();
    var code = String(it.code || '').toUpperCase();
    var name = String(it.name || '');
    var score = 0;
    if (code === up) score -= 100;
    if (name === input) score -= 60;
    if (name.toUpperCase() === up) score -= 55;
    if (name.indexOf(input) === 0) score -= 20;
    var t = it.type || '';
    if (/美股|A股|沪A|深A|基金|期货|韩股|港股|指数/.test(t)) score -= 10;
    if (/三板|债|英股|德股|台股|日股/.test(t)) score += 40;
    return score;
}

/** 按名称 / 代码 / 拼音搜索，返回东财建议列表（带 QuoteID） */
function searchSymbol(kw) {
    var input = String(kw || '').trim();
    if (!input) return Promise.resolve([]);
    var url = SEARCH_URL + '?input=' + encodeURIComponent(input) +
        '&type=14&token=' + SEARCH_TOKEN + '&count=12';
    return req({ url: url, timeout: 6000 }).then(function (payload) {
        var table = payload && payload.QuotationCodeTable;
        var data = (table && table.Data) || [];
        var out = [];
        for (var i = 0; i < data.length; i++) {
            var it = data[i] || {};
            var sec = it.QuoteID;
            var tname = it.SecurityTypeName || '';
            if (!sec || String(sec).indexOf('.') < 0) continue;
            // 期权 / 窝轮 / 三板噪音太多，直接过滤
            if (/期权|窝轮|牛熊|债券|三板/.test(tname)) continue;
            out.push({
                sec: String(sec),
                code: it.Code || String(sec).split('.')[1],
                name: it.Name || '',
                type: tname || '行情',
                market: it.MktNum || String(sec).split('.')[0],
                rank: rankOf({ code: it.Code, name: it.Name, type: tname }, input) + i / 100
            });
        }
        out.sort(function (a, b) {
            return a.rank - b.rank;
        });
        return out;
    }).catch(function (e) {
        throw new Error(friendly(e && e.message));
    });
}

function numOrNull(v) {
    var n = Number(v);
    if (v === '-' || v === null || v === undefined || !isFinite(n)) return null;
    return n;
}

var QUOTE_ULIST_FIELDS = 'f1,f2,f3,f4,f5,f6,f12,f13,f14,f15,f16,f17,f18';

/** 单标的完整报价（含盘前盘后），用于详情页与自选校验。
 *  stock/get 已被东财封禁，基础字段改走批量接口（同格式），美股盘前盘后走云表。 */
function fetchQuote(sec) {
    var url = EM_URL + '?secids=' + encodeURIComponent(sec) + '&fields=' + QUOTE_ULIST_FIELDS;
    return Promise.all([
        req({ url: url }),
        isUsSec(sec) ? fetchUsExt() : Promise.resolve(null)
    ]).then(function (arr) {
        var list = parseEastMoney(arr[0]);
        var q = list[sec];
        if (!q || !q.name) throw new Error('该代码暂无行情');
        var ext = arr[1] ? arr[1][sec] : null;
        return {
            sec: sec,
            code: q.code,
            name: q.name,
            digits: q.digits,
            price: q.price,
            pct: q.pct,
            change: q.change,
            high: q.high,
            low: q.low,
            open: q.open,
            prevClose: q.prevClose,
            volume: q.volume,
            amount: q.amount,
            prePrice: ext ? ext.prePrice : null,
            prePct: ext ? ext.prePct : null,
            afterPrice: ext ? ext.afterPrice : null,
            afterPct: ext ? ext.afterPct : null
        };
    }).catch(function (e) {
        throw new Error(friendly(e && e.message));
    });
}

/** 把用户输入猜成候选 secid（搜索接口不可用时兜底） */
function candidatesOf(input) {
    var s = String(input || '').trim().toUpperCase();
    if (!s) return [];
    if (/^\d{1,3}\.[A-Za-z0-9]+$/.test(s)) return [s];
    if (/^(KR|KS)\.?\d{6}$/.test(s)) return ['177.' + s.replace(/[^0-9]/g, '')];
    if (/^HK\.?\d{4,5}$/.test(s)) return ['116.' + s.replace(/[^0-9]/g, '')];
    if (/^\d{6}$/.test(s)) {
        return /^[569]/.test(s) ? ['1.' + s, '0.' + s] : ['0.' + s, '1.' + s];
    }
    if (/^\d{5}$/.test(s)) return ['116.' + s];
    if (/^[A-Z][A-Z.\-]{0,9}$/.test(s)) return ['105.' + s, '106.' + s, '107.' + s];
    return [];
}

function probeCandidates(input) {
    var list = candidatesOf(input);
    if (!list.length) {
        return Promise.reject(new Error('没找到这个标的，试试代码（如 NVDA / 513310 / 103.NQ00Y）'));
    }
    var i = 0;
    function next() {
        if (i >= list.length) {
            return Promise.reject(new Error('没找到「' + input + '」，请确认代码是否正确'));
        }
        var sec = list[i++];
        return fetchQuote(sec).then(function (q) {
            return {
                sec: sec,
                code: q.code,
                name: q.name,
                type: isUsSec(sec) ? '美股' : '行情',
                market: String(sec).split('.')[0]
            };
        }).catch(function (e) {
            if (isDomainError(e && e.message)) throw e;
            return next();
        });
    }
    return next();
}

/** 统一入口：先搜索，搜索域名被拦 / 没结果时退回本地代码解析 */
function resolveSymbol(kw) {
    var input = String(kw || '').trim();
    if (!input) return Promise.reject(new Error('请输入股票名称或代码'));
    return searchSymbol(input).then(function (list) {
        if (list && list.length) return list;
        return probeCandidates(input).then(function (hit) { return [hit]; });
    }).catch(function (e) {
        return probeCandidates(input).then(function (hit) {
            return [hit];
        }, function (e2) {
            if (isDomainError(e && e.message)) {
                throw new Error('搜索域名未加白名单，请直接输入完整代码（如 105.NVDA）');
            }
            throw new Error((e2 && e2.message) || friendly(e && e.message));
        });
    });
}

function offlineResult(detail) {
    return {
        quotes: snapshot.quotes,
        error: '',
        offline: true,
        offlineAt: snapshot.takenAt,
        detail: detail || '',
        fromCloud: false,
        time: new Date()
    };
}

function clockOf(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (!isFinite(d.getTime())) return String(iso).slice(0, 16);
    function p(n) {
        return n < 10 ? '0' + n : '' + n;
    }
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

var lastSaveAt = 0;
var SAVE_INTERVAL = 60000;

/** 给云端兜底加超时，避免云服务慢时界面卡在旧数据上 */
function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
        var done = false;
        var timer = setTimeout(function () {
            if (done) return;
            done = true;
            reject(new Error('cloud timeout'));
        }, ms);
        promise.then(function (v) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(v);
        }).catch(function (e) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            reject(e);
        });
    });
}

/** 联网失败时：先取云端快照，再退回内置快照 */
function fallback(detail) {
    return withTimeout(cloudData.loadSnapshot(), 1500).then(function (s) {
        if (s && s.ok && s.data && s.data.quotes) {
            return {
                quotes: s.data.quotes,
                error: '',
                offline: true,
                offlineAt: clockOf(s.data.capturedAt),
                detail: detail || '',
                fromCloud: true,
                time: new Date()
            };
        }
        return offlineResult(detail);
    }).catch(function () {
        return offlineResult(detail);
    });
}

/**
 * 并行拉取，任一源失败不影响另一源
 * 成功时顺手把快照写进云数据库；失败时优先读云端快照，再退回内置快照
 */
/** 网络层错误翻译成人话；东财对高频轮询会临时限流（连接成功但不返回数据） */
function friendlyNetErr(msg) {
    msg = String(msg || '');
    if (/EMPTY_RESPONSE|-324/.test(msg)) return '接口暂时无响应（可能触发限流，稍后自动恢复）';
    if (/timeout/i.test(msg)) return '请求超时';
    if (/fail/i.test(msg) && msg.length > 60) return '请求失败';
    return msg;
}

function fetchAll() {
    return Promise.all([
        fetchEastMoney().catch(function (e) {
            return { __error: e.message };
        }),
        fetchTencent().catch(function (e) {
            return { __error: e.message };
        }),
        fetchUsExt().catch(function () {
            return {};
        })
    ]).then(function (res) {
        var em = res[0] || {};
        var tx = res[1] || {};
        var usExt = res[2] || {};
        var quotes = {};
        var key;
        for (key in em) {
            if (key !== '__error') quotes[key] = em[key];
        }
        for (key in tx) {
            if (key !== '__error') quotes[key] = tx[key];
        }
        // 盘前盘后并入对应美股
        for (key in usExt) {
            if (quotes[key] && usExt[key]) {
                quotes[key].prePrice = usExt[key].prePrice;
                quotes[key].prePct = usExt[key].prePct;
                quotes[key].afterPrice = usExt[key].afterPrice;
                quotes[key].afterPct = usExt[key].afterPct;
            }
        }

        var parts = [];
        if (em.__error) parts.push('东财 ' + friendlyNetErr(em.__error));
        if (tx.__error) parts.push('腾讯 ' + friendlyNetErr(tx.__error));
        var detail = parts.join(' / ');
        // 托管预览等受限运行时会整体拦截外部请求（path not allowed），给出明确指引
        if (parts.length && detail.indexOf('path not allowed') >= 0) {
            detail += '。当前运行环境限制了外部网络请求（云端数据仍可读），实时行情请用微信开发者工具编译运行，或在真机上打开调试模式';
        }

        if (Object.keys(quotes).length < 3) {
            return fallback(detail);
        }

        // 成功后顺手写云端快照，60 秒最多一次，失败静默
        var now = Date.now();
        if (now - lastSaveAt > SAVE_INTERVAL) {
            lastSaveAt = now;
            cloudData.saveSnapshot(quotes).then(function () { }).catch(function () { });
        }

        return {
            quotes: quotes,
            error: '',
            offline: false,
            offlineAt: '',
            detail: detail,
            time: new Date()
        };
    }).catch(function (e) {
        return offlineResult((e && e.message) || '请求异常');
    });
}

// 分时走 push2（与行情同一个域名，少配一个白名单）
var TRENDS_URL = 'https://push2.eastmoney.com/api/qt/stock/trends2/get';
// 日K只有 push2his 有真实数据
var KLINE_URL = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';
// A股日K备用源（腾讯）
var TX_KLINE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';
// 东财涨停池/炸板池（ASFMM-A v2 情绪层真数据）
var ZT_URL = 'https://push2ex.eastmoney.com/getTopicZTPool';
var ZB_URL = 'https://push2ex.eastmoney.com/getTopicZBPool';
var ZT_UT = '7eea3edcaed734bea9cbfc24409ed989';

/** 需要加入 request 合法域名的完整清单 */
var DOMAINS = [
    { host: 'push2.eastmoney.com', label: '东方财富 · 实时行情 / 分时', probe: 'https://push2.eastmoney.com/api/qt/stock/get?invt=2&fltt=2&secid=1.000001&fields=f43' },
    { host: 'push2his.eastmoney.com', label: '东方财富 · 日K线', probe: 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.000001&klt=101&fqt=1&lmt=1&end=20500101&fields1=f1&fields2=f51,f53' },
    { host: 'push2ex.eastmoney.com', label: '东方财富 · 涨停/炸板池（情绪层）', probe: 'https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=1&sort=fbt%3Aasc&date=20260101' },
    { host: 'qt.gtimg.cn', label: '腾讯 · 韩股 / 三星', probe: 'https://qt.gtimg.cn/q=sh000001' },
    { host: 'web.ifzq.gtimg.cn', label: '腾讯 · A股日K备用', probe: 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh000001,day,,,1,qfq' },
    { host: 'searchapi.eastmoney.com', label: '东方财富 · 标的搜索（自选添加）', probe: 'https://searchapi.eastmoney.com/api/suggest/get?input=510300&type=14&count=1' },
    { host: 'mp-api.app.workbuddy.host', label: '云服务 · 快照与持仓', probe: 'https://mp-api.app.workbuddy.host/' }
];

/** 把系统级报错翻译成人能看懂的话 */
function friendly(msg) {
    var m = String(msg || '');
    if (/domain list/i.test(m) || /not in domain/i.test(m)) {
        return '域名未加入微信白名单';
    }
    if (/timeout/i.test(m)) return '请求超时';
    if (/ERR_|fail/i.test(m)) return '网络请求失败';
    return m || '请求失败';
}

function isDomainError(msg) {
    return /domain list/i.test(String(msg || ''));
}

/**
 * 涨停/炸板池（ASFMM-A v2 情绪层）：
 * 返回 { limitUp 涨停家数, broken 炸板家数, brokenRate 炸板率%, maxBoard 连板高度, ymd }
 * 口径：炸板率 = 炸板 / (涨停+炸板)，与 v2 datasource 的「曾涨停」分母一致
 * 失败时抛错，由调用方降级中性
 */
var _ztCache = { key: '', ts: 0, data: null };

function fetchZtZb(dateYmd) {
    var key = String(dateYmd || '');
    if (_ztCache.key === key && _ztCache.data && Date.now() - _ztCache.ts < 5 * 60 * 1000) {
        return Promise.resolve(_ztCache.data);
    }
    var qs = '?ut=' + ZT_UT + '&dpt=wz.ztzt&Pageindex=0&pagesize=600&sort=fbt%3Aasc&date=' + key;
    return Promise.all([
        req({ url: ZT_URL + qs }),
        req({ url: ZB_URL + qs })
    ]).then(function (rs) {
        var zt = rs[0] && rs[0].data;
        var zb = rs[1] && rs[1].data;
        if (!zt || !zt.tc) throw new Error('涨停池数据缺失');
        var limitUp = Number(zt.tc) || 0;
        var broken = (zb && Number(zb.tc)) || 0;
        var touch = limitUp + broken;
        var maxBoard = 0;
        var pool = zt.pool || [];
        for (var i = 0; i < pool.length; i++) {
            var lbc = Number(pool[i].lbc) || 0;
            if (lbc > maxBoard) maxBoard = lbc;
        }
        var out = {
            limitUp: limitUp,
            broken: broken,
            brokenRate: touch > 0 ? broken / touch * 100 : 30,
            maxBoard: Math.max(1, maxBoard || 1),
            ymd: key
        };
        _ztCache = { key: key, ts: Date.now(), data: out };
        return out;
    }).catch(function (e) {
        throw new Error(friendly(e && e.message));
    });
}

/** 腾讯代码：1.513310 -> sh513310，0.159995 -> sz159995 */
function toTxCode(sec) {
    var p = String(sec || '').split('.');
    if (p.length !== 2) return '';
    if (!/^\d{6}$/.test(p[1])) return '';
    if (p[0] === '1') return 'sh' + p[1];
    if (p[0] === '0') return 'sz' + p[1];
    return '';
}

/** 分时数据：[{ time, price, vol, avg }]，含 preClose */
function fetchTrends(sec) {
    var url = TRENDS_URL +
        '?secid=' + encodeURIComponent(sec) +
        '&iscr=1&fields1=f1,f2,f3,f7,f8&fields2=f51,f53,f56,f58';
    return req({ url: url }).then(function (payload) {
        var d = payload && payload.data;
        if (!d || !d.trends || !d.trends.length) {
            throw new Error('暂无分时数据');
        }
        var rows = [];
        for (var i = 0; i < d.trends.length; i++) {
            var p = d.trends[i].split(',');
            rows.push({
                time: p[0],
                price: Number(p[1]),
                vol: Number(p[2]),
                avg: Number(p[3])
            });
        }
        return {
            preClose: Number(d.preClose),
            rows: rows,
            name: d.name || ''
        };
    }).catch(function (e) {
        throw new Error(friendly(e && e.message));
    });
}

/** 腾讯美股日K（备用源）：secid '100.NDX' -> 'usNDX' */
var TX_US_KLINE_URL = 'https://web.ifzq.gtimg.cn/appstock/app/usfqkline/get';

function fetchKlineTxUs(sec, limit) {
    var p = String(sec || '').split('.');
    if (p.length !== 2 || p[0] !== '100' || !/^[A-Z.]{1,10}$/.test(p[1])) {
        return Promise.reject(new Error('该标的不支持美股备用源'));
    }
    var code = 'us' + p[1];
    var url = TX_US_KLINE_URL + '?param=' + code + ',day,,,' + (limit || 90) + ',qfq';
    return req({ url: url }).then(function (payload) {
        var d = payload && payload.data && payload.data[code];
        var arr = d && (d.qfqday || d.day || d[code]);
        if (!arr || !arr.length) throw new Error('暂无日K数据');
        var rows = [];
        for (var i = 0; i < arr.length; i++) {
            var p2 = arr[i];
            rows.push({
                date: p2[0],
                open: Number(p2[1]),
                close: Number(p2[2]),
                high: Number(p2[3]),
                low: Number(p2[4]),
                vol: Number(p2[5]) || 0,
                amount: 0
            });
        }
        return { name: '', rows: rows, source: '腾讯' };
    });
}

/** 腾讯日K（A股备用源） */
function fetchKlineTx(sec, limit) {
    var code = toTxCode(sec);
    if (!code) return Promise.reject(new Error('该标的不支持备用源'));
    var url = TX_KLINE_URL + '?param=' + code + ',day,,,' + (limit || 90) + ',qfq';
    return req({ url: url }).then(function (payload) {
        var d = payload && payload.data && payload.data[code];
        var arr = d && (d.qfqday || d.day || d[code]);
        if (!arr || !arr.length) throw new Error('暂无日K数据');
        var rows = [];
        for (var i = 0; i < arr.length; i++) {
            var p = arr[i];
            rows.push({
                date: p[0],
                open: Number(p[1]),
                close: Number(p[2]),
                high: Number(p[3]),
                low: Number(p[4]),
                vol: Number(p[5]),
                amount: 0
            });
        }
        return { name: '', rows: rows, source: '腾讯' };
    });
}

/** 日K：[{ date, open, close, high, low, vol, amount }] */
function fetchKline(sec, limit) {
    var url = KLINE_URL +
        '?secid=' + encodeURIComponent(sec) +
        '&klt=101&fqt=1&lmt=' + (limit || 90) +
        '&end=20500101&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57';
    return req({ url: url }).then(function (payload) {
        var d = payload && payload.data;
        if (!d || !d.klines || !d.klines.length) {
            throw new Error('暂无日K数据');
        }
        var rows = [];
        for (var i = 0; i < d.klines.length; i++) {
            var p = d.klines[i].split(',');
            rows.push({
                date: p[0],
                open: Number(p[1]),
                close: Number(p[2]),
                high: Number(p[3]),
                low: Number(p[4]),
                vol: Number(p[5]),
                amount: Number(p[6])
            });
        }
        return { name: d.name || '', rows: rows, source: '东财' };
    }).catch(function (e) {
        // 东财日K拿不到时，A股标的退到腾讯
        return fetchKlineTx(sec, limit).catch(function () {
            throw new Error(friendly(e && e.message));
        });
    });
}

/**
 * 通用K线拉取：klt 101=日K，5=5分钟
 * rows: [{ time, open, close, high, low, vol, amount }]，time 为 "YYYY-MM-DD HH:MM" 或日期
 * 三级降级：东财 -> 腾讯（仅日K，无成交额，用成交量代替，rows.amountMissing=true）
 *         -> 本地缓存（rows.stale=true，可能是旧数据）
 */
var BARS_CACHE_PREFIX = 'barscache_';

function saveBarsCache(key, rows) {
    try {
        wx.setStorageSync(BARS_CACHE_PREFIX + key, { ts: Date.now(), rows: rows.slice(-120) });
    } catch (e) { /* 存储满等，忽略 */ }
}

function loadBarsCache(key) {
    try {
        var hit = wx.getStorageSync(BARS_CACHE_PREFIX + key);
        return hit && hit.rows && hit.rows.length ? hit : null;
    } catch (e) {
        return null;
    }
}

function fetchBarsEm(sec, klt, lmt) {
    var url = KLINE_URL +
        '?secid=' + encodeURIComponent(sec) +
        '&klt=' + klt + '&fqt=0&lmt=' + (lmt || 60) +
        '&end=20500101&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57';
    return req({ url: url }).then(function (payload) {
        var d = payload && payload.data;
        if (!d || !d.klines || !d.klines.length) throw new Error('暂无K线数据');
        var rows = [];
        for (var i = 0; i < d.klines.length; i++) {
            var p = d.klines[i].split(',');
            rows.push({
                time: p[0],
                open: Number(p[1]),
                close: Number(p[2]),
                high: Number(p[3]),
                low: Number(p[4]),
                vol: Number(p[5]),
                amount: Number(p[6])
            });
        }
        return rows;
    });
}

function fetchBars(sec, klt, lmt) {
    var cacheKey = sec + '_' + klt;
    return fetchBarsEm(sec, klt, lmt).then(function (rows) {
        saveBarsCache(cacheKey, rows);
        return rows;
    }).catch(function (e) {
        var emMsg = friendly(e && e.message);
        // 降级1：腾讯日K（A股走 fqkline，美股指数走 usfqkline；腾讯不给A股历史成交额）
        if (Number(klt) === 101) {
            var txTry = toTxCode(sec)
                ? fetchKlineTx(sec, lmt || 60)
                : fetchKlineTxUs(sec, lmt || 60);
            return txTry.then(function (out) {
                var rows = [];
                for (var i = 0; i < out.rows.length; i++) {
                    var r = out.rows[i];
                    rows.push({
                        time: r.date,
                        open: r.open, close: r.close, high: r.high, low: r.low,
                        vol: r.vol,
                        amount: 0
                    });
                }
                rows.amountMissing = true;
                rows.source = '腾讯';
                saveBarsCache(cacheKey, rows);
                return rows;
            }).catch(function () {
                // 降级2：本地缓存（东财最近一次成功的数据）
                var hit = loadBarsCache(cacheKey);
                if (!hit) throw new Error(emMsg);
                var rows = hit.rows.slice(-(lmt || 60));
                rows.stale = true;
                rows.source = '缓存' + Math.round((Date.now() - hit.ts) / 3600000) + '小时前';
                return rows;
            });
        }
        // 非日K：只走缓存
        var hit = loadBarsCache(cacheKey);
        if (!hit) throw new Error(emMsg);
        var rows5 = hit.rows.slice(-(lmt || 60));
        rows5.stale = true;
        rows5.source = '缓存';
        return rows5;
    });
}

var SH_SEC = '1.000001';   // 沪市总额
var SZ_SEC = '0.399001';   // 深市总额

/**
 * 沪深两市量能对比：当日 vs 上一交易日的分时累计成交额（5分钟粒度）
 * 返回 { slots, today, prev, todayCount, todayTotal, prevTotal }
 * slots: ['09:35'...] 全天 48 个时点；today/prev 为对齐后的累计额数组（元），今日未到的时点为 null
 */
function fetchFlowCompare() {
    return Promise.all([
        fetchBars(SH_SEC, 5, 120),
        fetchBars(SZ_SEC, 5, 120)
    ]).then(function (res) {
        function byDay(rows) {
            var map = {};
            for (var i = 0; i < rows.length; i++) {
                var t = String(rows[i].time);
                var day = t.slice(0, 10);
                var hm = t.slice(11, 16);
                if (!map[day]) map[day] = [];
                map[day].push({ hm: hm, amount: rows[i].amount || 0 });
            }
            return map;
        }
        var shMap = byDay(res[0]);
        var szMap = byDay(res[1]);
        var days = Object.keys(shMap).sort();
        if (days.length < 2) throw new Error('分时量能数据不足');
        var d1 = days[days.length - 1]; // 最新交易日
        var d0 = days[days.length - 2]; // 上一交易日

        // 以昨日时点为基准轴（全天 48 个），今日按时间对齐
        var slots = [];
        var prevCum = [];
        var shP = shMap[d0] || [];
        var szP = szMap[d0] || [];
        var szByKey = {};
        for (var s = 0; s < szP.length; s++) szByKey[szP[s].hm] = szP[s].amount;
        var cum = 0;
        for (var p = 0; p < shP.length; p++) {
            var amt = (shP[p].amount || 0) + (szByKey[shP[p].hm] || 0);
            cum += amt;
            slots.push(shP[p].hm);
            prevCum.push(cum);
        }

        var shT = shMap[d1] || [];
        var szT = szMap[d1] || [];
        var szTByKey = {};
        for (var u = 0; u < szT.length; u++) szTByKey[szT[u].hm] = szT[u].amount;
        var todayCum = [];
        var tCum = 0;
        var tIdx = 0;
        var slotIndex = {};
        for (var v = 0; v < slots.length; v++) slotIndex[slots[v]] = v;
        for (var w = 0; w < shT.length; w++) {
            var amt2 = (shT[w].amount || 0) + (szTByKey[shT[w].hm] || 0);
            tCum += amt2;
            var idx = slotIndex[shT[w].hm];
            if (idx === undefined) continue;
            while (todayCum.length < idx) todayCum.push(null);
            todayCum[idx] = tCum;
            tIdx = Math.max(tIdx, idx);
        }
        // 今日未到的时点补 null，保持与 slots 等长
        while (todayCum.length < slots.length) todayCum.push(null);

        var prevTotal = prevCum.length ? prevCum[prevCum.length - 1] : 0;
        var todayTotal = tCum;
        var lastCommon = -1;
        for (var z = 0; z < todayCum.length; z++) {
            if (todayCum[z] !== null && prevCum[z] !== undefined) lastCommon = z;
        }

        return {
            slots: slots,
            prev: prevCum,
            today: todayCum,
            todayCount: tIdx + 1,
            todayTotal: todayTotal,
            prevTotal: prevTotal,
            todayDate: d1,
            prevDate: d0,
            // 同时刻对比：今日最新累计 / 昨日同一时点累计
            ratio: (lastCommon >= 0 && prevCum[lastCommon] > 0)
                ? todayCum[lastCommon] / prevCum[lastCommon]
                : null
        };
    });
}

/** 近 N 日沪深两市每日总成交额（含当日涨跌，用于柱状图着色） */
function fetchDailyFlow(limit) {
    return Promise.all([
        fetchBars(SH_SEC, 101, (limit || 60) + 8),
        fetchBars(SZ_SEC, 101, (limit || 60) + 8)
    ]).then(function (res) {
        var sh = res[0];
        var sz = res[1];
        var szByDay = {};
        for (var i = 0; i < sz.length; i++) {
            szByDay[String(sz[i].time).slice(0, 10)] = sz[i].amount || 0;
        }
        var out = [];
        for (var j = 0; j < sh.length; j++) {
            var day = String(sh[j].time).slice(0, 10);
            var prevClose = j > 0 ? sh[j - 1].close : sh[j].open;
            out.push({
                date: day,
                amount: (sh[j].amount || 0) + (szByDay[day] || 0),
                pct: prevClose > 0 ? (sh[j].close - prevClose) / prevClose * 100 : null
            });
        }
        return out.slice(-(limit || 60));
    });
}

/** 昨日（上一交易日）全天两市总成交额，首页量能卡用，缓存 5 分钟 */
var prevFlowCache = { at: 0, val: null };

function prevDayFlow() {
    return new Promise(function (resolve) {
        var now = Date.now();
        if (prevFlowCache.val && now - prevFlowCache.at < 300000) {
            resolve(prevFlowCache.val);
            return;
        }
        fetchDailyFlow(3).then(function (rows) {
            if (rows && rows.length >= 2) {
                var prev = rows[rows.length - 2];
                prevFlowCache = { at: now, val: { date: prev.date, total: prev.amount } };
            }
            resolve(prevFlowCache.val);
        }).catch(function () {
            resolve(prevFlowCache.val);
        });
    });
}

/**
 * 当前已完成的 5 分钟时段下标（0..47，对应 09:35 ~ 15:00 共 48 根）
 * 盘前返回 -1；午休返回 23（上午收盘）
 */
function slotIndexNow(now) {
    var t = now || new Date();
    var m = t.getHours() * 60 + t.getMinutes();
    if (m < 575) return -1;
    if (m <= 690) return Math.min(23, Math.floor((m - 570) / 5) - 1);
    if (m < 785) return 23;
    if (m <= 900) return Math.min(47, 24 + Math.floor((m - 780) / 5) - 1);
    return 47;
}

/** 分时累计基准（昨日各时点累计），首页量能卡同刻对比用，缓存 5 分钟 */
var flowBaseCache = { at: 0, val: null };
var flowBaseInflight = null;

function flowBase(force) {
    var now = Date.now();
    if (!force && flowBaseCache.val && now - flowBaseCache.at < 300000) {
        return Promise.resolve(flowBaseCache.val);
    }
    if (flowBaseInflight) return flowBaseInflight;
    flowBaseInflight = fetchFlowCompare().then(function (r) {
        flowBaseCache = { at: Date.now(), val: r };
        flowBaseInflight = null;
        return r;
    }, function (e) {
        flowBaseInflight = null;
        if (flowBaseCache.val) return flowBaseCache.val; // 失败回落旧基准
        throw e;
    });
    return flowBaseInflight;
}

/**
 * 逐个探测需要白名单的域名，用于设置页自检
 * 返回 [{ host, label, ok, status, detail }]
 */
function probeDomains() {
    var tasks = DOMAINS.map(function (d) {
        return new Promise(function (resolve) {
            var done = false;
            var started = Date.now();
            var finish = function (ok, detail) {
                if (done) return;
                done = true;
                resolve({
                    host: d.host,
                    label: d.label,
                    ok: ok,
                    ms: Date.now() - started,
                    detail: detail || ''
                });
            };
            wx.request({
                url: d.probe,
                method: 'GET',
                timeout: 6000,
                dataType: 'text',
                success: function (res) {
                    finish(true, 'HTTP ' + res.statusCode);
                },
                fail: function (err) {
                    var msg = (err && err.errMsg) || '';
                    finish(false, friendly(msg));
                }
            });
        });
    });
    return Promise.all(tasks);
}

module.exports = {
    fetchAll: fetchAll,
    fetchTrends: fetchTrends,
    fetchKline: fetchKline,
    fetchQuote: fetchQuote,
    searchSymbol: searchSymbol,
    resolveSymbol: resolveSymbol,
    setExtras: setExtras,
    fetchBars: fetchBars,
    fetchFlowCompare: fetchFlowCompare,
    fetchDailyFlow: fetchDailyFlow,
    prevDayFlow: prevDayFlow,
    fetchZtZb: fetchZtZb,
    flowBase: flowBase,
    slotIndexNow: slotIndexNow,
    probeDomains: probeDomains,
    isDomainError: isDomainError,
    friendly: friendly,
    DOMAINS: DOMAINS,
    EM_URL: EM_URL,
    TX_URL: TX_URL
};
