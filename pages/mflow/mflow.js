var heat = require('../../utils/heat');

var REFRESH_MS = 30 * 1000;

Page({
    data: {
        items: [],      // 四类合计（沪深两市）
        parts: [],      // 分市场明细
        updatedAt: '',
        stateText: '加载中',
        offlineMsg: ''
    },

    _timer: null,

    onLoad: function () {
        this.refresh();
        this.startTimer();
    },

    onUnload: function () { this.stopTimer(); },
    onHide: function () { this.stopTimer(); },
    onShow: function () { this.startTimer(); },

    onPullDownRefresh: function () {
        var self = this;
        this.refresh().then(function () { wx.stopPullDownRefresh(); })
            .catch(function () { wx.stopPullDownRefresh(); });
    },

    startTimer: function () {
        var self = this;
        if (this._timer) return;
        this._timer = setInterval(function () { self.refresh(); }, REFRESH_MS);
    },

    stopTimer: function () {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    },

    refresh: function () {
        var self = this;
        if (this._busy) return Promise.resolve();
        this._busy = true;
        this.setData({ stateText: '刷新中' });

        return heat.getFlow().then(function (res) {
            self._busy = false;
            var items = res.items.map(function (it) {
                return {
                    key: it.key,
                    label: it.label,
                    sub: it.sub,
                    dot: it.dot,
                    cls: it.val > 0 ? 'up' : (it.val < 0 ? 'down' : ''),
                    valText: heat.fmtFlow(it.val)
                };
            });
            var parts = res.parts.map(function (p) {
                var mk = function (v) {
                    return { text: v, cls: v.charAt(0) === '+' ? 'up' : (v.charAt(0) === '-' ? 'down' : '') };
                };
                return {
                    name: p.name,
                    main: mk(p.main),
                    inst: mk(p.inst),
                    big: mk(p.big),
                    retail: mk(p.retail)
                };
            });
            self.setData({
                items: items,
                parts: parts,
                updatedAt: res.updatedAt,
                stateText: res.fromCache ? '缓存' : '实时',
                offlineMsg: res.fromCache
                    ? '行情源暂时不可用，显示的是本地缓存（' + res.updatedAt + '）'
                    : ''
            });
        }).catch(function (e) {
            self._busy = false;
            var emsg = ((e && e.message) || '');
            // 东财接口偶发返回空（真机常见 -324 / ERR_EMPTY_RESPONSE），是服务端限流，不是域名问题
            var tip = /EMPTY_RESPONSE|-324|request:fail|HTTP/i.test(emsg)
                ? '行情源暂时无响应（接口限流），请下拉重试'
                : '资金流暂时不可用：' + (emsg || '未知错误');
            self.setData({
                stateText: '重试',
                offlineMsg: tip
            });
        });
    }
});
