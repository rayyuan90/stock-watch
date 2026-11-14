var sighist = require('../../utils/sighist');
var fmt = require('../../utils/format');

var GRID = 'rgba(255,255,255,0.07)';
var AXIS = '#5f6c7d';
var ZERO = 'rgba(255,255,255,0.35)';
var UP = '255,107,109';   // 正 → 红
var DOWN = '47,214,124';  // 负 → 绿
var CROSS = 'rgba(255,255,255,0.55)';

var SHOW = 20; // 最多展示最近 20 个交易日

function rgba(rgb, a) {
    return 'rgba(' + rgb + ',' + a + ')';
}

Page({
    data: {
        loading: true,
        empty: false,
        stats: null,
        rows: [],
        cross: null,
        updatedAt: '--:--:--'
    },

    onLoad: function () {
        this._recs = [];
        this._crossIdx = -1;
        var self = this;
        wx.nextTick(function () {
            self.initCanvas();
        });
        this.refresh();
        // 云端合并：重新发布/换设备后本地被清，从 sig_hist 表找回全部历史
        sighist.sync().then(function () {
            return self.refresh();
        }).catch(function () { });
    },

    onPullDownRefresh: function () {
        this.refresh().then(function () {
            wx.stopPullDownRefresh();
        }).catch(function () {
            wx.stopPullDownRefresh();
        });
    },

    refresh: function () {
        var self = this;
        var list = sighist.load();
        var recs = [];
        for (var i = 0; i < list.length; i++) {
            if (isFinite(Number(list[i].score))) recs.push(list[i]);
        }
        recs = recs.slice(-SHOW);
        this._recs = recs;
        var rows = [];
        for (var j = recs.length - 1; j >= 0; j--) {
            var it = recs[j];
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
                realText: fmt.isNum(it.real) ? (it.real > 0 ? '+' : '') + it.real.toFixed(0) : '--',
                hitText: hit === null ? '—' : (hit ? '命中' : '偏离'),
                hitCls: hit === null ? 'flat' : (hit ? 'ok' : 'bad')
            });
        }
        this.setData({
            loading: false,
            empty: recs.length === 0,
            stats: sighist.stats(list),
            rows: rows,
            updatedAt: fmt.clock(new Date())
        });
        this.draw();
        return Promise.resolve();
    },

    initCanvas: function () {
        var self = this;
        var query = wx.createSelectorQuery();
        query.select('#accChart').fields({ node: true, size: true });
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
            self._ctx.scale(dpr, dpr);
            self.draw();
        });
    },

    // ---------- 绘制：双柱 + 0 轴 ----------

    draw: function () {
        if (!this._ctx) return;
        var ctx = this._ctx;
        var w = this._cw;
        var h = this._ch;
        ctx.clearRect(0, 0, w, h);
        var recs = this._recs;
        if (!recs.length) {
            ctx.fillStyle = AXIS;
            ctx.font = '12px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('暂无记录：每天 15:00 收盘后自动记录当日预测', w / 2, h / 2 - 8);
            ctx.fillText('次日 9:30 后自动记录真实开盘，逐日积累', w / 2, h / 2 + 12);
            return;
        }

        var AXIS_W = 34;
        var left = AXIS_W;
        var right = w - 8;
        var top = 8;
        var plotH = h - top - 24;
        var n = recs.length;
        var gw = (right - left) / n;
        var yOf = function (v) { return top + (1 - (v + 100) / 200) * plotH; };

        // 网格：+100 / +50 / 0 / -50 / -100
        var levels = [100, 50, 0, -50, -100];
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
            ctx.fillText(levels[g] > 0 ? '+' + levels[g] : String(levels[g]), AXIS_W - 4, gy + 3);
        }

        // 双柱：预测（半透明） + 真实（实心）
        for (var i = 0; i < n; i++) {
            var r = recs[i];
            var gx = left + i * gw;
            var bw = gw * 0.32;
            var zeroY = yOf(0);

            // 预测柱
            var s = Number(r.score);
            var sCol = s >= 0 ? UP : DOWN;
            var sh = Math.max(2, Math.abs(yOf(s) - zeroY));
            ctx.fillStyle = rgba(sCol, 0.45);
            ctx.fillRect(gx + gw * 0.10, s >= 0 ? yOf(s) : zeroY, bw, sh);
            ctx.strokeStyle = rgba(sCol, 0.9);
            ctx.lineWidth = 1;
            ctx.strokeRect(gx + gw * 0.10 + 0.5, (s >= 0 ? yOf(s) : zeroY) + 0.5, bw - 1, sh - 1);

            // 真实柱（次日开盘，未开盘则无）
            if (fmt.isNum(r.real)) {
                var rv = Number(r.real);
                var rCol = rv >= 0 ? UP : DOWN;
                var rh = Math.max(2, Math.abs(yOf(rv) - zeroY));
                ctx.fillStyle = rgba(rCol, 0.92);
                ctx.fillRect(gx + gw * 0.52, rv >= 0 ? yOf(rv) : zeroY, bw, rh);
            }
        }

        // 横轴日期（首 / 中 / 尾）
        ctx.fillStyle = AXIS;
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(String(recs[0].date).slice(5, 10), left, h - 8);
        ctx.textAlign = 'center';
        ctx.fillText(String(recs[Math.floor(n / 2)].date).slice(5, 10), left + gw * Math.floor(n / 2) + gw / 2, h - 8);
        ctx.textAlign = 'right';
        ctx.fillText(String(recs[n - 1].date).slice(5, 10), right, h - 8);

        // 图例（与柱样式严格一致：预测=半透明+描边，真实=实心；颜色仅表示正负方向）
        ctx.textAlign = 'left';
        ctx.font = '10px sans-serif';
        var lg1 = left + 4;
        var lg2 = left + 110;
        var ly = top + 2;
        // 预测 swatch
        ctx.fillStyle = rgba(UP, 0.45);
        ctx.fillRect(lg1, ly, 8, 8);
        ctx.strokeStyle = rgba(UP, 0.9);
        ctx.lineWidth = 1;
        ctx.strokeRect(lg1 + 0.5, ly + 0.5, 7, 7);
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.fillText('预测(收盘后)', lg1 + 14, ly + 8);
        // 真实 swatch
        ctx.fillStyle = rgba(UP, 0.92);
        ctx.fillRect(lg2, ly, 8, 8);
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.fillText('真实(次日开盘)', lg2 + 14, ly + 8);

        // 十字线
        if (this._crossIdx >= 0 && this._crossIdx < n) {
            var cx = left + this._crossIdx * gw + gw / 2;
            ctx.strokeStyle = CROSS;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(cx, top);
            ctx.lineTo(cx, top + plotH);
            ctx.stroke();
            ctx.setLineDash([]);
        }
    },

    // ---------- 触摸读数 ----------

    onStart: function (e) { this.setCross(e); },
    onMove: function (e) { this.setCross(e); },
    onEnd: function () {
        this._crossIdx = -1;
        this.setData({ cross: null });
        this.draw();
    },

    setCross: function (e) {
        var t = e.touches && e.touches[0];
        var recs = this._recs;
        if (!t || !recs.length || !this._cw) return;
        var AXIS_W = 34;
        var left = AXIS_W;
        var right = this._cw - 8;
        var n = recs.length;
        var gw = (right - left) / n;
        var idx = Math.floor((t.x - left) / gw);
        idx = Math.max(0, Math.min(n - 1, idx));
        this._crossIdx = idx;
        var r = recs[idx];
        var hit = null;
        if (fmt.isNum(r.openPct) && Math.abs(r.score) >= 10) {
            hit = (r.score > 0 && r.openPct > 0) || (r.score < 0 && r.openPct < 0);
        }
        this.setData({
            cross: {
                date: r.date,
                scoreText: (r.score > 0 ? '+' : '') + r.score,
                scoreCls: r.score > 0 ? 'up' : r.score < 0 ? 'down' : 'flat',
                openText: fmt.isNum(r.openPct) ? fmt.pct(r.openPct) : '待开盘',
                openCls: fmt.isNum(r.openPct) ? fmt.cls(r.openPct) : 'flat',
                hitText: hit === null ? '待验证' : (hit ? '方向命中' : '方向偏离'),
                hitCls: hit === null ? 'flat' : (hit ? 'ok' : 'bad')
            }
        });
        this.draw();
    }
});
