var market = require('../../utils/market');
var fmt = require('../../utils/format');

var UP = '#ff6b6d';
var DOWN = '#2fd67c';
var GRID = 'rgba(255,255,255,0.07)';
var AXIS = '#5f6c7d';
var TODAY = '#6c9bff';
var PREV = '#67737f';
var MA = '#e6b84c';
var CROSS = 'rgba(255,255,255,0.55)';
var BARS = 60;

function yi(v) {
    if (!fmt.isNum(v)) return '--';
    return (v / 1e8).toFixed(0) + '亿';
}

function shortDay(d) {
    var s = String(d || '');
    return s.length >= 10 ? s.slice(5, 10) : s;
}

Page({
    data: {
        loading: true,
        flowErr: '',
        barsErr: '',
        updatedAt: '--:--:--',
        head: null,
        flowCross: null,
        barsCross: null
    },

    onLoad: function () {
        this._flow = null;
        this._daily = null;
        this._crossF = -1;
        this._crossB = -1;
        this._canvases = {};
        var self = this;
        wx.nextTick(function () {
            self.initCanvas('flowChart');
            self.initCanvas('barChart');
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
        // 5分钟一根K线，60 秒刷一次足够
        this._timer = setInterval(function () {
            self.loadFlow(true);
        }, 60000);
    },

    stopTimer: function () {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    },

    initCanvas: function (id) {
        var self = this;
        var query = wx.createSelectorQuery();
        query.select('#' + id).fields({ node: true, size: true });
        query.exec(function (res) {
            if (!res || !res[0] || !res[0].node) return;
            var canvas = res[0].node;
            var dpr = (wx.getSystemInfoSync().pixelRatio) || 2;
            canvas.width = res[0].width * dpr;
            canvas.height = res[0].height * dpr;
            var ctx = canvas.getContext('2d');
            ctx.scale(dpr, dpr);
            self._canvases[id] = {
                ctx: ctx,
                w: res[0].width,
                h: res[0].height
            };
            if (id === 'flowChart') self.drawFlow();
            else self.drawBars();
        });
    },

    onPullDownRefresh: function () {
        var self = this;
        Promise.all([this.loadFlow(false), this.loadDaily()]).then(function () {
            wx.stopPullDownRefresh();
        }).catch(function () {
            wx.stopPullDownRefresh();
        });
    },

    loadAll: function () {
        var self = this;
        return Promise.all([this.loadFlow(false), this.loadDaily()]).then(function () {
            self.setData({
                loading: false,
                updatedAt: fmt.clock(new Date())
            });
        });
    },

    loadFlow: function (silent) {
        var self = this;
        return market.fetchFlowCompare().then(function (f) {
            self._flow = f;
            self.setData({ flowErr: '', head: self.buildHead(f) });
            self.drawFlow();
            return f;
        }).catch(function (e) {
            self.setData({ flowErr: market.friendly(e && e.message) });
            self.drawFlow();
            return null;
        });
    },

    loadDaily: function () {
        var self = this;
        return market.fetchDailyFlow(BARS).then(function (rows) {
            self._daily = rows;
            self.setData({ barsErr: '' });
            self.drawBars();
            return rows;
        }).catch(function (e) {
            self.setData({ barsErr: market.friendly(e && e.message) });
            self.drawBars();
            return null;
        });
    },

    buildHead: function (f) {
        if (!f) return null;
        var ratio = fmt.isNum(f.ratio) ? f.ratio : null;
        return {
            todayText: yi(f.todayTotal),
            prevText: yi(f.prevTotal),
            todayDate: shortDay(f.todayDate),
            prevDate: shortDay(f.prevDate),
            ratioText: ratio === null ? '--' : fmt.pct((ratio - 1) * 100),
            ratioCls: fmt.cls(ratio === null ? null : ratio - 1),
            ratioNote: ratio === null
                ? '同时刻对比暂缺'
                : '同一时点为昨日的 ' + (ratio * 100).toFixed(0) + '%',
            progressPct: f.prevTotal > 0 ? Math.min(100, f.todayTotal / f.prevTotal * 100) : 0,
            countText: (f.todayCount || 0) + '/' + (f.slots ? f.slots.length : 0) + ' 个时段'
        };
    },

    // ---------- 对比曲线 ----------

    drawFlow: function () {
        var cv = this._canvases.flowChart;
        if (!cv) return;
        var ctx = cv.ctx;
        var w = cv.w;
        var h = cv.h;
        ctx.clearRect(0, 0, w, h);
        var f = this._flow;
        if (!f || !f.slots || !f.slots.length) {
            this.drawEmpty(ctx, w, h, this.data.flowErr || '数据加载中…');
            return;
        }
        var slots = f.slots;
        var n = slots.length;
        var AXIS_W = 44;
        var plotW = w - AXIS_W - 8;
        var top = 8;
        var plotH = h - top - 22;
        var left = AXIS_W;
        var right = w - 8;

        var maxV = 0;
        for (var i = 0; i < n; i++) {
            if (f.prev[i] > maxV) maxV = f.prev[i];
            if (f.today[i] !== null && f.today[i] > maxV) maxV = f.today[i];
        }
        maxV = maxV * 1.06 || 1;

        var xOf = function (i) { return left + (n === 1 ? plotW / 2 : i / (n - 1) * plotW); };
        var yOf = function (v) { return top + (1 - v / maxV) * plotH; };

        // 网格 + 纵轴
        ctx.strokeStyle = GRID;
        ctx.lineWidth = 1;
        for (var g = 0; g <= 4; g++) {
            var gy = top + plotH * g / 4;
            ctx.beginPath();
            ctx.moveTo(left, gy);
            ctx.lineTo(right, gy);
            ctx.stroke();
            ctx.fillStyle = AXIS;
            ctx.font = '9px sans-serif';
            ctx.textAlign = 'right';
            ctx.fillText(yi(maxV * (1 - g / 4)), AXIS_W - 4, gy + 3);
        }
        // 横轴时点
        ctx.fillStyle = AXIS;
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(slots[0], left, h - 6);
        ctx.textAlign = 'center';
        ctx.fillText('11:30/13:00', xOf(Math.round((n - 1) / 2)), h - 6);
        ctx.textAlign = 'right';
        ctx.fillText(slots[n - 1], right, h - 6);

        // 昨日线
        ctx.strokeStyle = PREV;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        for (var a = 0; a < n; a++) {
            var xa = xOf(a), ya = yOf(f.prev[a]);
            if (a === 0) ctx.moveTo(xa, ya); else ctx.lineTo(xa, ya);
        }
        ctx.stroke();

        // 今日线
        var todayLen = 0;
        for (var b = 0; b < n; b++) {
            if (f.today[b] === null) break;
            todayLen = b + 1;
        }
        if (todayLen > 0) {
            ctx.strokeStyle = TODAY;
            ctx.lineWidth = 1.6;
            ctx.beginPath();
            for (var c = 0; c < todayLen; c++) {
                var xc = xOf(c), yc = yOf(f.today[c]);
                if (c === 0) ctx.moveTo(xc, yc); else ctx.lineTo(xc, yc);
            }
            ctx.stroke();
            // 线下浅填充
            ctx.lineTo(xOf(todayLen - 1), top + plotH);
            ctx.lineTo(xOf(0), top + plotH);
            ctx.closePath();
            ctx.fillStyle = 'rgba(108,155,255,0.10)';
            ctx.fill();
        }

        // 图例
        ctx.textAlign = 'left';
        ctx.font = '10px sans-serif';
        ctx.fillStyle = TODAY;
        ctx.fillText('■ 今日累计', left + 4, top + 10);
        ctx.fillStyle = PREV;
        ctx.fillText('■ 昨日累计', left + 74, top + 10);

        // 十字线
        if (this._crossF >= 0 && this._crossF < n) {
            var x = xOf(this._crossF);
            ctx.strokeStyle = CROSS;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(x, top);
            ctx.lineTo(x, top + plotH);
            ctx.stroke();
            ctx.setLineDash([]);
        }
    },

    // ---------- 60 日柱状图 ----------

    drawBars: function () {
        var cv = this._canvases.barChart;
        if (!cv) return;
        var ctx = cv.ctx;
        var w = cv.w;
        var h = cv.h;
        ctx.clearRect(0, 0, w, h);
        var rows = this._daily;
        if (!rows || !rows.length) {
            this.drawEmpty(ctx, w, h, this.data.barsErr || '数据加载中…');
            return;
        }
        var AXIS_W = 44;
        var plotW = w - AXIS_W - 8;
        var top = 8;
        var plotH = h - top - 22;
        var left = AXIS_W;
        var right = w - 8;
        var n = rows.length;

        var maxV = 0;
        for (var i = 0; i < n; i++) {
            if (rows[i].amount > maxV) maxV = rows[i].amount;
        }
        maxV = maxV * 1.08 || 1;
        var bw = plotW / n;
        var xOf = function (i) { return left + (i + 0.5) * bw; };
        var yOf = function (v) { return top + (1 - v / maxV) * plotH; };

        // 网格 + 纵轴
        ctx.strokeStyle = GRID;
        ctx.lineWidth = 1;
        for (var g = 0; g <= 4; g++) {
            var gy = top + plotH * g / 4;
            ctx.beginPath();
            ctx.moveTo(left, gy);
            ctx.lineTo(right, gy);
            ctx.stroke();
            ctx.fillStyle = AXIS;
            ctx.font = '9px sans-serif';
            ctx.textAlign = 'right';
            ctx.fillText(yi(maxV * (1 - g / 4)), AXIS_W - 4, gy + 3);
        }

        // 柱子：涨红跌绿
        for (var j = 0; j < n; j++) {
            var r = rows[j];
            var bh = Math.max(1, r.amount / maxV * plotH);
            var up = fmt.isNum(r.pct) ? r.pct >= 0 : true;
            var last = j === n - 1;
            ctx.fillStyle = up
                ? (last ? 'rgba(255,107,109,0.95)' : 'rgba(255,107,109,0.55)')
                : (last ? 'rgba(47,214,124,0.95)' : 'rgba(47,214,124,0.55)');
            ctx.fillRect(left + j * bw + 0.5, top + plotH - bh, Math.max(1, bw - 1.5), bh);
        }

        // 5日均量线
        ctx.strokeStyle = MA;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        var started = false;
        for (var m = 0; m < n; m++) {
            if (m + 1 < 5) continue;
            var sum = 0;
            for (var q = 0; q < 5; q++) sum += rows[m - q].amount;
            var xm = xOf(m), ym = yOf(sum / 5);
            if (!started) { ctx.moveTo(xm, ym); started = true; }
            else ctx.lineTo(xm, ym);
        }
        ctx.stroke();

        // 横轴日期
        ctx.fillStyle = AXIS;
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(shortDay(rows[0].date), left, h - 6);
        ctx.textAlign = 'center';
        ctx.fillText(shortDay(rows[Math.floor(n / 2)].date), xOf(Math.floor(n / 2)), h - 6);
        ctx.textAlign = 'right';
        ctx.fillText(shortDay(rows[n - 1].date), right, h - 6);

        // 图例
        ctx.textAlign = 'left';
        ctx.font = '10px sans-serif';
        ctx.fillStyle = AXIS;
        ctx.fillText('近 ' + n + ' 日两市成交额 · ', left + 4, top + 10);
        ctx.fillStyle = MA;
        ctx.fillText('— 5日均量', left + 4 + ctx.measureText('近 ' + n + ' 日两市成交额 · ').width + 6, top + 10);

        // 十字线
        if (this._crossB >= 0 && this._crossB < n) {
            var x = xOf(this._crossB);
            ctx.strokeStyle = CROSS;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(x, top);
            ctx.lineTo(x, top + plotH);
            ctx.stroke();
            ctx.setLineDash([]);
        }
    },

    drawEmpty: function (ctx, w, h, msg) {
        ctx.fillStyle = AXIS;
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(msg, w / 2, h / 2);
    },

    // ---------- 触摸读数 ----------

    onFlowStart: function (e) { this.setFlowCross(e); },
    onFlowMove: function (e) { this.setFlowCross(e); },
    onFlowEnd: function () {
        this._crossF = -1;
        this.setData({ flowCross: null });
        this.drawFlow();
    },

    setFlowCross: function (e) {
        var t = e.touches && e.touches[0];
        var f = this._flow;
        if (!t || !f || !f.slots || !f.slots.length) return;
        var w = this._canvases.flowChart.w;
        var AXIS_W = 44;
        var plotW = w - AXIS_W - 8;
        var n = f.slots.length;
        var idx = Math.round((t.x - AXIS_W) / plotW * (n - 1));
        idx = Math.max(0, Math.min(n - 1, idx));
        this._crossF = idx;
        var patch = {
            t: f.slots[idx],
            prevText: yi(f.prev[idx]),
            todayText: f.today[idx] === null ? '未到' : yi(f.today[idx]),
            ratioText: (f.today[idx] !== null && f.prev[idx] > 0)
                ? fmt.pct((f.today[idx] / f.prev[idx] - 1) * 100)
                : '--'
        };
        patch.cls = (f.today[idx] !== null && f.prev[idx] > 0)
            ? fmt.cls(f.today[idx] / f.prev[idx] - 1)
            : 'flat';
        this.setData({ flowCross: patch });
        this.drawFlow();
    },

    onBarStart: function (e) { this.setBarCross(e); },
    onBarMove: function (e) { this.setBarCross(e); },
    onBarEnd: function () {
        this._crossB = -1;
        this.setData({ barsCross: null });
        this.drawBars();
    },

    setBarCross: function (e) {
        var t = e.touches && e.touches[0];
        var rows = this._daily;
        if (!t || !rows || !rows.length) return;
        var w = this._canvases.barChart.w;
        var AXIS_W = 44;
        var plotW = w - AXIS_W - 8;
        var n = rows.length;
        var idx = Math.floor((t.x - AXIS_W) / plotW * n);
        idx = Math.max(0, Math.min(n - 1, idx));
        this._crossB = idx;
        var r = rows[idx];
        var sum = 0;
        var cnt = 0;
        for (var q = 0; q < 5 && idx - q >= 0; q++) {
            sum += rows[idx - q].amount;
            cnt++;
        }
        var ma = cnt ? sum / cnt : 0;
        this.setData({
            barsCross: {
                date: r.date,
                amountText: yi(r.amount),
                pctText: fmt.isNum(r.pct) ? fmt.pct(r.pct) : '--',
                cls: fmt.cls(r.pct),
                maText: ma > 0 ? fmt.pct((r.amount / ma - 1) * 100) : '--'
            }
        });
        this.drawBars();
    }
});
