var market = require('../../utils/market');
var watch = require('../../utils/watch');
var watchSync = require('../../utils/watchSync');

// 常用标的，点一下就能加，不用记代码
var QUICK = [
    { grp: '纳指 / 美股期货', items: [
        { sec: '103.NQ00Y', name: '小型纳指当月连续', type: '期货' },
        { sec: '103.ES00Y', name: '小型标普当月连续', type: '期货' },
        { sec: '103.YM00Y', name: '小型道指当月连续', type: '期货' }
    ] },
    { grp: '美股半导体', items: [
        { sec: '105.NVDA', name: '英伟达', type: '美股' },
        { sec: '106.TSM', name: '台积电', type: '美股' },
        { sec: '105.AMD', name: '超威半导体', type: '美股' },
        { sec: '105.AVGO', name: '博通', type: '美股' },
        { sec: '105.ASML', name: '阿斯麦', type: '美股' },
        { sec: '105.MU', name: '美光科技', type: '美股' },
        { sec: '105.SKHY', name: 'SK海力士(美股)', type: '美股' },
        { sec: '105.SOXX', name: '半导体ETF SOXX', type: '美股' }
    ] },
    { grp: '韩国 / 指数', items: [
        { sec: '177.000660', name: 'SK海力士', type: '韩股' },
        { sec: '177.005930', name: '三星电子', type: '韩股' },
        { sec: '100.KS11', name: '韩国KOSPI', type: '指数' },
        { sec: '100.NDX', name: '纳斯达克', type: '指数' }
    ] },
    { grp: 'A股 / ETF', items: [
        { sec: '1.688825', name: '长鑫科技', type: 'A股' },
        { sec: '1.513310', name: '中韩半导体ETF', type: '基金' },
        { sec: '0.159995', name: '芯片ETF华夏', type: '基金' },
        { sec: '1.512480', name: '半导体ETF国联安', type: '基金' },
        { sec: '1.588000', name: '科创50ETF', type: '基金' },
        { sec: '1.600519', name: '贵州茅台', type: 'A股' }
    ] }
];

Page({
    data: {
        keyword: '',
        searching: false,
        searchErr: '',
        results: [],
        quick: QUICK,
        watch: [],
        max: watch.MAX,
        syncLabel: '仅本机',
        tip: ''
    },

    onLoad: function () {
        this.setData({
            watch: watch.load(),
            syncLabel: watchSync.statusText()
        });
        market.setExtras(watch.secs());
        this.pullCloud();
    },

    /** 进入页面时拉一次云端自选（换设备后能直接看到） */
    pullCloud: function () {
        var self = this;
        watchSync.sync().then(function (res) {
            self.setData({ syncLabel: res && res.reason === 'nologin' ? '仅本机' : watchSync.statusText() });
            if (res && res.changed) {
                market.setExtras(watch.secs());
                self.setData({
                    watch: watch.load(),
                    results: self.decorate(self.data.results)
                });
            }
        }).catch(function () { /* 静默 */ });
    },

    onSyncTap: function () {
        var self = this;
        wx.showLoading({ title: '同步中', mask: true });
        watchSync.sync().then(function (res) {
            wx.hideLoading();
            self.setData({ syncLabel: res.reason === 'nologin' ? '仅本机' : watchSync.statusText() });
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
                wx.showToast({ title: res.error || '同步失败', icon: 'none' });
                return;
            }
            if (res.changed) {
                market.setExtras(watch.secs());
                self.setData({ watch: watch.load(), results: self.decorate(self.data.results) });
            }
            wx.showToast({ title: '已同步', icon: 'none', duration: 1000 });
        }).catch(function () {
            wx.hideLoading();
            wx.showToast({ title: '同步失败', icon: 'none' });
        });
    },

    onInput: function (e) {
        var kw = e.detail.value || '';
        this.setData({ keyword: kw, tip: '' });
        this.scheduleSearch(kw);
    },

    scheduleSearch: function (kw) {
        var self = this;
        if (this._timer) clearTimeout(this._timer);
        var q = String(kw || '').trim();
        if (!q) {
            this.setData({ results: [], searchErr: '', searching: false });
            return;
        }
        this._timer = setTimeout(function () {
            self.doSearch(q);
        }, 350);
    },

    onSearchTap: function () {
        var q = String(this.data.keyword || '').trim();
        if (!q) {
            this.setData({ tip: '输入名称或代码，例如 台积电 / TSM / 513310' });
            return;
        }
        this.doSearch(q);
    },

    doSearch: function (q) {
        var self = this;
        this.setData({ searching: true, searchErr: '' });
        market.searchSymbol(q).then(function (list) {
            self.setData({ searching: false, results: self.decorate(list) });
            if (!list.length) {
                self.setData({ searchErr: '没搜到，可以直接输入代码（如 105.NVDA）后点「添加」' });
            }
        }).catch(function (e) {
            self.setData({
                searching: false,
                results: [],
                searchErr: (market.friendly(e && e.message)) + '，可直接输入代码后点「添加」'
            });
        });
    },

    decorate: function (list) {
        var cur = this.data.watch || [];
        var out = [];
        for (var i = 0; i < (list || []).length; i++) {
            var it = list[i];
            var added = false;
            for (var j = 0; j < cur.length; j++) {
                if (cur[j].sec === it.sec) { added = true; break; }
            }
            out.push({
                sec: it.sec,
                code: it.code,
                name: it.name,
                type: it.type || '',
                added: added
            });
        }
        return out;
    },

    /** 直接按输入添加（走本地代码解析，搜索域名被拦也能用） */
    onAddInput: function () {
        var self = this;
        var q = String(this.data.keyword || '').trim();
        if (!q) {
            this.setData({ tip: '先输入代码或名称' });
            return;
        }
        this.setData({ searching: true, tip: '' });
        market.resolveSymbol(q).then(function (list) {
            self.setData({ searching: false });
            if (!list || !list.length) {
                self.setData({ tip: '没找到「' + q + '」' });
                return;
            }
            self.commit(list[0]);
        }).catch(function (e) {
            self.setData({
                searching: false,
                tip: (e && e.message) || '没找到这个标的'
            });
        });
    },

    onAddResult: function (e) {
        var d = e.currentTarget.dataset;
        this.commit({ sec: d.sec, code: d.code, name: d.name, type: d.type });
    },

    onAddQuick: function (e) {
        var d = e.currentTarget.dataset;
        this.commit({ sec: d.sec, code: d.code, name: d.name, type: d.type });
    },

    commit: function (item) {
        var res = watch.add(item);
        market.setExtras(watch.secs());
        this.setData({
            watch: res.list,
            results: this.decorate(this.data.results),
            keyword: '',
            tip: res.message
        });
        wx.showToast({ title: res.message, icon: res.ok ? 'none' : 'none', duration: 1200 });
        if (res.ok) {
            // 纠正名称：以接口返回为准
            this.refine(item.sec);
            this.pushCloud();
        }
    },

    /** 本地改动后立刻推云端（未登录/失败保留待同步标记） */
    pushCloud: function () {
        var self = this;
        watchSync.push().then(function () {
            self.setData({ syncLabel: watchSync.statusText() });
        });
    },

    refine: function (sec) {
        var self = this;
        market.fetchQuote(sec).then(function (q) {
            if (!q || !q.name) return;
            var list = watch.load();
            var changed = false;
            for (var i = 0; i < list.length; i++) {
                if (list[i].sec === sec && list[i].name !== q.name) {
                    list[i].name = q.name;
                    changed = true;
                }
            }
            if (changed) {
                self.setData({ watch: watch.save(list) });
                self.pushCloud();
            }
        }).catch(function () { });
    },

    onRemove: function (e) {
        var sec = e.currentTarget.dataset.sec;
        var self = this;
        wx.showModal({
            title: '移出自选',
            content: '不再盯这个标的？',
            confirmColor: '#ff6b6d',
            success: function (r) {
                if (!r.confirm) return;
                var list = watch.remove(sec);
                market.setExtras(watch.secs());
                self.setData({ watch: list, results: self.decorate(self.data.results), tip: '已移出' });
                self.pushCloud();
            }
        });
    },

    clearKeyword: function () {
        this.setData({ keyword: '', results: [], searchErr: '', tip: '' });
    },

    goDetail: function (e) {
        var d = e.currentTarget.dataset;
        if (!d.sec) return;
        wx.navigateTo({
            url: '/pages/detail/detail?sec=' + encodeURIComponent(d.sec) + '&name=' + encodeURIComponent(d.name || '')
        });
    }
});
