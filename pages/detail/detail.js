var market = require('../../utils/market');
var fmt = require('../../utils/format');

var UP = '#ff6b6d';
var DOWN = '#2fd67c';
var FLAT = '#8a97a8';
var GRID = 'rgba(255,255,255,0.07)';
var AXIS = '#5f6c7d';
var AVG = '#e6b84c';
var CROSS = 'rgba(255,255,255,0.55)';

var DAY_COUNT = 60;  // 日K默认显示最近 60 根（双指可缩放，最多到已加载的根数）
var MIN_BARS = 12;   // 双指放大上限：最少看 12 根

function priceStr(v, digits) {
    if (!fmt.isNum(v)) return '--';
    return digits === 0 ? fmt.group(Math.round(v)) : fmt.fixed(v, digits);
}

/** 估算小数位数：看价格本身的小数 */
function guessDigits(v) {
    if (!fmt.isNum(v)) return 2;
    var s = String(v);
    var i = s.indexOf('.');
    return i < 0 ? 0 : Math.min(s.length - i - 1, 4);
}

Page({
    data: {
        name: '',
        code: '',
        sec: '',
        tab: 'min',
        loading: true,
        error: '',
        updatedAt: '--:--:--',
        // 分项错误：分时 / 各周期K线各自独立，一个挂了另一个照样能看
        trendsErr: '',
        klineErr: '',
        klineSource: '',
        klineStale: false,
        klineThin: false,
        hint: '',
        // 顶部报价条
        quote: null,
        // 美股盘前 / 盘后
        ext: null,
        // 交叉线读数
        cross: null,
        canvasReady: false
    },

    onLoad: function (options) {
        var sec = decodeURIComponent(options.sec || '');
        var name = decodeURIComponent(options.name || '');
        if (!sec) {
            this.setData({ loading: false, error: '缺少标的参数' });
            return;
        }
        this._sec = sec;
        this._dpr = 1;
        this._trends = null;
        this._klines = { day: null, week: null, month: null };
        this._klineErrs = { day: '', week: '', month: '' };
        this._dayCounts = { day: DAY_COUNT, week: DAY_COUNT, month: DAY_COUNT };
        this._series = { day: null, week: null, month: null };
        this._crossIdx = -1;
        this._dayCount = DAY_COUNT;
        this._pinch = null;
        this._minSeries = null;
        this.setData({
            sec: sec,
            name: name,
            code: sec.split('.')[1] || sec
        });
        var self = this;
        wx.nextTick(function () {
            self.initCanvas();
        });
        this.loadAll();
        this.startTimer();
    },

    onShow: function () {
        this.startTimer();
    },

    onHide: function () {
        this.stopTimer();
    },

    onUnload: function () {
        this.stopTimer();
    },

    startTimer: function () {
        var self = this;
        this.stopTimer();
        this._timer = setInterval(function () {
            if (self.data.tab === 'min') {
                self.loadTrends(true);
            }
            self.loadQuote();
        }, 15000);
    },

    stopTimer: function () {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    },

    initCanvas: function () {
        var self = this;
        var query = wx.createSelectorQuery();
        query.select('#chart').fields({ node: true, size: true });
        query.exec(function (res) {
            if (!res || !res[0] || !res[0].node) return;
            var canvas = res[0].node;
            var dpr = (wx.getSystemInfoSync().pixelRatio) || 2;
            canvas.width = res[0].width * dpr;
            canvas.height = res[0].height * dpr;
            self._canvas = canvas;
            self._ctx = canvas.getContext('2d');
            self._cw = res[0].width;
            self._ch = res[0].height;
            self._dpr = dpr;
            self._ctx.scale(dpr, dpr);
            self.setData({ canvasReady: true });
            self.draw();
        });
    },

    onChartTap: function (e) {
        // K线图双指落下：进入缩放模式，不触发十字光标（分时不支持）
        if (this.data.tab !== 'min' && e.touches && e.touches.length === 2) {
            this.beginPinch(e);
            return;
        }
        this.setCross(e);
    },

    onChartMove: function (e) {
        var cnt = e.touches ? e.touches.length : 0;
        if (this._pinch) {
            if (cnt >= 2) this.movePinch(e);
            return;
        }
        // 分时图双指不做缩放，但避免第二根手指误触十字光标
        if (cnt >= 2) return;
        this.setCross(e);
    },

    onChartEnd: function (e) {
        if (this._pinch) {
            // 两根手指都离开才算缩放结束；剩一根时保持缩放态不跳光标
            if (e.touches && e.touches.length >= 2) return;
            this._pinch = null;
        }
        this._crossIdx = -1;
        this.setData({ cross: null });
        this.draw();
    },

    /** 双指缩放起点：记录初始指距与当前可见根数 */
    beginPinch: function (e) {
        var t = e.touches;
        var dx = t[0].x - t[1].x;
        var dy = t[0].y - t[1].y;
        var dist = Math.sqrt(dx * dx + dy * dy);
        var kl = this._klines[this.data.tab];
        var max = kl && kl.rows.length ? kl.rows.length : DAY_COUNT;
        this._pinch = {
            dist: dist,
            count: this._dayCount,
            max: Math.max(MIN_BARS, max)
        };
        this._crossIdx = -1;
        this.setData({ cross: null });
    },

    /** 按比例调节可见K线根数：两指张开=看更多（缩小），捏合=看更少（放大） */
    movePinch: function (e) {
        var p = this._pinch;
        var t = e.touches;
        if (!p || !p.dist || t.length < 2) return;
        var dx = t[0].x - t[1].x;
        var dy = t[0].y - t[1].y;
        var dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 1) return;
        var n = Math.round(p.count * p.dist / dist); // 指距越大，根数越少
        n = Math.max(MIN_BARS, Math.min(p.max, n));
        if (n === this._dayCount) return;
        this._dayCount = n;
        this._crossIdx = -1;
        this.draw();
    },

    setCross: function (e) {
        var t = e.touches && e.touches[0];
        if (!t) return;
        var x = t.x - 34; // 减去左侧价格轴宽
        var data = this.data.tab === 'min' ? this._minSeries : this._series[this.data.tab];
        if (!data || !data.length) return;
        var plotW = this._cw - 34 - 8;
        var idx = Math.round(x / plotW * (data.length - 1));
        if (idx < 0) idx = 0;
        if (idx > data.length - 1) idx = data.length - 1;
        this._crossIdx = idx;
        var it = data[idx];
        var digits = this._digits || 2;
        var label;
        if (this.data.tab === 'min') {
            label = it.time.slice(11) + '  价 ' + priceStr(it.price, digits) + '  均 ' + priceStr(it.avg, digits) + '  量 ' + fmt.amount(it.vol);
        } else {
            label = it.date + '  开 ' + priceStr(it.open, digits) + '  高 ' + priceStr(it.high, digits) + '  低 ' + priceStr(it.low, digits) + '  收 ' + priceStr(it.close, digits) + '  量 ' + fmt.amount(it.vol);
        }
        this.setData({ cross: label });
        this.draw();
    },

    switchTab: function (e) {
        var tab = e.currentTarget.dataset.tab;
        if (tab === this.data.tab) return;
        var prev = this.data.tab;
        if (prev !== 'min') this._dayCounts[prev] = this._dayCount; // 记住各周期缩放档位
        this._dayCount = tab === 'min' ? DAY_COUNT : (this._dayCounts[tab] || DAY_COUNT);
        this._pinch = null;
        this._crossIdx = -1;
        var curKl = this._klines[tab];
        this.setData({
            tab: tab,
            cross: null,
            klineErr: tab === 'min' ? '' : (this._klineErrs[tab] || ''),
            klineSource: curKl && curKl.source ? curKl.source : '',
            klineStale: !!(curKl && curKl.stale),
            klineThin: !!(curKl && curKl.rows && curKl.rows.length <= 3 && !curKl.stale)
        });
        this.syncHint();
        this.draw();
        // 周K / 月K 首次切换时按需加载（之后用缓存）
        if (tab !== 'min' && !this._klines[tab] && !this._klineErrs[tab]) {
            this.loadKline(false, tab);
        }
    },

    onPullDownRefresh: function () {
        var self = this;
        // 刷新时丢弃周/月缓存，并重新拉当前查看的周期
        this._klines.week = null;
        this._klines.month = null;
        var cur = this.data.tab;
        var tasks = [this.loadAll()];
        if (cur === 'week' || cur === 'month') tasks.push(this.loadKline(false, cur));
        Promise.all(tasks).then(function () {
            wx.stopPullDownRefresh();
            if (self.data.trendsErr && self.data.klineErr) {
                wx.showToast({ title: self.data.trendsErr, icon: 'none', duration: 2400 });
            }
        }).catch(function () {
            wx.stopPullDownRefresh();
        });
    },

    loadAll: function () {
        var self = this;
        return Promise.all([
            this.loadTrends(false),
            this.loadKline(false),
            this.loadQuote()
        ]).then(function () {
            self.setData({
                loading: false,
                updatedAt: fmt.clock(new Date()),
                error: !self._trends && !self._klines.day ? (self.data.trendsErr || '数据加载失败') : ''
            });
            self.syncHint();
            self.draw();
        });
    },

    /** 汇总两个数据源的错误，给出可执行的提示 */
    syncHint: function () {
        var isMin = this.data.tab === 'min';
        var tErr = this.data.trendsErr;
        var kErr = isMin ? '' : this.data.klineErr;
        var periodText = this.data.tab === 'week' ? '周K' : this.data.tab === 'month' ? '月K' : '日K';
        var hint = '';
        if (tErr && kErr) {
            hint = '两个图表都没拿到数据：' + tErr;
        } else if (kErr) {
            hint = periodText + '暂不可用（' + kErr + '），可切换到其他周期';
        } else if (tErr) {
            hint = '分时暂不可用（' + tErr + '），K线图正常';
        }
        this.setData({ hint: hint });
    },

    loadTrends: function (silent) {
        var self = this;
        return market.fetchTrends(this._sec).then(function (d) {
            self._trends = d;
            if (!silent) self.hydrateQuote(d);
            self.setData({ trendsErr: '' });
            if (self.data.tab === 'min') self.draw();
            return d;
        }).catch(function (e) {
            self.setData({ trendsErr: market.friendly(e && e.message) });
            self.syncHint();
            if (self.data.tab === 'min') self.draw();
            return null;
        });
    },

    /** 加载指定周期K线：day=日K / week=周K / month=月K */
    loadKline: function (silent, period) {
        var self = this;
        var p = period || 'day';
        var klt = p === 'week' ? 102 : p === 'month' ? 103 : 101;
        return market.fetchKline(this._sec, 120, klt).then(function (d) {
            self._klines[p] = d;
            self._klineErrs[p] = '';
            if (!silent && p === 'day') self.hydrateQuote(d);
            if (self.data.tab === p) {
                self.setData({
                    klineErr: '',
                    klineSource: d && d.source ? d.source : '',
                    klineStale: !!(d && d.stale),
                    klineThin: !!(d && d.rows && d.rows.length <= 3 && !(d && d.stale))
                });
                self.syncHint();
                self.draw();
            }
            return d;
        }).catch(function (e) {
            self._klineErrs[p] = market.friendly(e && e.message);
            if (self.data.tab === p) {
                self.setData({ klineErr: self._klineErrs[p] });
                self.syncHint();
                self.draw();
            }
            return null;
        });
    },

    /** 拉一份完整报价：名称、小数位、盘前盘后（美股） */
    loadQuote: function () {
        var self = this;
        return market.fetchQuote(this._sec).then(function (q) {
            if (!q) return null;
            if (fmt.isNum(q.digits)) self._digits = Number(q.digits);
            var hasPre = fmt.isNum(q.prePct);
            var hasAfter = fmt.isNum(q.afterPct);
            var isUs = /^(105|106|107)\./.test(String(this._sec || ''));
            var ext = null;
            if (hasPre || hasAfter || isUs) {
                ext = {
                    preText: hasPre ? '盘前 ' + fmt.pct(q.prePct) : '盘前 待开',
                    preCls: hasPre ? fmt.cls(q.prePct) : 'flat',
                    afterText: hasAfter ? '盘后 ' + fmt.pct(q.afterPct) : '盘后 待开',
                    afterCls: hasAfter ? fmt.cls(q.afterPct) : 'flat',
                    note: '美股盘前 17:00-22:30 / 盘后 05:00-09:00（北京时间自动更新）'
                };
            }
            var patch = {
                name: q.name || self.data.name,
                code: q.code || self.data.code,
                ext: ext
            };
            if (fmt.isNum(q.price)) {
                patch.quote = {
                    priceText: priceStr(q.price, self._digits),
                    pctText: fmt.isNum(q.pct) ? fmt.pct(q.pct) : '--',
                    cls: fmt.cls(q.pct)
                };
            }
            self.setData(patch);
            return q;
        }).catch(function () {
            return null;
        });
    },

    /** 从接口数据里取标的名称与最新价，补齐顶部报价条 */
    hydrateQuote: function (d) {
        var row = d.rows[d.rows.length - 1];
        if (!row) return;
        var name = d.name || this.data.name;
        var price, preClose;
        if (this._trends && d === this._trends) {
            price = row.price;
            preClose = this._trends.preClose;
        } else {
            price = row.close;
            var daily = this._klines.day;
            preClose = daily && daily.rows.length > 1
                ? daily.rows[daily.rows.length - 2].close
                : row.open;
        }
        var pct = fmt.isNum(preClose) && preClose > 0 ? (price - preClose) / preClose * 100 : null;
        var prev = this.data.quote || {};
        this.setData({
            name: name || prev.name || '',
            quote: {
                priceText: priceStr(price, this._digits),
                pctText: pct === null ? '--' : fmt.pct(pct),
                cls: fmt.cls(pct)
            }
        });
    },

    /** 入口：按当前 tab 画图 */
    draw: function () {
        if (!this._ctx) return;
        var ctx = this._ctx;
        var w = this._cw;
        var h = this._ch;
        ctx.clearRect(0, 0, w, h);
        var ok = false;
        if (this.data.tab === 'min') {
            ok = this.drawMin();
        } else {
            ok = this.drawDay();
        }
        if (!ok) {
            var err = this.data.tab === 'min' ? this.data.trendsErr : this.data.klineErr;
            ctx.textAlign = 'center';
            if (err) {
                ctx.fillStyle = '#ff8a8c';
                ctx.font = '12px sans-serif';
                var kLabel = this.data.tab === 'week' ? '周K' : this.data.tab === 'month' ? '月K' : '日K';
                ctx.fillText(this.data.tab === 'min' ? '分时加载失败' : kLabel + '加载失败', w / 2, h / 2 - 10);
                ctx.fillStyle = AXIS;
                ctx.font = '10px sans-serif';
                ctx.fillText(err, w / 2, h / 2 + 10);
                ctx.fillText('下拉可重试 · 或在微信「…」中打开调试', w / 2, h / 2 + 28);
            } else {
                ctx.fillStyle = AXIS;
                ctx.font = '12px sans-serif';
                ctx.fillText('数据加载中…', w / 2, h / 2);
            }
        }
    },

    /** 公共：坐标转换与网格 */
    layout: function (rows) {
        var AXIS_W = 34;
        var VOL_H = Math.round(this._ch * 0.22);
        var priceH = this._ch - VOL_H - 24;
        var plotW = this._cw - AXIS_W - 8;
        var n = Math.max(1, rows.length);
        // 每根K线宽度设上限（24px），避免降级源只给1根时蜡烛/成交量撑满全屏；少根时水平居中
        var barW = Math.min(plotW / n, 24);
        var barOffset = (plotW - barW * n) / 2;
        return {
            left: AXIS_W,
            right: this._cw - 8,
            plotW: plotW,
            priceTop: 6,
            priceH: priceH,
            volTop: this._ch - VOL_H - 16,
            volH: VOL_H,
            axisW: AXIS_W,
            barW: barW,
            barOffset: barOffset,
            rows: rows
        };
    },

    drawCross: function (L, xs, data) {
        if (this._crossIdx < 0 || !data[this._crossIdx]) return;
        var ctx = this._ctx;
        var x = xs(this._crossIdx);
        var y = (data[this._crossIdx].y === undefined) ? null : data[this._crossIdx].y;
        ctx.strokeStyle = CROSS;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x, 4);
        ctx.lineTo(x, L.volTop - 6);
        ctx.stroke();
        if (y !== null) {
            ctx.beginPath();
            ctx.moveTo(L.left, y);
            ctx.lineTo(L.right, y);
            ctx.stroke();
        }
        ctx.setLineDash([]);
    },

    drawVolume: function (L, rows, refIdx) {
        var ctx = this._ctx;
        var maxVol = 0;
        for (var i = 0; i < rows.length; i++) {
            if (rows[i].vol > maxVol) maxVol = rows[i].vol;
        }
        if (maxVol <= 0) return;
        var bw = L.barW;
        var offX = L.barOffset || 0;
        for (var j = 0; j < rows.length; j++) {
            var r = rows[j];
            var h = Math.max(1, r.vol / maxVol * L.volH);
            var up = refIdx === undefined
                ? j === 0 || r.close >= rows[Math.max(0, j - 1)].close
                : r.price >= rows[Math.max(0, j - 1)].price;
            ctx.fillStyle = up ? 'rgba(255,107,109,0.5)' : 'rgba(47,214,124,0.5)';
            ctx.fillRect(L.left + offX + j * bw, L.volTop + L.volH - h, Math.max(1, bw - (bw > 3 ? 1 : 0)), h);
        }
        ctx.fillStyle = AXIS;
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('量', 2, L.volTop + 10);
        ctx.fillText(fmt.amount(maxVol), 2, L.volTop + L.volH);
    },

    /** 分时图 */
    drawMin: function () {
        var t = this._trends;
        if (!t || !t.rows.length) return false;
        var rows = t.rows;
        var digits = this._digits = guessDigits(t.preClose || rows[0].price);
        var L = this.layout(rows);

        var minP = t.preClose, maxP = t.preClose;
        for (var i = 0; i < rows.length; i++) {
            if (rows[i].price < minP) minP = rows[i].price;
            if (rows[i].price > maxP) maxP = rows[i].price;
            if (rows[i].avg < minP) minP = rows[i].avg;
            if (rows[i].avg > maxP) maxP = rows[i].avg;
        }
        var pad = (maxP - minP) * 0.08 || Math.max(maxP * 0.002, 0.01);
        minP -= pad; maxP += pad;
        var mid = (maxP + minP) / 2;
        var half = (maxP - minP) / 2;
        var ref = t.preClose;
        var refIn = ref >= minP && ref <= maxP;
        if (!refIn) {
            mid = ref;
            half = Math.max(Math.abs(maxP - ref), Math.abs(ref - minP));
        }

        var ctx = this._ctx;
        var yOf = function (p) {
            return L.priceTop + (mid + half - p) / (2 * half) * L.priceH;
        };
        var xOf = function (i) {
            return L.left + (rows.length === 1 ? L.plotW / 2 : i / (rows.length - 1) * L.plotW);
        };

        // 网格 + 价格轴
        ctx.strokeStyle = GRID;
        ctx.lineWidth = 1;
        var gridY = [mid + half, mid, mid - half];
        for (var g = 0; g < gridY.length; g++) {
            ctx.beginPath();
            ctx.moveTo(L.left, gridY[g]);
            ctx.lineTo(L.right, gridY[g]);
            ctx.stroke();
            ctx.fillStyle = AXIS;
            ctx.font = '9px sans-serif';
            ctx.textAlign = 'right';
            ctx.fillText(priceStr(gridY[g] === mid ? mid : gridY[g], digits), L.axisW - 4, gridY[g] + 3);
        }
        // 昨收虚线
        if (refIn) {
            ctx.strokeStyle = 'rgba(230,184,76,0.6)';
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(L.left, yOf(ref));
            ctx.lineTo(L.right, yOf(ref));
            ctx.stroke();
            ctx.setLineDash([]);
        }
        // 时间轴
        ctx.fillStyle = AXIS;
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(rows[0].time.slice(11, 16), L.left, L.volTop + L.volH + 12);
        ctx.textAlign = 'right';
        ctx.fillText(rows[rows.length - 1].time.slice(11, 16), L.right, L.volTop + L.volH + 12);

        // 均价线
        ctx.strokeStyle = AVG;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (var a = 0; a < rows.length; a++) {
            var xa = xOf(a), ya = yOf(rows[a].avg);
            if (a === 0) ctx.moveTo(xa, ya); else ctx.lineTo(xa, ya);
        }
        ctx.stroke();

        // 价格线
        var last = rows[rows.length - 1].price;
        var lineColor = last >= t.preClose ? UP : DOWN;
        ctx.strokeStyle = lineColor;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        for (var b = 0; b < rows.length; b++) {
            var xb = xOf(b), yb = yOf(rows[b].price);
            if (b === 0) ctx.moveTo(xb, yb); else ctx.lineTo(xb, yb);
        }
        ctx.stroke();

        this.drawVolume(L, rows, 'price');
        this._minSeries = rows.map(function (r, i) {
            var c = {}; for (var k in r) c[k] = r[k];
            c.y = yOf(r.price); return c;
        });
        this.drawCross(L, xOf, this._minSeries);
        return true;
    },

    /** 蜡烛图 + MA5/MA10（日K / 周K / 月K 共用） */
    drawDay: function () {
        var period = this.data.tab;
        var k = this._klines[period];
        if (!k || !k.rows.length) return false;
        var all = k.rows;
        var rows = all.slice(-Math.min(this._dayCount || DAY_COUNT, all.length));
        var digits = this._digits = guessDigits(rows[0].close);
        var L = this.layout(rows);

        var minP = Infinity, maxP = -Infinity;
        for (var i = 0; i < rows.length; i++) {
            if (rows[i].low < minP) minP = rows[i].low;
            if (rows[i].high > maxP) maxP = rows[i].high;
        }
        var pad = (maxP - minP) * 0.06 || maxP * 0.01;
        minP -= pad; maxP += pad;
        var yOf = function (p) {
            return L.priceTop + (maxP - p) / (maxP - minP) * L.priceH;
        };
        var bw = L.barW;
        var xOf = function (i) {
            return L.left + L.barOffset + (i + 0.5) * bw;
        };

        var ctx = this._ctx;
        // 网格
        ctx.strokeStyle = GRID;
        for (var g = 0; g <= 4; g++) {
            var gy = L.priceTop + L.priceH * g / 4;
            ctx.beginPath();
            ctx.moveTo(L.left, gy);
            ctx.lineTo(L.right, gy);
            ctx.stroke();
            ctx.fillStyle = AXIS;
            ctx.font = '9px sans-serif';
            ctx.textAlign = 'right';
            ctx.fillText(priceStr(maxP - (maxP - minP) * g / 4, digits), L.axisW - 4, gy + 3);
        }

        // MA 线
        var maSeries = [
            { n: 5, color: '#e6b84c' },
            { n: 10, color: '#6aa9e9' }
        ];
        for (var m = 0; m < maSeries.length; m++) {
            var n = maSeries[m].n;
            ctx.strokeStyle = maSeries[m].color;
            ctx.lineWidth = 1;
            ctx.beginPath();
            var started = false;
            for (var j = 0; j < rows.length; j++) {
                var gi = all.length - rows.length + j;
                if (gi + 1 < n) continue;
                var sum = 0;
                for (var q = 0; q < n; q++) sum += all[gi - q].close;
                var ma = sum / n;
                if (!started) { ctx.moveTo(xOf(j), yOf(ma)); started = true; }
                else ctx.lineTo(xOf(j), yOf(ma));
            }
            ctx.stroke();
        }

        // 蜡烛
        var bodyW = Math.max(1.5, bw * 0.62);
        for (var c = 0; c < rows.length; c++) {
            var r = rows[c];
            var up = r.close >= r.open;
            var col = up ? UP : DOWN;
            ctx.strokeStyle = col;
            ctx.fillStyle = col;
            var xc = xOf(c);
            // 影线
            ctx.beginPath();
            ctx.moveTo(xc, yOf(r.high));
            ctx.lineTo(xc, yOf(r.low));
            ctx.stroke();
            // 实体
            var y1 = yOf(Math.max(r.open, r.close));
            var y2 = yOf(Math.min(r.open, r.close));
            ctx.fillRect(xc - bodyW / 2, y1, bodyW, Math.max(1, y2 - y1));
        }

        // 日期轴
        ctx.fillStyle = AXIS;
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(rows[0].date.slice(5), L.left, L.volTop + L.volH + 12);
        ctx.textAlign = 'right';
        ctx.fillText(rows[rows.length - 1].date.slice(5), L.right, L.volTop + L.volH + 12);
        // 图例
        ctx.fillStyle = '#e6b84c';
        ctx.fillText('MA5', L.left, L.priceTop + 10);
        ctx.fillStyle = '#6aa9e9';
        ctx.fillText('MA10', L.left + 32, L.priceTop + 10);

        this.drawVolume(L, rows);
        this._series[period] = rows.map(function (r) {
            var c = {}; for (var key in r) c[key] = r[key];
            c.y = yOf(r.close); return c;
        });
        this.drawCross(L, xOf, this._series[period]);

        // 右上角提示当前周期与缩放档位，用户能确认手势已生效
        var kLabel = period === 'week' ? '周K' : period === 'month' ? '月K' : '日K';
        ctx.fillStyle = AXIS;
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(kLabel + ' · ' + rows.length + '根 · 双指缩放', L.right, L.priceTop + 22);
        return true;
    }
});
