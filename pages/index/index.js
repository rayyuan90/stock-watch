var market = require('../../utils/market');
var fmt = require('../../utils/format');
var signalModel = require('../../utils/signal');
var snapshot = require('../../utils/snapshot');
var cloudData = require('../../utils/cloudData');
var watch = require('../../utils/watch');
var sighist = require('../../utils/sighist');
var positions = require('../../utils/positions');
var watchSync = require('../../utils/watchSync');
var bgame = require('../../utils/bgame');
var bgHist = require('../../utils/bgHist');
var verify = require('../../utils/verify');

/** 把模型读数转成界面字段（条形、配色、文案） */
function quadClsOf(quad) {
    if (quad.indexOf('Q1') === 0) return 'bg-q1';
    if (quad.indexOf('Q2') === 0) return 'bg-q2';
    if (quad.indexOf('Q3') === 0) return 'bg-q3';
    return 'bg-q4';
}

function predClsOf(pred) {
    if (pred > 0.08) return 'up';
    if (pred < -0.08) return 'down';
    return 'flat';
}

function regimeClsOf(state) {
    if (state === 'STARVE') return 'starve';
    if (state === 'PULSE') return 'pulse';
    if (state === 'SUSTAIN') return 'sustain';
    if (state === 'DUMP') return 'dump';
    return 'neutral';
}

function decorateAGame(a) {
    a.quadCls = quadClsOf(a.quad);
    a.predCls = predClsOf(a.pred);
    a.regimeCls = regimeClsOf(a.regime && a.regime.state);
    a.gateCls = (a.gate && a.gate.cls) || 'bad';
    a.amtText = (a.regime && a.regime.amountText) || '';
    a.ma20Text = (a.regime && a.regime.ma20Text) || '';
    a.rMaText = a.regime ? a.regime.rMa.toFixed(2) + '×均量' : '';
    a.rPrevText = a.regime ? '较前日 ' + a.regime.rPrev.toFixed(2) + '×' : '';
    a.mPct = Math.max(0, Math.min(100, a.M));
    a.mCls = a.M >= 55 ? 'up' : (a.M <= 45 ? 'down' : 'flat');
    a.M = Math.round(a.M * 10) / 10; // 界面展示保留一位小数
    a.bars = [
        { label: 'P 仓位空间', pct: Math.max(0, Math.min(100, a.P)), text: a.P.toFixed(1), note: '燃料余量(非空头)·量能分位 ' + a.amtRank.toFixed(0) },
        { label: 'R 流入强度', pct: Math.max(0, Math.min(100, a.R)), text: a.R.toFixed(1), note: 'EMA平滑·仅参考' },
        { label: 'BIG 大资金', pct: Math.max(0, Math.min(100, a.BIG)), text: a.BIG.toFixed(1) },
        { label: 'A 加速度', pct: Math.max(0, Math.min(100, 50 + a.A * 17)), text: a.A.toFixed(2) },
        { label: 'E 情绪温度', pct: a.E, text: a.E.toFixed(1) + (a.eReal ? '（涨停池）' : '（中性）') },
        { label: 'G 卖压再生', pct: a.G, text: a.G.toFixed(1) + '（中性）' }
    ];
    return a;
}

function decorateUsGame(u) {
    u.quadCls = quadClsOf(u.quad);
    u.predCls = predClsOf(u.pred);
    u.mPct = Math.max(0, Math.min(100, 50 + u.M * 2));
    u.mCls = u.M >= 4 ? 'up' : (u.M <= -4 ? 'down' : 'flat');
    u.tText = isFinite(u.T) ? u.T.toFixed(1) + '天' : '∞';
    u.bars = [
        { label: 'F 空头燃料', pct: u.F, text: u.F.toFixed(1) + '%' },
        { label: 'R 燃烧速度', pct: Math.max(0, Math.min(100, u.R * 4)), text: u.R.toFixed(2) + '%/日' },
        { label: 'A 加速度', pct: Math.max(0, Math.min(100, 50 + u.A * 8)), text: u.A.toFixed(2) },
        { label: 'T 续航', pct: isFinite(u.T) ? Math.min(100, u.T * 10) : 100, text: u.tText },
        { label: 'G 空头再生', pct: u.G / 3 * 100, text: u.G.toFixed(2) + '/3' }
    ];
    return u;
}

var CONFIG_KEY = 'kanpan:config';
var HISTORY_KEY = 'kanpan:posHistory';
var REFRESH_MS = 3000;

var DEFAULT_CONFIG = {
    cost513310: '',
    shares513310: '',
    cost159995: '',
    shares159995: '',
    posNetShort: '',
    posTotalOi: '',
    posDate: ''
};

function priceText(q) {
    if (!q || !fmt.isNum(q.price)) return '--';
    if (q.digits === 0) return fmt.group(q.price);
    return fmt.fixed(q.price, q.digits);
}

function quoteRow(q, fallbackName, fallbackCode) {
    var name = (q && q.name) || fallbackName;
    var code = (q && q.code) || fallbackCode;
    var pct = q && fmt.isNum(q.pct) ? Number(q.pct) : null;
    var meta = q && fmt.isNum(q.amount) && q.amount > 0
        ? '成交 ' + fmt.amount(q.amount)
        : '';
    return {
        name: name,
        code: code,
        sec: (q && q.sec) || '',
        subText: meta ? code + ' · ' + meta : code,
        priceText: priceText(q),
        pctText: pct === null ? '--' : fmt.pct(pct),
        cls: fmt.cls(pct),
        meta: meta,
        preText: '',
        preCls: '',
        afterText: '',
        afterCls: ''
    };
}

/** 美股行：正常时段涨跌 + 盘前 + 盘后三个数字并排（盘前/盘后未开盘时显示占位） */
function usRow(q, fallbackName, fallbackCode) {
    var row = quoteRow(q, fallbackName, fallbackCode);
    row.hasExt = true;
    if (q && fmt.isNum(q.prePct)) {
        row.preText = '盘前 ' + fmt.pct(q.prePct);
        row.preCls = fmt.cls(q.prePct);
    } else {
        row.preText = '盘前 待开';
        row.preCls = 'flat';
    }
    if (q && fmt.isNum(q.afterPct)) {
        row.afterText = '盘后 ' + fmt.pct(q.afterPct);
        row.afterCls = fmt.cls(q.afterPct);
    } else {
        row.afterText = '盘后 待开';
        row.afterCls = 'flat';
    }
    return row;
}

function koreaRow(q, name, code) {
    var pct = q && fmt.isNum(q.pct) ? Number(q.pct) : null;
    var priceStr = '--';
    if (q && fmt.isNum(q.price)) {
        priceStr = q.price >= 100000
            ? (q.price / 10000).toFixed(1) + '万'
            : fmt.group(q.price);
    }
    return {
        name: name,
        code: code + ' · 韩元',
        sec: (q && q.sec) || '',
        subText: code + ' · 韩元',
        priceText: priceStr,
        pctText: pct === null ? '--' : fmt.pct(pct),
        cls: fmt.cls(pct),
        meta: ''
    };
}

/** 自选行：按市场选样式，美股带盘前盘后，韩股用万为单位 */
function watchRow(q, it) {
    var sec = it.sec || '';
    var mkt = sec.split('.')[0];
    var row;
    if (mkt === '177') {
        row = koreaRow(q, it.name, it.code);
    } else if (mkt === '105' || mkt === '106' || mkt === '107') {
        row = usRow(q, it.name, it.code);
    } else {
        row = quoteRow(q, it.name, it.code);
    }
    row.sec = sec;
    row.rawSec = sec;
    row.subText = it.code + (it.type ? ' · ' + it.type : '');
    row.pos = null;
    return row;
}

function marketState(now) {
    var day = now.getDay();
    if (day === 0 || day === 6) return { text: '休市', live: false };
    var m = now.getHours() * 60 + now.getMinutes();
    if (m < 570) return { text: '盘前', live: false };
    if (m <= 690) return { text: '交易中', live: true };
    if (m < 780) return { text: '午间休市', live: false };
    if (m <= 900) return { text: '交易中', live: true };
    return { text: '已收盘', live: false };
}

/** A股交易时间进度（9:30-11:30 / 13:00-15:00，剔除午休），0-100 */
function timeProgressPct(now) {
    var m = now.getHours() * 60 + now.getMinutes();
    if (m <= 570) return 0;
    var el = Math.min(m, 690) - 570;
    if (m > 780) el += Math.min(m, 900) - 780;
    if (m > 900) el = 240;
    return Math.max(0, Math.min(100, el / 240 * 100));
}

Page({
    data: {
        loading: true,
        error: '',
        offline: false,
        offlineAt: '',
        detailText: '',
        previewMode: false,
        domainBlocked: false,
        domainText: '',
        updatedAt: '--:--:--',
        statusText: '连接中',
        live: false,
        hero: null,
        holdings: [],
        korea: [],
        us: [],
        aShare: [],
        futures: [],
        watchList: [],
        watchCount: 0,
        watchMax: watch.MAX,
        watchSyncLabel: '仅本机',
        aFlow: null,
        posTab: 'ALL',
        posProducts: positions.PRODUCTS.concat([{ key: 'ALL', name: '四品种汇总' }]),
        posDate: '',
        posSource: '',
        posErr: '',
        posLoading: false,
        posPick: null,
        sigHistRows: [],
        sigStats: { total: 0, hit: 0, pctText: '--' },
        signalData: null,
        longShort: null,
        aGame: null,
        usGame: null,
        aGameState: '计算中…',
        usGameState: '计算中…',
        bgAccTab: 'a',
        bgAccStats: null,
        bgAccPick: null,
        bgAccState: '',
        verifyPanel: null,
        cloudUser: '',
        cloudLabel: '未登录云账号',
        config: DEFAULT_CONFIG
    },

    onLoad: function () {
        var saved = wx.getStorageSync(CONFIG_KEY);
        var cfg = {};
        var key;
        for (key in DEFAULT_CONFIG) cfg[key] = DEFAULT_CONFIG[key];
        if (saved && typeof saved === 'object') {
            for (key in cfg) {
                if (saved[key] !== undefined && saved[key] !== null) cfg[key] = saved[key];
            }
        }
        this.config = cfg;
        this.setData({ config: cfg });
        this.loadPrevPos();
        this.syncWatch();
        this.ensureFlowBase();
        // 次日倾向历史云端合并：换设备/重新发布后本地被清也能找回全部记录
        var selfHist = this;
        sighist.sync().then(function () {
            selfHist.updateSigHist();
        });
        this.updateSigHist();
        this.loadPositions();
        this.loadBGames();
        this.loadBgAcc();
        // 先用内置快照铺满界面，避免白屏或整屏 "--"
        this.render(snapshot.quotes, new Date(), '', true, snapshot.takenAt, '');
        this.start();
        this.hydrateFromCloud();
        this.syncWatchCloud();
    },

    /** 昨日各时点累计量能基准（缓存 5 分钟，供量能卡同刻对比） */
    ensureFlowBase: function () {
        var self = this;
        if (this._flowBaseAsked) return;
        this._flowBaseAsked = true;
        market.flowBase().then(function (v) {
            self._flowBase = v;
            var last = self._lastRes;
            if (last) {
                self.render(last.quotes, new Date(), last.error, last.offline, last.offlineAt, last.detail);
            }
        }).catch(function () { }).then(function () {
            // 跨日后基准要换，5 分钟后再取一次
            if (self._flowTimer) clearTimeout(self._flowTimer);
            self._flowTimer = setTimeout(function () {
                self._flowBaseAsked = false;
                self.ensureFlowBase();
            }, 5 * 60 * 1000);
        });
    },

    /** 自选标的并入批量行情请求 */
    syncWatch: function () {
        var list = watch.load();
        market.setExtras(watch.secs());
        this.setData({
            watchCount: list.length,
            watchSyncLabel: watchSync.statusText()
        });
        return list;
    },

    /** 登录后把云端自选拉回来合并（换设备也能看到） */
    syncWatchCloud: function () {
        var self = this;
        if (!cloudData.available) return;
        var authReady = getApp().authReady || Promise.resolve({ data: null });
        authReady.then(function () {
            return watchSync.sync();
        }).then(function (res) {
            self.setData({
                watchSyncLabel: res && res.reason === 'nologin' ? '仅本机' : watchSync.statusText()
            });
            if (res && res.changed) {
                self.syncWatch();
                self.refresh();
            }
        }).catch(function () { /* 同步失败不影响本地使用 */ });
    },

    onShowWatchSync: function () {
        this.setData({ watchSyncLabel: watchSync.statusText() });
    },

    /** 点自选卡上的同步标签：手动推/拉一次 */
    onWatchSyncTap: function () {
        var self = this;
        if (!cloudData.available) {
            wx.showToast({ title: '云服务未就绪', icon: 'none' });
            return;
        }
        wx.showLoading({ title: '同步中', mask: true });
        watchSync.sync().then(function (res) {
            wx.hideLoading();
            self.setData({
                watchSyncLabel: res && res.reason === 'nologin' ? '仅本机' : watchSync.statusText()
            });
            if (res.reason === 'nologin') {
                wx.showModal({
                    title: '还没登录云账号',
                    content: '自选目前只存在这台手机上。登录 WorkBuddy 账号后，换设备也能看到同一份自选。',
                    confirmText: '去登录',
                    success: function (r) {
                        if (r.confirm) wx.navigateTo({ url: '/pages/setup/setup' });
                    }
                });
                return;
            }
            if (!res.ok) {
                wx.showToast({ title: res.error || '同步失败，稍后自动重试', icon: 'none', duration: 2000 });
                return;
            }
            if (res.changed) {
                self.syncWatch();
                self.refresh();
            }
            wx.showToast({ title: '已同步 · 共 ' + watch.load().length + ' 个', icon: 'none', duration: 1200 });
        }).catch(function () {
            wx.hideLoading();
            wx.showToast({ title: '同步失败', icon: 'none' });
        });
    },

    /** 登录后把云端的持仓与多空记录拉回来覆盖本地 */
    hydrateFromCloud: function () {
        var self = this;
        if (!cloudData.available) {
            this.setData({ cloudLabel: '云服务未就绪' });
            return;
        }
        var authReady = getApp().authReady || Promise.resolve({ data: null });
        authReady.then(function () {
            return cloudData.getSession();
        }).then(function (session) {
            if (!session) {
                self.setData({ cloudUser: '', cloudLabel: '未登录云账号 · 数据仅存本机' });
                return null;
            }
            var name = (session.user && session.user.name) || '已登录';
            self.setData({ cloudUser: name, cloudLabel: '云同步 · ' + name });
            return cloudData.loadPortfolio().then(function (p) {
                if (p.ok && p.data) {
                    var cfg = self.config;
                    if (p.data.cost_513310 !== null) cfg.cost513310 = String(p.data.cost_513310);
                    if (p.data.shares_513310 !== null) cfg.shares513310 = String(p.data.shares_513310);
                    if (p.data.cost_159995 !== null) cfg.cost159995 = String(p.data.cost_159995);
                    if (p.data.shares_159995 !== null) cfg.shares159995 = String(p.data.shares_159995);
                    self.config = cfg;
                    self.setData({ config: cfg });
                }
                return cloudData.loadFuturesHistory(30);
            }).then(function (h) {
                if (!h.ok || !h.data || !h.data.length) return;
                self.cloudHistory = h.data;
                var latest = h.data[0];
                if (latest && latest.net_short !== null) {
                    var cfg2 = self.config;
                    cfg2.posNetShort = String(latest.net_short);
                    if (latest.total_oi !== null) cfg2.posTotalOi = String(latest.total_oi);
                    cfg2.posDate = String(latest.trade_date).slice(0, 10);
                    self.config = cfg2;
                    self.setData({ config: cfg2 });
                    self.loadPrevPosFromHistory(h.data);
                }
                self.refresh();
            });
        }).catch(function () {
            self.setData({ cloudLabel: '云端连接失败 · 数据存本机' });
        });
    },

    loadPrevPosFromHistory: function (rows) {
        if (!rows || !rows.length) return;
        var today = fmt.dayText(new Date());
        for (var i = 0; i < rows.length; i++) {
            var d = String(rows[i].trade_date).slice(0, 10);
            if (d !== today && rows[i].net_short !== null) {
                this.prevPos = { netShort: Number(rows[i].net_short) };
                return;
            }
        }
    },

    loadPrevPos: function () {
        var list = wx.getStorageSync(HISTORY_KEY);
        if (!Array.isArray(list) || list.length === 0) {
            this.prevPos = null;
            return;
        }
        var today = fmt.dayText(new Date());
        for (var i = list.length - 1; i >= 0; i--) {
            var item = list[i];
            if (item && item.date && item.date !== today && isFinite(Number(item.netShort))) {
                this.prevPos = { netShort: Number(item.netShort) };
                return;
            }
        }
        this.prevPos = null;
    },

    onShow: function () {
        if (!this.config) return;
        // 从「添加自选」返回后，自选可能有增删，重新并进行情请求
        this.syncWatch();
        // 有个把小时没同步过就顺手拉一次云端（换设备后能看到最新自选）
        if (!this._lastCloudSync || Date.now() - this._lastCloudSync > 5 * 60 * 1000) {
            this._lastCloudSync = Date.now();
            this.syncWatchCloud();
        }
        if (this._stopped) {
            this.start();
        } else {
            this.refresh();
        }
    },

    onHide: function () {
        this.stop();
    },

    onUnload: function () {
        this.stop();
        if (this._flowTimer) {
            clearTimeout(this._flowTimer);
            this._flowTimer = null;
        }
        if (this._bgTimer) {
            clearTimeout(this._bgTimer);
            this._bgTimer = null;
        }
    },

    onPullDownRefresh: function () {
        var self = this;
        this.loadPositions(true);
        this.refresh().then(function () {
            wx.stopPullDownRefresh();
            if (self.data.offline) {
                wx.showToast({ title: '刷新失败，仍是离线数据', icon: 'none', duration: 2000 });
            } else {
                wx.showToast({ title: '已刷新', icon: 'none', duration: 900 });
            }
        }).catch(function () {
            wx.stopPullDownRefresh();
            wx.showToast({ title: '刷新失败', icon: 'none' });
        });
    },

    copyDomains: function () {
        if (!this.data.domainText) return;
        wx.setClipboardData({
            data: this.data.domainText,
            success: function () {
                wx.showToast({ title: '域名已复制', icon: 'none' });
            }
        });
    },

    start: function () {
        var self = this;
        this._stopped = false;
        if (this._timer) return;
        this._tick = function () {
            if (self._stopped) return;
            self.refresh().then(function (res) {
                if (self._stopped) return;
                // 有数据源报错（如东财限流）时放慢到 30 秒，给对方解封时间；
                // 限流期间仍 3 秒一打只会延长封禁
                var slow = res && res.detail && String(res.detail).length > 0;
                self._timer = setTimeout(self._tick, slow ? REFRESH_MS * 10 : REFRESH_MS);
            }).catch(function () {
                if (self._stopped) return;
                self._timer = setTimeout(self._tick, REFRESH_MS * 10);
            });
        };
        this._tick();
    },

    stop: function () {
        this._stopped = true;
        if (this._timer) {
            clearTimeout(this._timer);
            this._timer = null;
        }
    },

    refresh: function () {
        var self = this;
        if (this._inflight) return this._inflight;
        this._inflight = market.fetchAll().then(function (res) {
            self._inflight = null;
            self._lastRes = res;
            self.render(res.quotes, res.time, res.error, res.offline, res.offlineAt, res.detail);
            return res;
        }).catch(function (err) {
            self._inflight = null;
            var msg = (err && err.message) || '请求异常';
            self.setData({
                loading: false,
                offline: true,
                offlineAt: snapshot.takenAt,
                detailText: msg,
                domainBlocked: market.isDomainError(msg),
                domainText: market.isDomainError(msg)
                    ? market.DOMAINS.map(function (d) { return 'https://' + d.host; }).join('\n')
                    : '',
                statusText: '连接异常',
                live: false
            });
            throw err;
        });
        return this._inflight;
    },

    render: function (quotes, time, error, offline, offlineAt, detail) {
        var q = quotes || {};
        var cfg = this.config || DEFAULT_CONFIG;

        var etf = q['1.513310'];
        var chip = q['0.159995'];
        var sem = q['1.512480'];
        var cxmt = q['1.688825'];
        var sh = q['1.000001'];
        var cyb = q['0.399006'];
        var hs300 = q['1.000300'];
        var zz500 = q['1.000905'];
        var zz1000 = q['1.000852'];
        var sz50 = q['1.000016'];
        var ndx = q['100.NDX'];
        var kospi = q['100.KS11'];
        var soxx = q['105.SOXX'];
        var nvda = q['105.NVDA'];
        var skUS = q['105.SKHY'];
        var mu = q['105.MU'];
        var sk = q['tx.kr000660'];
        var samsung = q['tx.kr005930'];

        var futDefs = [
            { key: '8.040130', label: 'IF', desc: '沪深300', spot: hs300 },
            { key: '8.060130', label: 'IC', desc: '中证500', spot: zz500 },
            { key: '8.070130', label: 'IH', desc: '上证50', spot: sz50 },
            { key: '8.150130', label: 'IM', desc: '中证1000', spot: zz1000 },
            { key: '103.NQ00Y', label: 'NQ', desc: '纳指期货', spot: null }
        ];

        var futures = [];
        var futRelSum = 0;
        var futRelCount = 0;
        for (var i = 0; i < futDefs.length; i++) {
            var def = futDefs[i];
            var f = q[def.key];
            var spot = def.spot;
            var basis = null;
            var basisPct = null;
            if (f && spot && fmt.isNum(f.price) && fmt.isNum(spot.price) && spot.price > 0) {
                basis = f.price - spot.price;
                basisPct = (basis / spot.price) * 100;
                if (fmt.isNum(f.pct) && fmt.isNum(spot.pct)) {
                    futRelSum += (Number(f.pct) - Number(spot.pct));
                    futRelCount++;
                }
            }
            futures.push({
                label: def.label,
                desc: def.desc,
                sec: def.key,
                priceText: priceText(f),
                pctText: f && fmt.isNum(f.pct) ? fmt.pct(f.pct) : '--',
                cls: fmt.cls(f && f.pct),
                basisText: basis === null
                    ? '--'
                    : (basis <= 0 ? '贴水 ' : '升水 ') + fmt.fixed(Math.abs(basis), 1) + ' 点',
                basisCls: basis === null ? 'flat' : basis < 0 ? 'down' : 'up',
                volText: f && fmt.isNum(f.volume) ? fmt.group(f.volume) + ' 手' : ''
            });
        }

        var futRel = futRelCount > 0 ? futRelSum / futRelCount : 0;

        var posNet = Number(cfg.posNetShort);
        var posOi = Number(cfg.posTotalOi);
        var hasPos = cfg.posNetShort !== '' && isFinite(posNet);
        var netShortRatio = null;
        if (hasPos && isFinite(posOi) && posOi > 0) {
            netShortRatio = posNet / posOi;
        }

        var sig = signalModel.buildSignal({
            skPct: sk ? sk.pct : 0,
            samsungPct: samsung ? samsung.pct : 0,
            soxPct: soxx ? soxx.pct : 0,
            nvdaPct: nvda ? nvda.pct : 0,
            futRel: futRel,
            etfPct: etf ? etf.pct : 0,
            chipPct: chip ? chip.pct : 0,
            netShortRatio: netShortRatio
        });
        // 跨市场信号 × A股模型（ASFMM-A）汇总：模型未就绪时退化为仅跨市场
        this._lastSig = sig;
        var sigFuse = signalModel.buildFuse(sig, this._aGameCore);

        var longShort = signalModel.buildLongShort(
            hasPos ? { netShort: posNet, totalOi: posOi, date: cfg.posDate } : null,
            this.prevPos
        );
        if (longShort && longShort.has) {
            longShort.netText = (longShort.net > 0 ? '+' : '') + fmt.group(longShort.net);
            longShort.diffText = longShort.diff === null
                ? ''
                : (longShort.diff > 0 ? '+' : '') + fmt.group(longShort.diff) + ' 手';
            longShort.totalText = longShort.totalOi ? fmt.group(longShort.totalOi) + ' 手' : '未填';
        }

        var hero = null;
        if (etf) {
            var heroPos = signalModel.buildPosition(etf, cfg.cost513310, cfg.shares513310);
            hero = {
                name: '中韩半导体ETF',
                fullName: '华泰柏瑞 · 中证中韩半导体',
                code: '513310',
                sec: '1.513310',
                priceText: priceText(etf),
                pctText: fmt.isNum(etf.pct) ? fmt.pct(etf.pct) : '--',
                changeText: fmt.isNum(etf.change)
                    ? (Number(etf.change) > 0 ? '+' : '') + fmt.fixed(etf.change, etf.digits)
                    : '--',
                cls: fmt.cls(etf.pct),
                highText: fmt.fixed(etf.high, etf.digits),
                lowText: fmt.fixed(etf.low, etf.digits),
                amountText: fmt.amount(etf.amount),
                premiumText: fmt.isNum(etf.premium) ? fmt.pct(etf.premium) : '--',
                premiumCls: fmt.cls(etf.premium),
                pos: heroPos
                    ? {
                        shares: fmt.group(heroPos.shares),
                        cost: fmt.fixed(heroPos.cost, 3),
                        valueText: fmt.amount(heroPos.marketValue),
                        profitText: (heroPos.profit > 0 ? '+' : '') + fmt.fixed(heroPos.profit, 0),
                        profitPctText: fmt.pct(heroPos.profitPct),
                        todayText: (heroPos.todayProfit > 0 ? '+' : '') + fmt.fixed(heroPos.todayProfit, 0),
                        cls: heroPos.cls
                    }
                    : null
            };
        }

        var chipPos = signalModel.buildPosition(chip, cfg.cost159995, cfg.shares159995);

        var holdings = [{
            name: '长鑫科技',
            code: '688825',
            sec: '1.688825',
            subText: '688825 · 存储主线 DRAM',
            priceText: priceText(cxmt),
            pctText: cxmt && fmt.isNum(cxmt.pct) ? fmt.pct(cxmt.pct) : '--',
            cls: fmt.cls(cxmt && cxmt.pct),
            meta: cxmt && fmt.isNum(cxmt.amount) ? '成交 ' + fmt.amount(cxmt.amount) : '',
            pos: null
        }, {
            name: '芯片ETF华夏',
            code: '159995',
            sec: '0.159995',
            subText: '159995 · 算力主线',
            priceText: priceText(chip),
            pctText: chip && fmt.isNum(chip.pct) ? fmt.pct(chip.pct) : '--',
            cls: fmt.cls(chip && chip.pct),
            meta: chip && fmt.isNum(chip.amount) ? '成交 ' + fmt.amount(chip.amount) : '',
            pos: chipPos
                ? {
                    profitText: (chipPos.profit > 0 ? '+' : '') + fmt.fixed(chipPos.profit, 0),
                    profitPctText: fmt.pct(chipPos.profitPct),
                    cls: chipPos.cls
                }
                : null
        }, {
            name: '半导体ETF国联安',
            code: '512480',
            sec: '1.512480',
            subText: '512480 · 半导体广度',
            priceText: priceText(sem),
            pctText: sem && fmt.isNum(sem.pct) ? fmt.pct(sem.pct) : '--',
            cls: fmt.cls(sem && sem.pct),
            meta: sem && fmt.isNum(sem.amount) ? '成交 ' + fmt.amount(sem.amount) : '',
            pos: null
        }];

        // 自选：手动添加的股票 / ETF / 期货
        var watchSrc = watch.load();
        var watchRows = [];
        for (var wi = 0; wi < watchSrc.length; wi++) {
            watchRows.push(watchRow(q[watchSrc[wi].sec], watchSrc[wi]));
        }

        // A 股量能：沪市(1.000001) + 深市(0.399001) 实时总额 vs 昨日同一时段累计
        var szm = q['0.399001'];
        var aFlow = null;
        if (sh && fmt.isNum(sh.amount) && szm && fmt.isNum(szm.amount)) {
            var todayAmt = sh.amount + szm.amount;
            var base = this._flowBase;
            var tp = timeProgressPct(time);
            var weekend = time.getDay() === 0 || time.getDay() === 6;
            var slot = market.slotIndexNow(time);
            var baseAmt = null;    // 参与同刻比值的基准
            var baseShow = null;   // 卡片上展示的基准值
            var baseLabel = '昨同刻';
            if (base) {
                if (weekend) {
                    // 休市日成交额停在上一交易日，改与更前一日全天比较
                    baseAmt = base.prevTotal > 0 ? base.prevTotal : null;
                    baseShow = baseAmt;
                    baseLabel = '上一交易日全天';
                } else if (slot >= 0 && base.prev && base.prev[slot] != null) {
                    baseAmt = base.prev[slot];
                    baseShow = baseAmt;
                } else if (slot < 0) {
                    // 盘前还没有同刻可比，先给昨日全天做参考
                    baseShow = base.prevTotal > 0 ? base.prevTotal : null;
                    baseLabel = '昨日全天';
                }
            }
            var baseDate = base ? String(base.prevDate || '').slice(5, 10) : '';
            var ratio = (baseAmt && baseAmt > 0) ? todayAmt / baseAmt : null;
            aFlow = {
                todayText: fmt.amount(todayAmt),
                baseLabel: baseLabel + (baseDate ? ' ' + baseDate : ''),
                baseText: baseShow ? fmt.amount(baseShow) : (base ? '--' : '…'),
                ratioText: ratio === null ? '--' : fmt.pct((ratio - 1) * 100),
                ratioCls: fmt.cls(ratio === null ? null : ratio - 1),
                barPct: ratio === null ? 0 : Math.min(100, ratio * 100),
                hot: ratio !== null && ratio >= 1,
                timeMark: tp,
                timeText: tp.toFixed(0) + '%',
                note: ratio === null
                    ? (base
                        ? (weekend ? '休市 · 暂无可比时段' : '开盘后开始与昨日同一时段对比')
                        : '昨日同时段量能获取中…')
                    : ('同刻量能 ' + (ratio * 100).toFixed(0) + '% · 时间进度 ' + tp.toFixed(0) +
                        '%（竖线为当前时点）' + (ratio >= 1 ? ' · 放量' : ' · 缩量'))
            };
        }

        var state = marketState(time);
        var blocked = market.isDomainError(detail) || market.isDomainError(error);
        // 明日实操验证面板：依赖实时行情 + 同刻量比基准，20 秒节流
        this.updateVerify(q, time);
        // 托管预览/H5 沙箱只允许 /cloud/ 请求，外部行情请求被整体拦截；
        // 这属于运行环境限制而非故障，提示文案要区分开，不吓人
        var sandboxed = String(detail || '').indexOf('path not allowed') >= 0;

        this.setData({
            loading: false,
            error: error || '',
            offline: !!offline,
            offlineAt: offlineAt || '',
            detailText: sandboxed ? '' : (detail || ''),
            previewMode: sandboxed,
            domainBlocked: blocked,
            domainText: blocked
                ? market.DOMAINS.map(function (d) { return 'https://' + d.host; }).join('\n')
                : '',
            offlineSub: offline
                ? (sandboxed
                    ? ('当前是托管预览环境，只允许云端请求，行情取自 ' + (offlineAt || '云端') +
                        ' 的云端快照；手机上打开调试或开发者工具中为实时数据，界面可直接看效果。')
                    : ('没能连通行情接口，当前显示 ' + (offlineAt || '') + ' 的备份数据' +
                        (detail ? '（' + detail + '）' : '') + '，网络恢复后自动切回实时。'))
                : '',
            updatedAt: fmt.clock(time),
            statusText: state.text,
            live: state.live,
            hero: hero,
            holdings: holdings,
            korea: [
                koreaRow(sk, 'SK海力士', '000660.KS'),
                koreaRow(samsung, '三星电子', '005930.KS'),
                quoteRow(kospi, '韩国KOSPI', 'KS11')
            ],
            us: [
                usRow(skUS, 'SK海力士(美股)', 'SKHY'),
                usRow(mu, '美光科技', 'MU'),
                usRow(soxx ? { name: '半导体ETF SOXX', code: 'SOXX', price: soxx.price, pct: soxx.pct, amount: soxx.amount, digits: soxx.digits, sec: soxx.sec } : null, '半导体ETF SOXX', 'SOXX'),
                usRow(nvda, '英伟达', 'NVDA'),
                usRow(ndx, '纳斯达克', 'NDX')
            ],
            aShare: [
                quoteRow(sh, '上证指数', '000001'),
                quoteRow(cyb, '创业板指', '399006'),
                quoteRow(hs300, '沪深300', '000300'),
                quoteRow(zz1000, '中证1000', '000852')
            ],
            futures: futures,
            watchList: watchRows,
            watchCount: watchRows.length,
            aFlow: aFlow,
            signalData: sig,
            sigFuse: sigFuse,
            longShort: longShort
        });

        this.recordSigHist(sig, etf, time, offline, q);
    },

    /**
     * 次日倾向复盘记录（科技板块口径）：
     * - 15:00 A股收盘后，把「跨市场×A股模型」汇总分记为「今日预测」
     * - 次日 9:35 后，用科技板块一篮子标的（中韩半导体/芯片/半导体ETF + 长鑫科技）
     *   开盘跳空的等权平均补「真实值」
     *   （仍以中韩半导体 ETF 记录的收盘价校验 prevClose，避免节假日拿旧开盘误配）
     */
    recordSigHist: function (sig, etf, time, offline, quotes) {
        if (!sig || offline || !etf) return;
        var day = time.getDay();
        if (day === 0 || day === 6) return;
        var m = time.getHours() * 60 + time.getMinutes();
        var today = fmt.dayText(time);
        var changed = false;
        var list = null;

        // 预测分 = 跨市场信号 × A股模型 汇总（模型未就绪时退化为纯跨市场分）
        var fuse = signalModel.buildFuse(sig, this._aGameCore);
        var scoreForRecord = fuse ? fuse.score : sig.score;

        // 真实值 = 科技板块一篮子开盘跳空等权平均（有多少算多少）
        var techGaps = [];
        var techN = 0;
        for (var ti = 0; ti < sighist.TECH_SECS.length; ti++) {
            var tq = quotes && quotes[sighist.TECH_SECS[ti]];
            if (tq && fmt.isNum(tq.open) && fmt.isNum(tq.prevClose) && tq.prevClose > 0) {
                techGaps.push((tq.open - tq.prevClose) / tq.prevClose * 100);
                techN++;
            }
        }
        var breadth = techN + '/' + sighist.TECH_SECS.length;

        if (m >= 900) {
            list = sighist.load();
            var rec = sighist.find(list, today);
            if (!rec || rec.score === null || rec.score === undefined) {
                list = sighist.recordScore(today, scoreForRecord, fmt.isNum(etf.price) ? etf.price : null, breadth);
                changed = true;
            }
        }

        if (m >= 575) {
            list = list || sighist.load();
            var pending = sighist.pendingReal(list, today);
            if (pending && techN > 0 &&
                fmt.isNum(etf.open) && fmt.isNum(etf.prevClose) && etf.prevClose > 0 &&
                pending.close !== null && pending.close !== undefined && pending.close > 0 &&
                Math.abs(etf.prevClose - pending.close) <= pending.close * 0.002) {
                var sum = 0;
                for (var gi = 0; gi < techGaps.length; gi++) sum += techGaps[gi];
                var openPct = sum / techN;
                list = sighist.fillReal(pending.date, openPct, breadth);
                changed = true;
            }
        }

        if (changed) this.updateSigHist();
    },

    /** 信号卡上的命中摘要与逐日列表（新→旧，最多 20 条） */
    updateSigHist: function () {
        var list = sighist.load();
        var rows = [];
        for (var i = list.length - 1; i >= 0 && rows.length < 20; i--) {
            var it = list[i];
            var hit = null;
            if (fmt.isNum(it.openPct) && Math.abs(it.score) >= 10) {
                hit = (it.score > 0 && it.openPct > 0) || (it.score < 0 && it.openPct < 0);
            }
            rows.push({
                date: String(it.date).slice(5, 10),
                scoreText: (it.score > 0 ? '+' : '') + it.score,
                scoreCls: it.score > 0 ? 'up' : it.score < 0 ? 'down' : 'flat',
                openText: fmt.isNum(it.openPct) ? fmt.pct(it.openPct) : '待开盘',
                openCls: fmt.isNum(it.openPct) ? fmt.cls(it.openPct) : 'flat',
                hitText: hit === null ? '—' : (hit ? '命中' : '偏离'),
                hitCls: hit === null ? 'flat' : (hit ? 'ok' : 'bad')
            });
        }
        this.setData({ sigHistRows: rows, sigStats: sighist.stats(list) });
    },

    goDetail: function (e) {
        var sec = e.currentTarget.dataset.sec;
        var name = e.currentTarget.dataset.name || '';
        if (!sec) return;
        wx.navigateTo({
            url: '/pages/detail/detail?sec=' + encodeURIComponent(sec) + '&name=' + encodeURIComponent(name)
        });
    },

    goAdd: function () {
        wx.navigateTo({ url: '/pages/add/add' });
    },

    goVolume: function () {
        wx.navigateTo({ url: '/pages/volume/volume' });
    },

    /* ---------- 净空单（中信 vs 前20席位） ---------- */

    loadPositions: function (force) {
        var self = this;
        // 后台直连到最新数据时，页面要跟着重绘
        if (!this._posFreshBound) {
            this._posFreshBound = true;
            positions.onFresh(function (res) {
                if (!self.data || !self.data.posTab) return;
                self.applyPos(res);
            });
        }
        if (this._posLoading) return;
        this._posLoading = true;
        this.setData({ posLoading: true, posErr: '' });
        positions.load(!!force).then(function (res) {
            self._posLoading = false;
            self.applyPos(res);
        }).catch(function (e) {
            self._posLoading = false;
            self.setData({
                posLoading: false,
                posErr: (e && e.message) || '净空单数据获取失败'
            });
        });
    },

    /** 统一的净空单渲染入口（云端首屏 / 直连刷新都走这里） */
    applyPos: function (res) {
        this._posData = (res && res.days) || [];
        this._posHover = null;
        var last = this._posData.length ? this._posData[this._posData.length - 1] : null;
        var pick = null;
        if (last && last.data[this.data.posTab]) pick = this.makePosPick(last);
        this.setData({
            posLoading: false,
            posErr: '',
            posDate: last ? last.label : '',
            posPick: pick,
            posSource: res && res.source === 'live' ? '实时抓取' : (res && res.source === 'cloud' ? '云端同步' : '')
        });
        this.drawPos();
    },

    retryPos: function () {
        this.loadPositions(true);
    },

    /** 明日实操验证：模型底牌 vs 盘面实时量价（模型结论会参与综合判定） */
    updateVerify: function (q, time) {
        var self = this;
        var now = Date.now();
        if (this._verifyAt && now - this._verifyAt < 20000) return;
        this._verifyAt = now;
        this._lastQuotes = q;
        this._lastTime = time;
        verify.load(q, this._flowBase, time, this._aGameCore).then(function (panel) {
            var txt = JSON.stringify(panel);
            if (txt === self._verifyJson) return;
            self._verifyJson = txt;
            self.setData({ verifyPanel: panel });
        }).catch(function () { });
    },

    /** 多空博弈：A股 ASFMM-A + 美股 SFMM，10 分钟缓存，5 分钟自刷新 */
    loadBGames: function () {
        var self = this;
        var selfTimer = function () {
            if (self._bgTimer) clearTimeout(self._bgTimer);
            self._bgTimer = setTimeout(function () {
                self.loadBGames();
            }, 5 * 60 * 1000);
        };
        bgame.loadAGame().then(function (a) {
            self.setData({ aGame: decorateAGame(a), aGameState: '' });
            // 模型底牌喂给实操验证面板，让「今日验证结论」与模型偏涨/偏跌互相咬合；
            // 模型后到/刷新时绕过 20 秒节流立即重算结论
            self._aGameCore = {
                pred: a.pred, lo: a.predLo, hi: a.predHi, m: a.M, quad: a.quad,
                regimeState: a.regime ? a.regime.state : '', regimeLabel: a.regime ? a.regime.label : '',
                gateScore: a.gateScore
            };
            self._verifyAt = 0;
            self._verifyJson = '';
            self.updateVerify(self._lastQuotes, self._lastTime);
            // 模型后到：立即重算「跨市场×模型」汇总卡
            if (self._lastSig) {
                self.setData({ sigFuse: signalModel.buildFuse(self._lastSig, self._aGameCore) });
            }
        }).catch(function (e) {
            self.setData({ aGameState: (e && e.message) || '计算失败' });
        }).then(function () {
            return bgame.loadUsGame();
        }).then(function (u) {
            self.setData({ usGame: decorateUsGame(u), usGameState: '' });
        }).catch(function (e) {
            self.setData({ usGameState: (e && e.message) || '计算失败' });
        }).then(function () {
            // 模型计算会落库预测并回填真实值，这里刷新复盘图（含云端合并）
            self.refreshBgAcc();
            selfTimer();
        });
    },

    /** 模型预测复盘卡 */
    loadBgAcc: function () {
        var self = this;
        bgHist.sync().then(function () {
            self.refreshBgAcc();
        });
    },

    refreshBgAcc: function () {
        var list = bgHist.load();
        var model = this.data.bgAccTab;
        var recs = [];
        for (var i = 0; i < list.length; i++) {
            if (list[i].model === model) recs.push(list[i]);
        }
        recs.sort(function (a, b) { return a.ymd < b.ymd ? -1 : (a.ymd > b.ymd ? 1 : 0); });
        recs = recs.slice(-20);
        this._bgAccRecs = recs;
        this._bgAccIdx = -1;
        var st = bgHist.stats(list, model);
        this.setData({
            bgAccStats: {
                dirText: st.dirTotal ? st.dirHit + '/' + st.dirTotal + '（' + st.dirPct + '%）' : '暂无已验证',
                rngText: st.rngTotal ? st.rngHit + '/' + st.rngTotal + '（' + st.rngPct + '%）' : '暂无已验证'
            },
            bgAccPick: null
        });
        this.drawBgAcc();
    },

    switchBgAcc: function (e) {
        var key = e.currentTarget.dataset.key;
        if (!key || key === this.data.bgAccTab) return;
        this.setData({ bgAccTab: key });
        this.refreshBgAcc();
    },

    drawBgAcc: function () {
        if (!this._bgAccRecs || !this._bgAccRecs.length) {
            this.setData({ bgAccState: '暂无记录：模型每次计算会自动记录当日预测，次日收盘后回填真实值' });
            return;
        }
        this.setData({ bgAccState: '' });
        var self = this;
        wx.createSelectorQuery().select('#bgAccCanvas')
            .fields({ node: true, size: true })
            .exec(function (res) {
                var item = res && res[0];
                if (!item || !item.node) return;
                self.renderBgAcc(item.node, item.width, item.height);
            });
    },

    renderBgAcc: function (node, cssW, cssH) {
        var ctx = node.getContext('2d');
        var dpr = (wx.getSystemInfoSync().pixelRatio) || 2;
        node.width = cssW * dpr;
        node.height = cssH * dpr;
        ctx.scale(dpr, dpr);

        var recs = this._bgAccRecs;
        var n = recs.length;
        var UP = '#ff6b6d';
        var DOWN = '#2fd67c';
        var GRID = 'rgba(255,255,255,0.07)';
        var AXIS = '#5f6c7d';
        var ZERO = 'rgba(255,255,255,0.35)';
        var CROSS = 'rgba(255,255,255,0.55)';

        // 动态量程：覆盖所有展示值
        var S = 0.8;
        for (var i = 0; i < n; i++) {
            var p = Math.abs(Number(recs[i].pred));
            if (p > S) S = p;
            if (recs[i].actual !== null && recs[i].actual !== undefined) {
                var av = Math.abs(Number(recs[i].actual));
                if (av > S) S = av;
            }
        }
        S = Math.ceil(S * 1.3 * 10) / 10;

        var AXIS_W = 40;
        var left = AXIS_W;
        var right = cssW - 8;
        var top = 10;
        var plotH = cssH - top - 22;
        var gw = (right - left) / n;
        var yOf = function (v) { return top + (1 - (v + S) / (2 * S)) * plotH; };
        var zeroY = yOf(0);

        // 网格
        var levels = [S, S / 2, 0, -S / 2, -S];
        for (var g = 0; g < levels.length; g++) {
            var gy = yOf(levels[g]);
            ctx.strokeStyle = levels[g] === 0 ? ZERO : GRID;
            ctx.lineWidth = levels[g] === 0 ? 1.2 : 1;
            ctx.beginPath();
            ctx.moveTo(left, gy);
            ctx.lineTo(right, gy);
            ctx.stroke();
            ctx.fillStyle = AXIS;
            ctx.font = '9px sans-serif';
            ctx.textAlign = 'right';
            ctx.fillText((levels[g] > 0 ? '+' : '') + levels[g].toFixed(1) + '%', AXIS_W - 4, gy + 3);
        }

        // 选中高亮
        if (this._bgAccIdx >= 0 && this._bgAccIdx < n) {
            ctx.fillStyle = 'rgba(255,255,255,0.06)';
            ctx.fillRect(left + this._bgAccIdx * gw, top, gw, plotH);
        }

        // 双柱：预测（半透明）+ 真实（实心）
        this._bgAccRects = [];
        for (var r = 0; r < n; r++) {
            var rec = recs[r];
            var gx = left + r * gw;
            var bw = gw * 0.32;
            var pv = Number(rec.pred);
            var pCol = pv >= 0 ? UP : DOWN;
            var ph = Math.max(2, Math.abs(yOf(pv) - zeroY));
            ctx.fillStyle = 'rgba(255,107,109,0.45)';
            ctx.fillStyle = pv >= 0 ? 'rgba(255,107,109,0.45)' : 'rgba(47,214,124,0.45)';
            ctx.fillRect(gx + gw * 0.10, pv >= 0 ? yOf(pv) : zeroY, bw, ph);

            if (rec.actual !== null && rec.actual !== undefined) {
                var av2 = Number(rec.actual);
                ctx.fillStyle = av2 >= 0 ? UP : DOWN;
                ctx.fillRect(gx + gw * 0.52, av2 >= 0 ? yOf(av2) : zeroY, bw, Math.max(2, Math.abs(yOf(av2) - zeroY)));
            }
            this._bgAccRects.push({ x0: gx, x1: gx + gw, idx: r });
        }

        // 横轴日期（首/中/尾）
        ctx.fillStyle = AXIS;
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(String(recs[0].ymd).slice(5, 10), left, cssH - 6);
        ctx.textAlign = 'center';
        ctx.fillText(String(recs[Math.floor(n / 2)].ymd).slice(5, 10), left + gw * Math.floor(n / 2) + gw / 2, cssH - 6);
        ctx.textAlign = 'right';
        ctx.fillText(String(recs[n - 1].ymd).slice(5, 10), right, cssH - 6);

        // 图例
        ctx.textAlign = 'left';
        ctx.font = '10px sans-serif';
        ctx.fillStyle = 'rgba(255,107,109,0.45)';
        ctx.fillRect(left + 4, top + 2, 8, 8);
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.fillText('模型预测', left + 16, top + 10);
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.fillRect(left + 80, top + 2, 8, 8);
        ctx.fillText('真实(次日收盘)', left + 92, top + 10);

        // 十字线
        if (this._bgAccIdx >= 0 && this._bgAccIdx < n) {
            var cx = left + this._bgAccIdx * gw + gw / 2;
            ctx.strokeStyle = CROSS;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(cx, top);
            ctx.lineTo(cx, top + plotH);
            ctx.stroke();
            ctx.setLineDash([]);
        }
    },

    bgAccTap: function (e) {
        var rects = this._bgAccRects;
        if (!rects || !rects.length) return;
        var x = e.touches && e.touches[0] ? e.touches[0].x : (e.detail && e.detail.x);
        if (x === undefined || x === null) return;
        for (var i = 0; i < rects.length; i++) {
            if (x >= rects[i].x0 && x <= rects[i].x1) {
                var r = this._bgAccRecs[rects[i].idx];
                if (!r) return;
                this._bgAccIdx = rects[i].idx;
                var hit = null;
                if (r.actual !== null && r.actual !== undefined) {
                    hit = (r.pred > 0 && r.actual > 0) || (r.pred < 0 && r.actual < 0);
                }
                var pct = function (v) { return (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%'; };
                this.setData({
                    bgAccPick: {
                        text: r.ymd + '  预测 ' + pct(r.pred) +
                            '（' + pct(r.lo) + ' ~ ' + pct(r.hi) + '）· 真实 ' +
                            (r.actual === null || r.actual === undefined ? '待回填' : pct(r.actual)) +
                            (hit === null ? '' : hit ? ' · 方向命中' : ' · 方向偏离')
                    }
                });
                this.renderBgAccResafe();
                return;
            }
        }
    },

    renderBgAccResafe: function () {
        var self = this;
        wx.createSelectorQuery().select('#bgAccCanvas')
            .fields({ node: true, size: true })
            .exec(function (res) {
                var item = res && res[0];
                if (!item || !item.node) return;
                self.renderBgAcc(item.node, item.width, item.height);
            });
    },

    bgAccEnd: function () {
        // 保留选中与数字，方便查看；再次点击其他柱切换
    },

    makePosPick: function (day) {
        var key = this.data.posTab;
        var d = day && day.data ? day.data[key] : null;
        if (!d) return null;
        // 找到该日在序列中的位置，用于计算较前日增减
        var idx = -1;
        var i;
        for (i = 0; i < this._posData.length; i++) {
            if (this._posData[i].ymd === day.ymd) { idx = i; break; }
        }
        var prev = idx > 0 ? this._posData[idx - 1] : null;
        /** 纯净空口径：正数=净空手数，负数=净多手数（正常情况下中信恒为净空） */
        function side(v) {
            return (v >= 0 ? '净空 ' : '净多 ') + fmt.group(Math.abs(v)) + ' 手';
        }
        /** 较前日增减：正=净空增加，负=净空减少 */
        function deltaText(v) {
            if (!prev || !prev.data[key]) return '';
            var df = v - prev.data[key];
            if (!df) return '（较前日持平）';
            return df > 0 ? '（较前日 +' + fmt.group(df) + '）' : '（较前日 -' + fmt.group(-df) + '）';
        }
        return {
            label: day.label,
            citicText: side(d.citic) + deltaText(d.citic),
            top20Text: side(d.top20) + deltaText(d.top20)
        };
    },

    switchPos: function (e) {
        var key = e.currentTarget.dataset.key;
        if (!key || key === this.data.posTab) return;
        // 切换品种后直接给出最近一个交易日的具体数字，避免空白
        var last = this._posData && this._posData.length ? this._posData[this._posData.length - 1] : null;
        this._posHover = null;
        this.setData({ posTab: key, posPick: last && last.data[key] ? this.makePosPick(last) : null });
        this.drawPos();
    },

    onPosTap: function (e) {
        var rects = this._posRects;
        if (!rects || !rects.length) return;
        var x = e.touches && e.touches[0] ? e.touches[0].x : (e.detail && e.detail.x);
        if (x === undefined || x === null) return;
        for (var i = 0; i < rects.length; i++) {
            if (x >= rects[i].x0 && x <= rects[i].x1) {
                // 图上浮出数值框：记录悬停组并重绘
                if (this._posHover !== i) {
                    this._posHover = i;
                    if (this._posCanvas) {
                        this.renderPos(this._posCanvas.node, this._posCanvas.w, this._posCanvas.h);
                    }
                }
                var day = this._posData[rects[i].idx];
                var pick = day ? this.makePosPick(day) : null;
                if (pick) this.setData({ posPick: pick });
                return;
            }
        }
    },

    drawPos: function () {
        var self = this;
        var days = this._posData;
        if (!days || !days.length) return;
        wx.createSelectorQuery().select('#posCanvas')
            .fields({ node: true, size: true })
            .exec(function (res) {
                var item = res && res[0];
                if (!item || !item.node) return;
                self._posCanvas = { node: item.node, w: item.width, h: item.height };
                self.renderPos(item.node, item.width, item.height);
            });
    },

    renderPos: function (node, cssW, cssH) {
        var ctx = node.getContext('2d');
        var dpr = (wx.getSystemInfoSync().pixelRatio) || 2;
        node.width = cssW * dpr;
        node.height = cssH * dpr;
        ctx.scale(dpr, dpr);

        var key = this.data.posTab;
        var rows = [];
        for (var i = 0; i < this._posData.length; i++) {
            var d = this._posData[i].data[key];
            if (!d) continue;
            var prevD = i > 0 ? this._posData[i - 1].data[key] : null;
            rows.push({
                label: this._posData[i].label,
                citic: d.citic,
                top20: d.top20,
                dc: prevD ? d.citic - prevD.citic : null,
                dt: prevD ? d.top20 - prevD.top20 : null
            });
        }
        if (!rows.length) return;

        var UP = '#ff6b6d';
        var DOWN = '#2fd67c';
        var GRID = 'rgba(255,255,255,0.07)';
        var TXT = '#5f6c7d';
        var LINE_CITIC = '#6c9bff';
        var LINE_TOP = '#ffd166';

        var W = cssW;
        var H = cssH;
        var padL = 44;
        var padR = 10;
        var padT = 16;
        var padB = 22;
        var plotW = W - padL - padR;
        var plotH = H - padT - padB;
        var zeroY = padT + plotH / 2;

        var maxAbs = 0;
        rows.forEach(function (r) {
            maxAbs = Math.max(maxAbs, Math.abs(r.citic), Math.abs(r.top20));
        });
        if (!maxAbs) maxAbs = 1;
        var scale = maxAbs * 1.2;
        // 取整到「好看」的刻度
        var pow = Math.pow(10, Math.floor(Math.log(scale) / Math.LN10));
        scale = Math.ceil(scale / pow) * pow;

        function yOf(v) {
            return zeroY - (v / scale) * (plotH / 2);
        }

        ctx.clearRect(0, 0, W, H);

        // 网格与刻度
        ctx.font = '10px sans-serif';
        ctx.textBaseline = 'middle';
        [scale, scale / 2, 0, -scale / 2, -scale].forEach(function (v) {
            var y = yOf(v);
            ctx.strokeStyle = v === 0 ? 'rgba(255,255,255,0.28)' : GRID;
            ctx.lineWidth = v === 0 ? 1 : 0.5;
            ctx.beginPath();
            ctx.moveTo(padL, y);
            ctx.lineTo(W - padR, y);
            ctx.stroke();
            ctx.fillStyle = TXT;
            ctx.textAlign = 'right';
            ctx.fillText(handAxis(v), padL - 5, y);
        });

        // 双柱：中信（实心） + 前20（半透明）；柱顶再串双线看趋势
        var n = rows.length;
        var groupW = plotW / n;
        var barW = Math.min(16, groupW * 0.26);
        var gap = 3;
        var rects = [];
        var ptsCitic = [];
        var ptsTop = [];
        for (var g = 0; g < n; g++) {
            var cx = padL + groupW * g + groupW / 2;
            var x1 = cx - barW - gap / 2;
            var x2 = cx + gap / 2;

            drawBar(x1, rows[g].citic, 1);
            drawBar(x2, rows[g].top20, 0.45);
            ptsCitic.push({ x: cx, y: yOf(rows[g].citic) });
            ptsTop.push({ x: cx, y: yOf(rows[g].top20) });

            // 日期标签
            ctx.fillStyle = TXT;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'alphabetic';
            ctx.fillText(rows[g].label, cx, H - 7);
            ctx.textBaseline = 'middle';

            rects.push({ x0: padL + groupW * g, x1: padL + groupW * (g + 1), idx: g });
        }
        this._posRects = rects;

        drawLine(ptsCitic, LINE_CITIC);
        drawLine(ptsTop, LINE_TOP);

        /** 数值文案：正=净空，负=净多 */
        function sideText(v) {
            return (v >= 0 ? '净空 ' : '净多 ') + fmt.group(Math.abs(v));
        }
        /** 增减文案：正=净空较前日增加 */
        function deltaText(dv) {
            if (dv === null || dv === undefined) return '';
            return dv > 0 ? ' +' + fmt.group(dv) : (dv < 0 ? ' -' + fmt.group(-dv) : ' 持平');
        }

        // 每组中信柱顶上方标注净空较前日增减（+绿 / -红）
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        for (var a = 0; a < n; a++) {
            var dc = rows[a].dc;
            if (dc === null || dc === undefined) continue;
            ctx.fillStyle = dc > 0 ? DOWN : (dc < 0 ? UP : TXT);
            var yy = rows[a].citic >= 0 ? ptsCitic[a].y - 6 : ptsCitic[a].y + 14;
            ctx.fillText(deltaText(dc), ptsCitic[a].x, yy);
        }

        // 点击/触摸组：高亮背景 + 浮出该日具体数值
        var hov = this._posHover;
        if (hov !== null && hov !== undefined && rects[hov] && rows[hov]) {
            ctx.fillStyle = 'rgba(108,155,255,0.10)';
            ctx.fillRect(rects[hov].x0, padT, rects[hov].x1 - rects[hov].x0, plotH);

            var r = rows[hov];
            var lines = [
                r.label,
                '中信 ' + sideText(r.citic) + deltaText(r.dc),
                '前20 ' + sideText(r.top20) + deltaText(r.dt)
            ];
            ctx.font = '10px sans-serif';
            var bw = 0;
            for (var li = 0; li < lines.length; li++) {
                bw = Math.max(bw, ctx.measureText(lines[li]).width);
            }
            bw += 16;
            var bh = lines.length * 14 + 8;
            var bx = Math.min(Math.max(padL, ptsCitic[hov].x - bw / 2), W - padR - bw);
            var by = padT + 1;
            ctx.fillStyle = 'rgba(12,18,28,0.94)';
            ctx.strokeStyle = 'rgba(108,155,255,0.55)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            if (ctx.roundRect) {
                ctx.roundRect(bx, by, bw, bh, 6);
            } else {
                ctx.rect(bx, by, bw, bh);
            }
            ctx.fill();
            ctx.stroke();
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            for (var lj = 0; lj < lines.length; lj++) {
                ctx.fillStyle = lj === 0 ? '#9fb3cd' : '#e6eefb';
                ctx.fillText(lines[lj], bx + 8, by + 11 + lj * 14);
            }
        }

        function drawLine(pts, color) {
            if (pts.length < 2) return;
            ctx.strokeStyle = color;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(pts[0].x, pts[0].y);
            for (var k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);
            ctx.stroke();
            for (var j = 0; j < pts.length; j++) {
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.arc(pts[j].x, pts[j].y, 2.5, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        function drawBar(x, v, alpha) {
            var y = yOf(Math.max(v, 0));
            var h = Math.max(1, Math.abs(yOf(v) - yOf(0)));
            ctx.globalAlpha = alpha;
            // 数值为 卖单量-买单量：正=净空（绿），负=净多（红）
            ctx.fillStyle = v >= 0 ? DOWN : UP;
            ctx.fillRect(x, y, barW, h);
            ctx.globalAlpha = 1;
        }
        function handAxis(v) {
            var a = Math.abs(v);
            var s = a >= 10000 ? (a / 10000).toFixed(a >= 100000 ? 0 : 1) + '万' : ('' + Math.round(a));
            return (v > 0 ? '+' : v < 0 ? '-' : '') + s;
        }
    },

    goAccuracy: function () {
        wx.navigateTo({ url: '/pages/accuracy/accuracy' });
    },

    removeWatch: function (e) {
        var sec = e.currentTarget.dataset.sec;
        var name = e.currentTarget.dataset.name || '这个标的';
        var self = this;
        if (!sec) return;
        wx.showModal({
            title: '移出自选',
            content: '把「' + name + '」移出自选？',
            confirmColor: '#ff6b6d',
            success: function (r) {
                if (!r.confirm) return;
                watch.remove(sec);
                market.setExtras(watch.secs());
                self.refresh();
                wx.showToast({ title: '已移出', icon: 'none', duration: 900 });
                // 云端同步（未登录时静默失败，保留待同步标记）
                watchSync.push().then(function () {
                    self.setData({ watchSyncLabel: watchSync.statusText() });
                });
            }
        });
    },

    goSetup: function () {
        var self = this;
        wx.navigateTo({
            url: '/pages/setup/setup',
            events: {
                saved: function (cfg) {
                    self.config = cfg;
                    self.setData({ config: cfg });
                    self.loadPrevPos();
                    self.refresh();
                }
            }
        });
    },

    onShareAppMessage: function () {
        return {
            title: '算力看盘 · 中韩半导体跨市场监控',
            path: '/pages/index/index'
        };
    }
});
