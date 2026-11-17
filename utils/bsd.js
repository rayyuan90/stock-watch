/**
 * 板块成分股数据层（独立新增）
 * 东财 clist：fs=b:BKxxxx，fid=f3 按涨跌幅排序
 *   po=1 涨幅降序（涨幅前30）；po=0 升序（跌幅前30）
 * f2 现价  f3 涨跌幅%  f5 成交量  f12 代码  f13 市场(0深/1沪)  f14 名称  f62 主力净流入
 */

var EM = 'https://push2.eastmoney.com/api/qt';
var TIMEOUT = 8000;

function num(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
}

function req(url) {
    return new Promise(function (resolve) {
        var done = false;
        var finish = function (res) {
            if (done) return;
            done = true;
            resolve(res);
        };
        var timer = setTimeout(function () { finish({ ok: false, error: '超时' }); }, TIMEOUT);
        try {
            wx.request({
                url: url,
                method: 'GET',
                timeout: TIMEOUT,
                header: { 'User-Agent': 'Mozilla/5.0' },
                success: function (res) {
                    clearTimeout(timer);
                    if (res && res.statusCode === 200 && res.data) finish({ ok: true, data: res.data });
                    else finish({ ok: false, error: 'HTTP ' + (res && res.statusCode) });
                },
                fail: function (e) {
                    clearTimeout(timer);
                    finish({ ok: false, error: (e && e.errMsg) || '请求失败' });
                }
            });
        } catch (e) {
            clearTimeout(timer);
            finish({ ok: false, error: (e && e.message) || '请求异常' });
        }
    });
}

/**
 * 板块成分股列表（按涨跌幅排序）
 * @param bkCode 板块代码，如 BK1239
 * @param dir 'up' 涨幅前N | 'down' 跌幅前N
 * @param pz 数量，默认 30
 * @returns Promise<{total, stocks:[{secid,code,name,price,pct,flow}], ts}>
 */
function fetchBoardStocks(bkCode, dir, pz) {
    var po = dir === 'down' ? 0 : 1;
    var n = pz || 30;
    var url = EM + '/clist/get?pn=1&pz=' + n + '&po=' + po + '&np=1&fltt=2&invt=2&fid=f3'
        + '&fs=b:' + bkCode + '&fields=f2,f3,f5,f12,f13,f14,f62';
    return req(url).then(function (res) {
        if (!res.ok) throw new Error(res.error);
        var body = res.data;
        if (typeof body === 'string') {
            try { body = JSON.parse(body); } catch (e) { throw new Error('解析失败'); }
        }
        var d = body && body.data;
        var diff = d && d.diff;
        if (!diff || !diff.length) throw new Error('该板块暂无成分股数据');
        var stocks = [];
        for (var i = 0; i < diff.length; i++) {
            var x = diff[i];
            var pct = num(x.f3);
            var price = num(x.f2);
            if (pct === null || price === null) continue; // 停牌/无成交
            stocks.push({
                secid: x.f13 + '.' + x.f12,
                code: x.f12,
                name: x.f14,
                price: price,
                pct: pct,
                flow: num(x.f62)
            });
        }
        if (!stocks.length) throw new Error('该板块暂无有效行情');
        return { total: num(d.total) || stocks.length, stocks: stocks, ts: Date.now() };
    });
}

module.exports = {
    fetchBoardStocks: fetchBoardStocks
};
