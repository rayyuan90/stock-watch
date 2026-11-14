/**
 * 云数据访问层
 * - quote_snapshot：公开表，存最近一次成功的行情快照，任何设备都能读，用来兜底
 * - portfolio / futures_daily：按账号隔离，需登录后才会写入
 *
 * 所有函数都以 { ok, data, error } 形式返回，永不抛到页面上。
 */
var cloudMod = require('./cloud');

var SNAPSHOT_ID = 1;
var cloud = cloudMod.cloud;

function unavailable() {
    return Promise.resolve({ ok: false, data: null, error: cloudMod.initError || '云服务未就绪' });
}

function toNum(v) {
    if (v === '' || v === null || v === undefined) return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
}

/** SDK 的错误可能是 Error、{code,message} 或字符串，统一压成可读文案 */
function pickError(res) {
    var err = res && res.error;
    if (!err) return '';
    if (typeof err === 'string') return err;
    var msg = err.message || (err.error && err.error.message) || err.msg || err.code;
    if (msg) return String(msg);
    try {
        return JSON.stringify(err);
    } catch (e) {
        return '云端请求失败';
    }
}

/** 当前登录态；未登录返回 null，不抛错 */
function getSession() {
    if (!cloud) return Promise.resolve(null);
    return cloud.auth.getSession().then(function (res) {
        if (res && res.error) return null;
        return (res && res.data) || null;
    }).catch(function () {
        return null;
    });
}

/** 写入行情快照（覆盖 id=1） */
function saveSnapshot(quotes, capturedAt) {
    if (!cloud) return unavailable();
    var count = 0;
    var key;
    for (key in quotes) {
        if (quotes.hasOwnProperty(key)) count++;
    }
    if (count < 3) return Promise.resolve({ ok: false, data: null, error: '数据过少，不写快照' });

    return cloud.database.from('quote_snapshot').upsert({
        id: SNAPSHOT_ID,
        payload: quotes,
        market_count: count,
        captured_at: capturedAt || new Date().toISOString()
    }).then(function (res) {
        return { ok: !pickError(res), data: null, error: pickError(res) };
    }).catch(function (e) {
        return { ok: false, data: null, error: (e && e.message) || '写入快照失败' };
    });
}

/** 读取行情快照 */
function loadSnapshot() {
    if (!cloud) return unavailable();
    return cloud.database.from('quote_snapshot')
        .select('payload, captured_at, market_count')
        .eq('id', SNAPSHOT_ID)
        .maybeSingle()
        .then(function (res) {
            var err = pickError(res);
            if (err) return { ok: false, data: null, error: err };
            var row = res && res.data;
            if (!row || !row.payload) return { ok: false, data: null, error: '云端暂无快照' };
            return {
                ok: true,
                data: {
                    quotes: row.payload,
                    capturedAt: row.captured_at,
                    count: row.market_count
                },
                error: ''
            };
        })
        .catch(function (e) {
            return { ok: false, data: null, error: (e && e.message) || '读取快照失败' };
        });
}

/** 读取当前账号的持仓配置 */
function loadPortfolio() {
    if (!cloud) return unavailable();
    return cloud.database.from('portfolio')
        .select('cost_513310, shares_513310, cost_159995, shares_159995, updated_at')
        .limit(1)
        .then(function (res) {
            var err = pickError(res);
            if (err) return { ok: false, data: null, error: err };
            var row = res && res.data && res.data[0];
            return { ok: true, data: row || null, error: '' };
        })
        .catch(function (e) {
            return { ok: false, data: null, error: (e && e.message) || '读取持仓失败' };
        });
}

/** 保存持仓配置（有则更新，无则新建；owner_id 由数据库填充） */
function savePortfolio(cfg) {
    if (!cloud) return unavailable();
    var row = {
        cost_513310: toNum(cfg.cost513310),
        shares_513310: toNum(cfg.shares513310),
        cost_159995: toNum(cfg.cost159995),
        shares_159995: toNum(cfg.shares159995),
        updated_at: new Date().toISOString()
    };
    return cloud.database.from('portfolio').select('id').limit(1).then(function (res) {
        var err = pickError(res);
        if (err) return { ok: false, data: null, error: err };
        var existing = res && res.data && res.data[0];
        var q = existing
            ? cloud.database.from('portfolio').update(row).eq('id', existing.id).select()
            : cloud.database.from('portfolio').insert(row).select();
        return q.then(function (r2) {
            var e2 = pickError(r2);
            if (e2) return { ok: false, data: null, error: e2 };
            var affected = r2 && r2.data;
            if (Array.isArray(affected) && affected.length === 0) {
                return { ok: false, data: null, error: '没有写入权限，请先登录' };
            }
            return { ok: true, data: null, error: '' };
        });
    }).catch(function (e) {
        return { ok: false, data: null, error: (e && e.message) || '保存持仓失败' };
    });
}

/** 读取最近的多空记录（按日期倒序） */
function loadFuturesHistory(limit) {
    if (!cloud) return unavailable();
    return cloud.database.from('futures_daily')
        .select('trade_date, net_short, total_oi')
        .order('trade_date', { ascending: false })
        .limit(limit || 30)
        .then(function (res) {
            var err = pickError(res);
            if (err) return { ok: false, data: null, error: err };
            return { ok: true, data: (res && res.data) || [], error: '' };
        })
        .catch(function (e) {
            return { ok: false, data: null, error: (e && e.message) || '读取多空记录失败' };
        });
}

/** 写入某日的多空数据（同一天覆盖） */
function saveFuturesDay(date, netShort, totalOi) {
    if (!cloud) return unavailable();
    var row = {
        trade_date: date,
        net_short: Math.round(Number(netShort)),
        total_oi: totalOi === null || totalOi === undefined || totalOi === ''
            ? null
            : Math.round(Number(totalOi))
    };
    return cloud.database.from('futures_daily')
        .select('id')
        .eq('trade_date', date)
        .limit(1)
        .then(function (res) {
            var err = pickError(res);
            if (err) return { ok: false, data: null, error: err };
            var existing = res && res.data && res.data[0];
            var q = existing
                ? cloud.database.from('futures_daily').update(row).eq('id', existing.id).select()
                : cloud.database.from('futures_daily').insert(row).select();
            return q.then(function (r2) {
                var e2 = pickError(r2);
                if (e2) return { ok: false, data: null, error: e2 };
                var affected = r2 && r2.data;
                if (Array.isArray(affected) && affected.length === 0) {
                    return { ok: false, data: null, error: '没有写入权限，请先登录' };
                }
                return { ok: true, data: null, error: '' };
            });
        })
        .catch(function (e) {
            return { ok: false, data: null, error: (e && e.message) || '保存多空记录失败' };
        });
}

/** 读取云端自选（每个账号一行） */
function loadWatchlist() {
    if (!cloud) return unavailable();
    return cloud.database.from('watchlist')
        .select('items, updated_at')
        .limit(1)
        .then(function (res) {
            var err = pickError(res);
            if (err) return { ok: false, data: null, error: err };
            var row = res && res.data && res.data[0];
            if (!row) return { ok: true, data: null, error: '' };
            return {
                ok: true,
                data: {
                    items: Array.isArray(row.items) ? row.items : [],
                    updatedAt: row.updated_at || ''
                },
                error: ''
            };
        })
        .catch(function (e) {
            return { ok: false, data: null, error: (e && e.message) || '读取云端自选失败' };
        });
}

/** 保存云端自选（整表覆盖；owner_id 由数据库按登录态填充） */
function saveWatchlist(items) {
    if (!cloud) return unavailable();
    var arr = Array.isArray(items) ? items : [];
    var row = { items: arr, updated_at: new Date().toISOString() };
    return cloud.database.from('watchlist').select('id').limit(1).then(function (res) {
        var err = pickError(res);
        if (err) return { ok: false, data: null, error: err };
        var existing = res && res.data && res.data[0];
        var q = existing
            ? cloud.database.from('watchlist').update(row).eq('id', existing.id).select()
            : cloud.database.from('watchlist').insert(row).select();
        return q.then(function (r2) {
            var e2 = pickError(r2);
            if (e2) return { ok: false, data: null, error: e2 };
            var affected = r2 && r2.data;
            if (Array.isArray(affected) && affected.length === 0) {
                return { ok: false, data: null, error: '没有写入权限，请先登录' };
            }
            return { ok: true, data: null, error: '' };
        });
    }).catch(function (e) {
        return { ok: false, data: null, error: (e && e.message) || '保存自选失败' };
    });
}

/** 读取云端中金所持仓排名（公开表，任何设备可读；小程序端只读不写） */
function loadCffexPos() {
    if (!cloud) return unavailable();
    return cloud.database.from('cffex_pos')
        .select('ymd, product, citic, top20')
        .order('ymd', { ascending: false })
        .limit(60)
        .then(function (res) {
            var err = pickError(res);
            if (err) return { ok: false, data: null, error: err };
            return { ok: true, data: (res && res.data) || [], error: '' };
        })
        .catch(function (e) {
            return { ok: false, data: null, error: (e && e.message) || '读取净空单失败' };
        });
}

/** 读取云端美股盘前盘后（公开表 us_ext，云端定时同步自新浪） */
function loadUsExt() {
    if (!cloud) return unavailable();
    return cloud.database.from('us_ext')
        .select('secid, code, pre_price, pre_pct, pre_ts, after_price, after_pct, after_ts, updated_at')
        .limit(50)
        .then(function (res) {
            var err = pickError(res);
            if (err) return { ok: false, data: null, error: err };
            return { ok: true, data: (res && res.data) || [], error: '' };
        })
        .catch(function (e) {
            return { ok: false, data: null, error: (e && e.message) || '读取盘前盘后失败' };
        });
}

/** 读取云端多空博弈预测历史（公开表 bgame_pred，跨设备留存） */
function loadBgamePred(limit) {
    if (!cloud) return unavailable();
    return cloud.database.from('bgame_pred')
        .select('ymd, model, pred, lo, hi, m, quad, actual_pct')
        .order('ymd', { ascending: false })
        .limit(limit || 200)
        .then(function (res) {
            var err = pickError(res);
            if (err) return { ok: false, data: null, error: err };
            return { ok: true, data: (res && res.data) || [], error: '' };
        })
        .catch(function (e) {
            return { ok: false, data: null, error: (e && e.message) || '读取预测历史失败' };
        });
}

/** 写入一条预测记录（ymd+model 唯一，存在则更新） */
function saveBgamePred(row) {
    if (!cloud) return unavailable();
    var data = {
        ymd: row.ymd,
        model: row.model,
        pred: toNum(row.pred),
        lo: toNum(row.lo),
        hi: toNum(row.hi),
        m: toNum(row.m),
        quad: row.quad || '',
        actual_pct: row.actual_pct === undefined || row.actual_pct === null ? null : toNum(row.actual_pct),
        updated_at: new Date().toISOString()
    };
    // 注意：bgame_pred 没有 id 列，主键是 (ymd, model)，所以判重/更新都只能用业务键
    return cloud.database.from('bgame_pred')
        .select('ymd')
        .eq('ymd', row.ymd)
        .eq('model', row.model)
        .limit(1)
        .then(function (res) {
            var err = pickError(res);
            if (err) return { ok: false, data: null, error: err };
            var existing = res && res.data && res.data[0];
            var q = existing
                ? cloud.database.from('bgame_pred').update(data)
                    .eq('ymd', row.ymd).eq('model', row.model).select()
                : cloud.database.from('bgame_pred').insert(data).select();
            return q.then(function (r2) {
                var e2 = pickError(r2);
                if (e2) return { ok: false, data: null, error: e2 };
                return { ok: true, data: null, error: '' };
            });
        })
        .catch(function (e) {
            return { ok: false, data: null, error: (e && e.message) || '保存预测记录失败' };
        });
}

/** 读取云端次日倾向复盘历史（公开表 sig_hist，跨设备/跨版本留存） */
function loadSigHist() {
    if (!cloud) return unavailable();
    return cloud.database.from('sig_hist')
        .select('ymd, score, close, open_pct, real, breadth')
        .order('ymd', { ascending: false })
        .limit(150)
        .then(function (res) {
            var err = pickError(res);
            if (err) return { ok: false, data: null, error: err };
            return { ok: true, data: (res && res.data) || [], error: '' };
        })
        .catch(function (e) {
            return { ok: false, data: null, error: (e && e.message) || '读取次日倾向历史失败' };
        });
}

/** 写入一条次日倾向复盘记录（ymd 唯一，存在则合并更新） */
function saveSigHist(row) {
    if (!cloud) return unavailable();
    var data = {
        ymd: row.ymd,
        score: row.score === null || row.score === undefined ? null : Math.round(Number(row.score)),
        close: toNum(row.close),
        open_pct: toNum(row.openPct),
        real: toNum(row.real),
        breadth: row.breadth || '',
        updated_at: new Date().toISOString()
    };
    // sig_hist 同样没有 id 列，主键是 ymd
    return cloud.database.from('sig_hist')
        .select('ymd')
        .eq('ymd', row.ymd)
        .limit(1)
        .then(function (res) {
            var err = pickError(res);
            if (err) return { ok: false, data: null, error: err };
            var existing = res && res.data && res.data[0];
            var q = existing
                ? cloud.database.from('sig_hist').update(data).eq('ymd', row.ymd).select()
                : cloud.database.from('sig_hist').insert(data).select();
            return q.then(function (r2) {
                var e2 = pickError(r2);
                if (e2) return { ok: false, data: null, error: e2 };
                return { ok: true, data: null, error: '' };
            });
        })
        .catch(function (e) {
            return { ok: false, data: null, error: (e && e.message) || '保存次日倾向记录失败' };
        });
}

/** 读取云端每日模型输入（公开表 a_input_ext，收盘后自动化任务写入两融/大单/ETF/情绪等慢变量） */
function loadAInputExt() {
    if (!cloud) return unavailable();
    return cloud.database.from('a_input_ext')
        .select('ymd, d_margin, margin_pct_rank, big_order_net, big_order_net_rank, north_net_rank, etf_sub_rank, etf_net_subscribe, limit_up_cnt, max_board, broken_rate, up_ratio_rank, amt_yi, unlock_5d_yi, unlock_5d_rank, reduce_20d_yi, reduce_amt_rank, margin_force_rank, profit_float_rank, quality, policy_json, updated_at')
        .order('ymd', { ascending: false })
        .limit(5)
        .then(function (res) {
            var err = pickError(res);
            if (err) return { ok: false, data: null, error: err };
            return { ok: true, data: (res && res.data) || [], error: '' };
        })
        .catch(function (e) {
            return { ok: false, data: null, error: (e && e.message) || '读取每日模型输入失败' };
        });
}

/** 读取本地数据仓的云端副本（整包快照，兜底用） */
function loadVaultBackup() {
    if (!cloud) return unavailable();
    return cloud.database.from('vault_backup')
        .select('payload, row_cnt, saved_at')
        .eq('id', 1)
        .maybeSingle()
        .then(function (res) {
            var err = pickError(res);
            if (err) return { ok: false, data: null, error: err };
            var row = res && res.data;
            if (!row || !row.payload) return { ok: false, data: null, error: '云端暂无备份' };
            return {
                ok: true,
                data: {
                    payload: row.payload,
                    rows: row.row_cnt || 0,
                    savedAt: row.saved_at || ''
                },
                error: ''
            };
        })
        .catch(function (e) {
            return { ok: false, data: null, error: (e && e.message) || '读取云端备份失败' };
        });
}

/** 写入本地数据仓的云端副本（整包快照，id 固定 1） */
function saveVaultBackup(snap) {
    if (!cloud) return unavailable();
    if (!snap || !snap.keys) return Promise.resolve({ ok: false, data: null, error: '无内容' });
    return cloud.database.from('vault_backup').upsert({
        id: 1,
        payload: snap.keys,
        row_cnt: snap.rows || 0,
        saved_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    }).then(function (res) {
        return { ok: !pickError(res), data: null, error: pickError(res) };
    }).catch(function (e) {
        return { ok: false, data: null, error: (e && e.message) || '写入云端备份失败' };
    });
}

function signIn() {    if (!cloud) return Promise.reject(new Error(cloudMod.initError || '云服务未就绪'));
    return cloud.auth.signInWithWorkBuddyMiniProgram({ redirectPath: 'pages/index/index' });
}

function signOut() {
    if (!cloud) return Promise.resolve();
    return cloud.auth.signOut();
}

module.exports = {
    available: cloudMod.available,
    initError: cloudMod.initError,
    getSession: getSession,
    saveSnapshot: saveSnapshot,
    loadSnapshot: loadSnapshot,
    loadPortfolio: loadPortfolio,
    savePortfolio: savePortfolio,
    loadFuturesHistory: loadFuturesHistory,
    saveFuturesDay: saveFuturesDay,
    loadWatchlist: loadWatchlist,
    saveWatchlist: saveWatchlist,
    loadCffexPos: loadCffexPos,
    loadUsExt: loadUsExt,
    loadBgamePred: loadBgamePred,
    saveBgamePred: saveBgamePred,
    loadSigHist: loadSigHist,
    saveSigHist: saveSigHist,
    loadVaultBackup: loadVaultBackup,
    saveVaultBackup: saveVaultBackup,
    loadAInputExt: loadAInputExt,
    signIn: signIn,
    signOut: signOut
};
