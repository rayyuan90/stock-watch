var heat = require('../../utils/heat');

var REFRESH_MS = 30 * 1000;

Page({
    data: {
        tab: 'ind',        // ind 行业 | con 概念
        dir: 'up',         // up 涨幅前十 | down 跌幅前十
        tiles: [],
        updatedAt: '',
        stateText: '加载中',
        offlineMsg: '',
        loading: false
    },

    _timer: null,

    onLoad: function () {
        this.refresh(true);
        this.startTimer();
    },

    onUnload: function () {
        this.stopTimer();
    },

    onHide: function () {
        this.stopTimer();
    },

    onShow: function () {
        this.startTimer();
    },

    onPullDownRefresh: function () {
        var self = this;
        this.refresh(true).then(function () {
            wx.stopPullDownRefresh();
        }).catch(function () {
            wx.stopPullDownRefresh();
        });
    },

    startTimer: function () {
        var self = this;
        if (this._timer) return;
        this._timer = setInterval(function () {
            self.refresh(false);
        }, REFRESH_MS);
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
        this.refresh(true);
    },

    setDir: function (e) {
        var dir = e.currentTarget.dataset.dir;
        if (dir === this.data.dir) return;
        this.setData({ dir: dir });
        this.refresh(false);
    },

    openBoard: function (e) {
        var code = e.currentTarget.dataset.code;
        var name = e.currentTarget.dataset.name || '';
        if (!code) return;
        wx.navigateTo({
            url: '/pages/bstock/bstock?bk=' + code
                + '&name=' + encodeURIComponent(name)
                + '&dir=' + this.data.dir
        });
    },

    refresh: function (showState) {
        var self = this;
        if (this._busy) return Promise.resolve();
        this._busy = true;
        if (showState) this.setData({ stateText: '刷新中' });

        return heat.getHeat(this.data.tab, this.data.dir).then(function (res) {
            self._busy = false;
            self.setData({
                tiles: res.tiles,
                updatedAt: res.updatedAt,
                stateText: res.fromCache ? '缓存' : '实时',
                offlineMsg: res.fromCache
                    ? '行情源暂时不可用，显示的是本地缓存（' + res.updatedAt + '）'
                    : ''
            });
        }).catch(function (e) {
            self._busy = false;
            self.setData({
                stateText: '不可用',
                offlineMsg: '行情请求失败：' + ((e && e.message) || '未知错误')
            });
        });
    }
});
