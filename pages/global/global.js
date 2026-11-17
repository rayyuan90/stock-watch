var globalMod = require('../../utils/global');

Page({
    data: {
        groups: [],
        clock: '',
        stateText: '加载中',
        warn: '',
        cacheOnly: false,
        loading: false
    },

    onLoad: function () {
        var view = globalMod.loadCacheView();
        this.setData({
            groups: view.groups,
            clock: view.clock,
            stateText: view.ts ? '缓存' : '加载中',
            warn: view.warn || ''
        });
        this.refresh();
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
            self.refresh();
        }, 20000);
    },

    stopTimer: function () {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    },

    onPullDownRefresh: function () {
        this.refresh();
    },

    refresh: function () {
        var self = this;
        if (this._loading) return Promise.resolve();
        this._loading = true;
        this.setData({ loading: true });
        return globalMod.fetchAll().then(function (res) {
            self._loading = false;
            self.setData({
                groups: res.groups,
                clock: res.clock,
                warn: res.warn || '',
                cacheOnly: !!res.cacheOnly,
                stateText: res.cacheOnly ? '离线缓存' : '实时',
                loading: false
            });
            wx.stopPullDownRefresh();
        }).catch(function () {
            self._loading = false;
            self.setData({ loading: false, stateText: '拉取失败' });
            wx.stopPullDownRefresh();
        });
    },

    /** 复制外盘期货数据源域名，方便去小程序后台加白名单 */
    openDetail: function (e) {
        var key = e.currentTarget.dataset.key;
        if (!key) return;
        wx.navigateTo({ url: '/pages/gdetail/gdetail?key=' + key });
    },

    copyDomain: function () {
        wx.setClipboardData({
            data: 'hq.sinajs.cn',
            success: function () {
                wx.showToast({ title: '已复制 hq.sinajs.cn', icon: 'none', duration: 1600 });
            }
        });
    }
});
