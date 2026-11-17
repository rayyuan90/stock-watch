/**
 * 个股详情页（独立新增，服务于板块热力图 → 成分股 → 个股链路）
 * 分时 + 日K + 量能；数据复用 utils/gdetail 的东财接口
 */
var gdetail = require('../../utils/gdetail');

var REFRESH_MS = 30 * 1000;

Page({
    data: {
        secid: '',
        name: '',
        bk: '',
        tab: 'trend',

        priceText: '--',
        pctText: '',
        qcls: '',
        updatedAt: '',

        trendState: 'loading',
        trendMsg: '',
        trendLast: '--',
        trendAvg: '--',
        preText: '--',
        hasAvg: false,

        dayState: 'loading',
        dayMsg: '',
        dayInfo: ''
    },

    _trendData: null,
    _dayData: null,
    _timer: null,

    onLoad: function (query) {
        this.setData({
            secid: query.secid || '',
            name: decodeURIComponent(query.name || '个股'),
            bk: decodeURIComponent(query.bk || '')
        });
        if (query.bk) wx.setNavigationBarTitle({ title: decodeURIComponent(query.bk) });
        if (!this.data.secid) {
            wx.showToast({ title: '缺少代码', icon: 'none' });
            setTimeout(function () { wx.navigateBack(); }, 800);
            return;
        }
        this.loadAll(true);
        this.startTimer();
    },

    onUnload: function () { this.stopTimer(); },
    onHide: function () { this.stopTimer(); },
    onShow: function () { this.startTimer(); },

    onPullDownRefresh: function () {
        var self = this;
        this.loadAll(true).then(function () { wx.stopPullDownRefresh(); })
            .catch(function () { wx.stopPullDownRefresh(); });
    },

    startTimer: function () {
        var self = this;
        if (this._timer) return;
        this._timer = setInterval(function () { self.loadAll(false); }, REFRESH_MS);
    },

    stopTimer: function () {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    },

    setTab: function (e) {
        var tab = e.currentTarget.dataset.tab;
        if (tab === this.data.tab) return;
        this.setData({ tab: tab });
        var self = this;
        wx.nextTick(function () {
            if (tab === 'trend') self.renderTrend();
            else self.renderDay();
        });
    },

    loadAll: function () {
        var self = this;
        if (this._busy) return Promise.resolve();
        this._busy = true;
        var secid = this.data.secid;

        return Promise.all([
            gdetail.fetchQuoteEm(secid).catch(function (e) { return { err: e }; }),
            gdetail.fetchTrendEm(secid).catch(function (e) { return { err: e }; }),
            gdetail.fetchDailyEm(secid, 120).catch(function (e) { return { err: e }; })
        ]).then(function (res) {
            self._busy = false;
            var q = res[0];
            if (q && !q.err && q.price !== null) {
                self.setData({
                    priceText: self.fmt(q.price),
                    pctText: q.pct === null ? '' : (q.pct > 0 ? '+' : '') + q.pct.toFixed(2) + '%',
                    qcls: q.pct === null ? '' : (q.pct > 0 ? 'up' : (q.pct < 0 ? 'down' : ''))
                });
            }
            var t = res[1];
            if (t && !t.err) {
                self._trendData = t;
                var last = t.points[t.points.length - 1];
                var avg = last && last.avg !== null && last.avg !== undefined ? last.avg : null;
                self.setData({
                    trendState: 'ok',
                    trendMsg: '',
                    trendLast: self.fmt(last && last.p),
                    trendAvg: avg === null ? '--' : self.fmt(avg),
                    preText: self.fmt(t.preClose),
                    hasAvg: avg !== null
                });
                if (self.data.tab === 'trend') self.renderTrend();
            } else {
                self._trendData = null;
                self.setData({
                    trendState: 'fail',
                    trendMsg: '分时数据不可用：' + ((t && t.err && t.err.message) || '未知错误')
                });
            }
            var d = res[2];
            if (d && !d.err) {
                self._dayData = d;
                var lb = d.bars[d.bars.length - 1];
                self.setData({
                    dayState: 'ok',
                    dayMsg: '',
                    dayInfo: '最新 ' + String(lb.d).slice(5) + ' · 收 ' + self.fmt(lb.c) + ' · ' + d.bars.length + ' 个交易日'
                });
                if (self.data.tab === 'day') self.renderDay();
            } else {
                self._dayData = null;
                self.setData({
                    dayState: 'fail',
                    dayMsg: '日线数据不可用：' + ((d && d.err && d.err.message) || '未知错误')
                });
            }
            var now = new Date();
            var p2 = function (n) { return n < 10 ? '0' + n : '' + n; };
            self.setData({ updatedAt: p2(now.getHours()) + ':' + p2(now.getMinutes()) + ':' + p2(now.getSeconds()) });
        });
    },

    fmt: function (v) {
        if (v === null || v === undefined || isNaN(v)) return '--';
        var s = Number(v).toFixed(2);
        var parts = s.split('.');
        var intPart = parts[0];
        var neg = intPart.charAt(0) === '-';
        if (neg) intPart = intPart.slice(1);
        var out = '';
        for (var i = 0; i < intPart.length; i++) {
            if (i > 0 && (intPart.length - i) % 3 === 0) out += ',';
            out += intPart.charAt(i);
        }
        return (neg ? '-' : '') + out + (parts.length > 1 ? '.' + parts[1] : '');
    },

    /* ---------------- Canvas ---------------- */

    setupCanvas: function (id, cb) {
        var q = wx.createSelectorQuery().in(this);
        q.select(id).fields({ node: true, size: true }).exec(function (res) {
            if (!res || !res[0] || !res[0].node) return;
            var canvas = res[0].node;
            var dpr = (wx.getSystemInfoSync && wx.getSystemInfoSync().pixelRatio) || 2;
            canvas.width = res[0].width * dpr;
            canvas.height = res[0].height * dpr;
            var ctx = canvas.getContext('2d');
            ctx.scale(dpr, dpr);
            cb(ctx, res[0].width, res[0].height);
        });
    },

    renderTrend: function () {
        var self = this;
        var t = this._trendData;
        if (!t) return;
        this.setupCanvas('#trendC', function (ctx, W, H) {
            self.drawTrend(ctx, W, H, t);
        });
    },

    renderDay: function () {
        var self = this;
        var d = this._dayData;
        if (!d) return;
        this.setupCanvas('#dayC', function (ctx, W, H) {
            self.drawDaily(ctx, W, H, d);
        });
    },

    axisColor: '#55636f',
    gridColor: 'rgba(255,255,255,0.08)',

    fmtShort: function (v) {
        var a = Math.abs(v);
        if (a >= 1e8) return (v / 1e8).toFixed(1) + '亿';
        if (a >= 1e4) return (v / 1e4).toFixed(1) + '万';
        return String(Math.round(v * 100) / 100);
    },

    drawTrend: function (ctx, W, H, t) {
        var pts = t.points;
        var n = pts.length;
        if (!n) return;
        ctx.clearRect(0, 0, W, H);
        ctx.font = '10px sans-serif';

        var padR = 52, padL = 6, padT = 8;
        var volTop = H * 0.70, volBot = H - 20;
        var priceTop = padT, priceBot = H * 0.62;
        var plotW = W - padL - padR;

        var lo = Infinity, hi = -Infinity;
        for (var i = 0; i < n; i++) {
            var p = pts[i].p;
            if (p === null) continue;
            if (p < lo) lo = p;
            if (p > hi) hi = p;
            if (pts[i].avg !== null && pts[i].avg !== undefined) {
                if (pts[i].avg < lo) lo = pts[i].avg;
                if (pts[i].avg > hi) hi = pts[i].avg;
            }
        }
        if (t.preClose !== null) {
            if (t.preClose < lo) lo = t.preClose;
            if (t.preClose > hi) hi = t.preClose;
        }
        if (lo === Infinity) return;
        var span = (hi - lo) || (hi * 0.002);
        lo -= span * 0.05;
        hi += span * 0.05;
        var yOf = function (v) {
            return priceBot - (v - lo) / (hi - lo) * (priceBot - priceTop);
        };
        var xOf = function (i) {
            return padL + (n === 1 ? plotW / 2 : i / (n - 1) * plotW);
        };

        ctx.strokeStyle = this.gridColor;
        ctx.fillStyle = this.axisColor;
        ctx.lineWidth = 1;
        for (var g = 0; g <= 2; g++) {
            var gy = priceTop + (priceBot - priceTop) * g / 2;
            ctx.beginPath();
            ctx.setLineDash([2, 3]);
            ctx.moveTo(padL, gy);
            ctx.lineTo(W - padR, gy);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillText(this.fmt(hi - (hi - lo) * g / 2), W - padR + 4, gy + 3);
        }

        if (t.preClose !== null) {
            var py = yOf(t.preClose);
            ctx.strokeStyle = 'rgba(150,165,185,0.6)';
            ctx.setLineDash([4, 3]);
            ctx.beginPath();
            ctx.moveTo(padL, py);
            ctx.lineTo(W - padR, py);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        var grad = ctx.createLinearGradient(0, priceTop, 0, priceBot);
        grad.addColorStop(0, 'rgba(106,169,233,0.22)');
        grad.addColorStop(1, 'rgba(106,169,233,0.02)');
        ctx.beginPath();
        var started = false;
        var x = 0, y = 0;
        for (i = 0; i < n; i++) {
            if (pts[i].p === null) continue;
            x = xOf(i); y = yOf(pts[i].p);
            if (!started) { ctx.moveTo(x, y); started = true; }
            else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = '#6aa9e9';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        if (started) {
            ctx.lineTo(xOf(n - 1), priceBot);
            ctx.lineTo(xOf(0), priceBot);
            ctx.closePath();
            ctx.fillStyle = grad;
            ctx.fill();
        }

        var hasAvg = pts[n - 1].avg !== null && pts[n - 1].avg !== undefined;
        if (hasAvg) {
            ctx.beginPath();
            started = false;
            for (i = 0; i < n; i++) {
                if (pts[i].avg === null || pts[i].avg === undefined) continue;
                x = xOf(i); y = yOf(pts[i].avg);
                if (!started) { ctx.moveTo(x, y); started = true; }
                else ctx.lineTo(x, y);
            }
            ctx.strokeStyle = '#e8a23c';
            ctx.lineWidth = 1;
            ctx.stroke();
        }

        var maxV = 0;
        for (i = 0; i < n; i++) if (pts[i].v > maxV) maxV = pts[i].v;
        if (maxV > 0) {
            var bw = Math.max(1, plotW / n * 0.7);
            for (i = 1; i < n; i++) {
                var up = pts[i].p !== null && pts[i - 1].p !== null ? pts[i].p >= pts[i - 1].p : true;
                var vh = pts[i].v / maxV * (volBot - volTop);
                ctx.fillStyle = up ? 'rgba(226,80,106,0.75)' : 'rgba(52,160,106,0.75)';
                ctx.fillRect(xOf(i) - bw / 2, volBot - vh, bw, vh);
            }
            ctx.fillStyle = this.axisColor;
            ctx.fillText('量 ' + this.fmtShort(maxV), padL + 2, volTop - 3);
        }

        ctx.fillStyle = this.axisColor;
        var t0 = this.minuteLabel(pts[0].t);
        var t1 = this.minuteLabel(pts[n - 1].t);
        var tm = this.minuteLabel(pts[Math.floor(n / 2)].t);
        ctx.fillText(t0, padL, H - 6);
        ctx.fillText(tm, padL + plotW / 2 - 14, H - 6);
        ctx.fillText(t1, W - padR - 26, H - 6);
    },

    minuteLabel: function (t) {
        if (t.indexOf(' ') >= 0) return t.slice(t.indexOf(' ') + 1, t.indexOf(' ') + 6);
        if (t.length === 4) return t.slice(0, 2) + ':' + t.slice(2);
        return t;
    },

    drawDaily: function (ctx, W, H, d) {
        var bars = d.bars;
        var n = bars.length;
        if (!n) return;
        ctx.clearRect(0, 0, W, H);
        ctx.font = '10px sans-serif';

        var padR = 52, padL = 6, padT = 8;
        var volTop = H * 0.72, volBot = H - 20;
        var priceTop = padT, priceBot = H * 0.64;
        var plotW = W - padL - padR;

        var lo = Infinity, hi = -Infinity, maxV = 0;
        for (var i = 0; i < n; i++) {
            if (bars[i].l < lo) lo = bars[i].l;
            if (bars[i].h > hi) hi = bars[i].h;
            if (bars[i].v > maxV) maxV = bars[i].v;
        }
        var span = (hi - lo) || (hi * 0.01);
        lo -= span * 0.04;
        hi += span * 0.04;
        var yOf = function (v) { return priceBot - (v - lo) / (hi - lo) * (priceBot - priceTop); };

        ctx.strokeStyle = this.gridColor;
        ctx.fillStyle = this.axisColor;
        ctx.lineWidth = 1;
        for (var g = 0; g <= 2; g++) {
            var gy = priceTop + (priceBot - priceTop) * g / 2;
            ctx.beginPath();
            ctx.setLineDash([2, 3]);
            ctx.moveTo(padL, gy);
            ctx.lineTo(W - padR, gy);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillText(this.fmt(hi - (hi - lo) * g / 2), W - padR + 4, gy + 3);
        }

        var slot = plotW / n;
        var bw = Math.min(7, Math.max(1, slot * 0.66));
        for (i = 0; i < n; i++) {
            var b = bars[i];
            var up = b.c >= b.o;
            var col = up ? '#e2506a' : '#34a06a';
            var x = padL + slot * (i + 0.5);
            ctx.strokeStyle = col;
            ctx.fillStyle = col;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, yOf(b.h));
            ctx.lineTo(x, yOf(b.l));
            ctx.stroke();
            var yO = yOf(b.o), yC = yOf(b.c);
            var top = Math.min(yO, yC);
            var bh = Math.max(1, Math.abs(yO - yC));
            ctx.fillRect(x - bw / 2, top, bw, bh);
        }

        var lastC = bars[n - 1].c;
        ctx.strokeStyle = 'rgba(150,165,185,0.6)';
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(padL, yOf(lastC));
        ctx.lineTo(W - padR, yOf(lastC));
        ctx.stroke();
        ctx.setLineDash([]);

        if (maxV > 0) {
            for (i = 0; i < n; i++) {
                var upv = bars[i].c >= bars[i].o;
                var vh2 = bars[i].v / maxV * (volBot - volTop);
                ctx.fillStyle = upv ? 'rgba(226,80,106,0.75)' : 'rgba(52,160,106,0.75)';
                ctx.fillRect(padL + slot * (i + 0.5) - bw / 2, volBot - vh2, bw, vh2);
            }
            ctx.fillStyle = this.axisColor;
            ctx.fillText('量 ' + this.fmtShort(maxV), padL + 2, volTop - 3);
        } else {
            ctx.fillStyle = this.axisColor;
            ctx.fillText('该股无量能数据', padL + 2, volTop + 10);
        }

        ctx.fillStyle = this.axisColor;
        var steps = 4;
        for (var s = 0; s < steps; s++) {
            var idx = Math.min(n - 1, Math.floor(n * s / steps));
            var label = String(bars[idx].d).slice(5);
            var lx = padL + slot * (idx + 0.5) - 12;
            ctx.fillText(label, Math.max(padL, lx), H - 6);
        }
    }
});
