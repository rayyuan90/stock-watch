var bsd = require('../../utils/bsd');

Page({
    data: {
        bk: '',
        bkName: '',
        dir: 'up',          // up 涨幅前30 | down 跌幅前30
        stocks: [],
        total: 0,
        stateText: '加载中',
        err: '',
        updatedAt: ''
    },

    onLoad: function (query) {
        this.setData({
            bk: query.bk || '',
            bkName: decodeURIComponent(query.name || '板块成分股'),
            dir: query.dir === 'down' ? 'down' : 'up'
        });
        wx.setNavigationBarTitle({ title: this.data.bkName });
        this.refresh();
    },

    onPullDownRefresh: function () {
        var self = this;
        this.refresh().then(function () { wx.stopPullDownRefresh(); })
            .catch(function () { wx.stopPullDownRefresh(); });
    },

    refresh: function () {
        var self = this;
        if (!this.data.bk) return Promise.resolve();
        if (this._busy) return Promise.resolve();
        this._busy = true;
        this.setData({ stateText: '刷新中' });

        return bsd.fetchBoardStocks(this.data.bk, this.data.dir, 30).then(function (res) {
            self._busy = false;
            var stocks = res.stocks.map(function (s) {
                return {
                    secid: s.secid,
                    code: s.code,
                    name: s.name,
                    priceText: s.price.toFixed(2),
                    pctText: (s.pct > 0 ? '+' : '') + s.pct.toFixed(2) + '%',
                    cls: s.pct > 0 ? 'up' : (s.pct < 0 ? 'down' : ''),
                    flowText: s.flow === null ? '--' : (s.flow > 0 ? '+' : '') + (Math.abs(s.flow) >= 1e8
                        ? (s.flow / 1e8).toFixed(2) + '亿'
                        : (s.flow / 1e4).toFixed(0) + '万')
                };
            });
            var now = new Date();
            var p2 = function (n) { return n < 10 ? '0' + n : '' + n; };
            self.setData({
                stocks: stocks,
                total: res.total,
                stateText: '实时',
                err: '',
                updatedAt: p2(now.getHours()) + ':' + p2(now.getMinutes())
            });
        }).catch(function (e) {
            self._busy = false;
            self.setData({
                stateText: '不可用',
                err: '成分股请求失败：' + ((e && e.message) || '未知错误')
            });
        });
    },

    openStock: function (e) {
        var secid = e.currentTarget.dataset.secid;
        var name = e.currentTarget.dataset.name;
        if (!secid) return;
        wx.navigateTo({
            url: '/pages/sdetail/sdetail?secid=' + secid
                + '&name=' + encodeURIComponent(name)
                + '&bk=' + encodeURIComponent(this.data.bkName)
        });
    }
});
