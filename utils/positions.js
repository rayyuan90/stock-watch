/**
 * 中金所每日持仓排名 → 股指期货净空单
 *
 * 两个数据源：
 * 1）云表 cffex_pos（HTTPS，走 mp-api.app.workbuddy.host，已加白名单/无需白名单）
 *    —— 微信只允许 https 合法域名，中金所官网只有 http，真机上常被拦，
 *       所以由云端定时同步好的数据作为主源。
 * 2）中金所官网 CSV（http）直连 —— 能通时优先用，最新最全。
 *
 * 中金所 CSV 是 GBK，小程序无 GBK 解码器：把字节按 latin1 读成字符串后，
 * 中文变乱码但字节序列不变，直接用「中信期货」的 GBK 字节序列做前缀匹配，
 * 数字列均为 ASCII 不受影响。
 */

var cloudData = require('./cloudData');

var PRODUCTS = [
    { key: 'IF', name: '沪深300' },
    { key: 'IH', name: '上证50' },
    { key: 'IC', name: '中证500' },
    { key: 'IM', name: '中证1000' }
];

// GBK 字节序列（latin1 直读后的形态）
var CITIC_FUT = '\xd6\xd0\xd0\xc5\xc6\xda\xbb\xf5';   // 中信期货
var CITIC_SEC = '\xd6\xd0\xd0\xc5\xd6\xa4\xc8\xaf';   // 中信证券（若自营席位上榜则一并计入）

var BASE = 'http://www.cffex.com.cn/sj/ccpm/';
var CACHE_KEY = 'kanpan:citPos';
var CACHE_MS = 10 * 60 * 1000;
var DAYS = 5;
var MAX_CAND = 12;

var _inflight = null;
var _bgRunning = false;
var _last = null;
var _onFresh = null;

function binToStr(buf) {
    var bytes = new Uint8Array(buf);
    var out = '';
    var CH = 8192;
    for (var i = 0; i < bytes.length; i += CH) {
        out += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CH, bytes.length)));
    }
    return out;
}

function toNum(s) {
    var n = parseInt(String(s).replace(/[^\d-]/g, ''), 10);
    return isNaN(n) ? 0 : n;
}

function labelOf(ymd) {
    return ymd.slice(4, 6) + '-' + ymd.slice(6, 8);
}

/** 解析单品种当日 CSV：把该品种全部合约的买卖持仓分别累加 */
function parseCsv(bin) {
    var lines = binToStr(bin).split('\n');
    var r = { date: '', citicBuy: 0, citicSell: 0, topBuy: 0, topSell: 0, rows: 0 };
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].replace(/\r/g, '');
        if (!line) continue;
        var f = line.split(',');
        // 数据行：交易日,合约,排名,买简称,买单量,增减,卖简称,卖单量,增减...（前两行是中文表头）
        if (f.length < 11 || !/^\d{8}$/.test(f[0])) continue;
        if (!r.date) r.date = f[0];
        var buyVol = toNum(f[7]);
        var sellVol = toNum(f[10]);
        var buyName = f[6] || '';
        var sellName = f[9] || '';
        r.topBuy += buyVol;
        r.topSell += sellVol;
        if (isCitic(buyName)) r.citicBuy += buyVol;
        if (isCitic(sellName)) r.citicSell += sellVol;
        r.rows++;
    }
    return r;
}

function isCitic(name) {
    return name.indexOf(CITIC_FUT) === 0 || name.indexOf(CITIC_SEC) === 0;
}

function reqCsv(product, ymd) {
    return new Promise(function (resolve) {
        wx.request({
            url: BASE + ymd.slice(0, 6) + '/' + ymd.slice(6, 8) + '/' + product + '_1.csv',
            responseType: 'arraybuffer',
            timeout: 8000,
            success: function (res) {
                if (res.statusCode === 200 && res.data && res.data.byteLength > 100) {
                    var p = parseCsv(res.data);
                    // 校验文件里的交易日与请求日一致：
                    // 当日未发布时中金所可能返回旧文件或空壳，避免把旧数据当成今天
                    resolve(p.rows >= 20 && p.date === ymd ? p : null);
                } else {
                    resolve(null); // 302 = 非交易日 / 当日未发布
                }
            },
            fail: function () { resolve(null); }
        });
    });
}

function pad(n) { return n < 10 ? '0' + n : '' + n; }

/** 从今天往前找工作日候选（节假日会被请求失败自然剔除） */
function candDates(max) {
    var out = [];
    var d = new Date();
    var guard = 0;
    while (out.length < max && guard++ < 30) {
        var day = d.getDay();
        if (day !== 0 && day !== 6) {
            out.push('' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()));
        }
        d.setDate(d.getDate() - 1);
    }
    return out;
}

/** 逐候选日抓取，直到凑满近 5 个有数据的交易日；连续 2 天全军覆没视为直连被拦，提前放弃 */
function collect() {
    var dates = candDates(MAX_CAND);
    var days = [];
    var idx = 0;
    var missStreak = 0;

    function step() {
        while (idx < dates.length && days.length < DAYS) {
            if (missStreak >= 2) return Promise.resolve(days);
            var ymd = dates[idx++];
            var reqs = PRODUCTS.map(function (p) {
                return reqCsv(p.key, ymd).then(function (r) {
                    return { key: p.key, r: r };
                });
            });
            return Promise.all(reqs).then(function (list) {
                var data = {};
                var ok = 0;
                list.forEach(function (it) {
                    if (it.r) {
                        ok++;
                        data[it.key] = {
                            citic: it.r.citicSell - it.r.citicBuy,
                            top20: it.r.topSell - it.r.topBuy
                        };
                    }
                });
                if (ok) {
                    days.push({ ymd: ymd, label: labelOf(ymd), data: data });
                    missStreak = 0;
                } else {
                    missStreak++;
                }
                if (days.length >= DAYS || idx >= dates.length || missStreak >= 2) return days;
                return step();
            });
        }
        return Promise.resolve(days);
    }

    return step();
}

/** 补 ALL（四品种汇总）并按日期升序 */
function finishDays(days) {
    days.forEach(function (d) {
        var c = 0;
        var t = 0;
        PRODUCTS.forEach(function (p) {
            var v = d.data[p.key];
            if (v) {
                c += v.citic;
                t += v.top20;
            }
        });
        d.data.ALL = { citic: c, top20: t };
        if (!d.label) d.label = labelOf(d.ymd);
    });
    days.sort(function (a, b) { return a.ymd < b.ymd ? -1 : 1; });
    return days.slice(-DAYS);
}

function withTimeout(p, ms, fallback) {
    return new Promise(function (resolve) {
        var done = false;
        var timer = setTimeout(function () {
            if (done) return;
            done = true;
            resolve(fallback);
        }, ms);
        p.then(function (v) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(v);
        }, function () {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(fallback);
        });
    });
}

/** 云端 cffex_pos → 与直连同构的 days 数组 */
function loadCloudDays() {
    if (!cloudData.available) return Promise.resolve([]);
    return withTimeout(cloudData.loadCffexPos().then(function (res) {
        if (!res || !res.ok || !res.data || !res.data.length) return [];
        var map = {};
        var order = [];
        res.data.forEach(function (row) {
            var ymd = String(row.ymd || '');
            if (!ymd) return;
            if (!map[ymd]) {
                map[ymd] = { ymd: ymd, label: labelOf(ymd), data: {} };
                order.push(ymd);
            }
            map[ymd].data[String(row.product)] = {
                citic: Number(row.citic) || 0,
                top20: Number(row.top20) || 0
            };
        });
        order.sort();
        return finishDays(order.map(function (k) { return map[k]; }));
    }), 8000, []);
}

/** 合并两组 days：live 覆盖 cloud 同一天 */
function mergeDays(base, live) {
    var map = {};
    var keys = [];
    (base || []).concat(live || []).forEach(function (d) {
        if (!map[d.ymd]) {
            map[d.ymd] = { ymd: d.ymd, label: d.label || labelOf(d.ymd), data: {} };
            keys.push(d.ymd);
        }
        var t = map[d.ymd];
        for (var k in d.data) {
            if (d.data.hasOwnProperty(k)) t.data[k] = d.data[k];
        }
    });
    keys.sort();
    return finishDays(keys.map(function (k) { return map[k]; }));
}

function readCache() {
    try {
        var raw = wx.getStorageSync(CACHE_KEY);
        if (raw && raw.days && raw.days.length) return raw;
    } catch (e) { /* ignore */ }
    return null;
}

function writeCache(val) {
    try { wx.setStorageSync(CACHE_KEY, val); } catch (e) { /* ignore */ }
}

/** 后台静默直连刷新（云端已给足数据时用），成功后通知页面重绘 */
function refreshInBackground() {
    if (_bgRunning) return;
    _bgRunning = true;
    collect().then(function (liveDays) {
        _bgRunning = false;
        if (!liveDays.length || !_last) return;
        var merged = mergeDays(_last.days, liveDays);
        var res = { fetchedAt: Date.now(), days: merged, source: 'live' };
        _last = res;
        writeCache(res);
        if (_onFresh) {
            try { _onFresh(res); } catch (e) { /* ignore */ }
        }
    }, function () {
        _bgRunning = false;
    });
}

/**
 * 返回 Promise：{ fetchedAt, days:[{ymd,label,data:{IF:{citic,top20},...,ALL}}], source }
 * 先读云端（快、https 不受限），云端不足 5 天再直连中金所补齐。
 */
function load(force) {
    if (!force && _last && Date.now() - _last.fetchedAt < CACHE_MS) {
        return Promise.resolve(_last);
    }
    if (!force) {
        var cached = readCache();
        if (cached && Date.now() - cached.fetchedAt < CACHE_MS) {
            _last = cached;
            return Promise.resolve(cached);
        }
    }
    if (_inflight) return _inflight;

    _inflight = loadCloudDays().then(function (cloudDays) {
        // 云端已够 5 天：立即给结果（force 也一样，云端就是最新口径），再后台试直连拿最新
        if (cloudDays.length >= DAYS) {
            var quick = { fetchedAt: Date.now(), days: cloudDays, source: 'cloud' };
            _last = quick;
            writeCache(quick);
            _inflight = null;
            refreshInBackground();
            return quick;
        }
        return collect().then(function (liveDays) {
            _inflight = null;
            if (liveDays.length) {
                var merged = mergeDays(cloudDays, liveDays);
                var live = { fetchedAt: Date.now(), days: merged, source: 'live' };
                _last = live;
                writeCache(live);
                return live;
            }
            if (cloudDays.length) {
                var fallback = { fetchedAt: Date.now(), days: cloudDays, source: 'cloud' };
                _last = fallback;
                writeCache(fallback);
                return fallback;
            }
            throw new Error('净空单数据暂未获取到，请稍后重试');
        });
    }).catch(function (e) {
        _inflight = null;
        if (_last && _last.days && _last.days.length) return _last;
        var cached = readCache();
        if (cached) {
            _last = cached;
            return cached;
        }
        throw e;
    });
    return _inflight;
}

function onFresh(fn) {
    _onFresh = fn;
}

module.exports = {
    PRODUCTS: PRODUCTS,
    load: load,
    onFresh: onFresh,
    parseCsv: parseCsv
};
