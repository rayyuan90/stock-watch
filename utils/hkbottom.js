/**
 * 港股科技 · 底部研判【计算引擎】（数据驱动版）
 * ==================================================================
 * 设计原则：结论不写死，全部由输入数据算出来。数据一变，状态 / 到达度 /
 * 概率 / 证据文案全部跟着变；换季度只要财报数据更新，叙事底自动重算。
 *
 * 数据来源分两类：
 *  A. 实时/高频（每次进页面异步拉取，见 market.fetchHkBottomData）
 *     - 恒科报价：点位 / 涨跌幅 / 盘中低 / 成交额
 *     - 恒科日K：连跌天数、距阶段高点回撤、区间振幅、缩量
 *     - 南向净买入历史：连续净流入天数、近N日流入/流出统计、单日极值
 *     - 腾讯财报（季度）：营收/利润增速、经营现金流、投资现金流、净利率
 *  B. 低频研报数据（无免费接口，带 asOf 日期，随数据文件更新）
 *     - 估值 PE/PB 及历史分位、外资持仓与主动低配、基金口径等
 *     这些字段标记 asOf，界面显示数据日期，用户更新后自动重算。
 *
 * 三层底判定规则（阈值集中在此，易调）：
 *  - 估值底：PE 历史分位 < 10% → 已到(100%)；< 20% → 磨底；否则未到
 *  - 资金底：南向连续净流入天数 + 近N日净流入占比 + 主动低配 → 综合到达度
 *  - 叙事底：资本开支环比方向 + 经营/投资现金流净额 + 利润增速 → 综合到达度
 *  权重体现「低估值 ≠ 底」：估值20 / 资金30 / 叙事50。
 */

var AS_OF = '2026-11-19';

// ---------- 低频研报输入（无免费接口；更新数值即可自动重算） ----------
var MANUAL = {
    asOf: '2026-11-19',
    valuation: {
        peLow: 19.07, peHigh: 19.77, pePct5y: 6.51, pePctSince2010: 9,
        pb: 2.05, pbPctSince2010: 7,
        refPoint: 2720, refDate: '2022/10', refPeLow: 20, refPeHigh: 23,
        histPeakPe: 48, histCutPe: 37, histEpisode: '2021–2022'
    },
    capital: {
        reportQuarter: '2026 Q3',   // 外资持仓/低配数据的实际报告期（研报明确写三季度）
        foreignHoldWanYi: 16.9, foreignShare: 56, foreignSharePrev: 55,
        longInflowYi: 861, shortOutflowYi: 908,
        chinaUnderweightPct: 1.0, emUnderweightPct: 1.8,
        ubsFunds: 800, ubsUnderweightFunds: 495, ubsAumWanYi: 2.5, ubsUnderweightPct: 3.5,
        epfWeeksOut: 6,
        southAugInUSD: 13, southJulInUSD: 80, southYtdUSD: 480, southYtdYoy: 0.39
    },
    narrative: {
        // 腾讯研报快照（资本开支口径财报接口拿不到，换季更新数值 + reportQuarter）
        reportQuarter: 3,
        tencentRevenueYoy: 8,
        capexYi: 814.33, capexYoy: 527, capexQoq: 54, capexConsensusYi: 554,
        capexYtdYi: 1661.53, capexYtdYoy: 179,
        fcfNetYi: -691, operateCashYi: 26, capexPaidYi: 651, fcfExPrepayYi: 169,
        opProfitAdjYi: 680.73, opProfitAdjYoy: -6, opProfitPrevYoy: 9,
        alibabaCapexUSD: 99.4, alibabaFcfQUSD: -65.7, alibabaFcfYUSD: -71.4,
        mgmtQuote: '不投入拥抱就是被颠覆，这是生死存亡的问题'
    },
    etf: {
        code: '513050', discLow: 1.69, discHigh: 3.62, discDate: '11/12',
        sharesLow: 357.5, sharesHigh: 371.7, sharesFrom: '11/6', sharesTo: '11/17', sharesHighDays: 60
    },
    // 信号清单里的低频快照数值（无免费接口；更新时改这里）
    snap: {
        ust10y: '5.1%–5.3%',
        cpiNote: '通胀超预期是这波回吐触发',
        southTurnoverPct: 37.04,
        aliEbitaPct: 9,
        aliReportWindow: '报告期后约 1–2 个月',
        indexReview: { announce: '2026/11/20', effect: '2026/12/07', from: 30, to: 50 }
    }
};

var WEIGHTS = { valuation: 20, capital: 30, narrative: 50 };
var THRESHOLD = {
    peDonePct: 10, peGrindPct: 20,       // 估值底：分位阈值
    southDoneDays: 5, southDoneYi: 50,   // 资金底：连续净流入天数 / 单日额阈值
    fcfDoneYi: 0, capexPeakDropPct: -5   // 叙事底：FCF 转正 / 资本开支环比回落阈值
};

function num(v, dflt) {
    var n = Number(v);
    return isFinite(n) ? n : dflt;
}
function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}
function sign(v, digits) {
    var n = num(v, null);
    if (n === null) return '--';
    var s = (n > 0 ? '+' : '') + n.toFixed(digits === undefined ? 2 : digits);
    return s;
}

/**
 * 时间语境：所有「第几季度 / 前几个月 / 去年 / 上月」等时间段标签都从这派生，
 * 绝不写死。默认按当前系统日期；传 asOf 则按数据基准日算。
 * 这样跨年换季时文案自动跟着变，不用改代码。
 */
function timeContext(asOf) {
    var d;
    if (asOf) {
        d = new Date(String(asOf).replace(/-/g, '/'));
        if (isNaN(d.getTime())) d = new Date();
    } else {
        d = new Date();
    }
    var y = d.getFullYear();
    var m = d.getMonth() + 1;
    var q = Math.floor((m - 1) / 3) + 1;
    var prevQ = q === 1 ? 4 : q - 1;
    var prevY = q === 1 ? y - 1 : y;
    var nextQ = q === 4 ? 1 : q + 1;
    var nextY = q === 4 ? y + 1 : y;
    var q2Q = q <= 2 ? q + 2 : q - 2;   // 未来第 2 季度：Q1→Q3, Q2→Q4, Q3→次年Q1, Q4→次年Q2
    var q2Y = q <= 2 ? y : y + 1;
    return {
        year: y, month: m, quarter: q, asOfTs: d.getTime(),
        qLabel: y + ' Q' + q,
        prevQLabel: prevY + ' Q' + prevQ,   // 外资持仓通常滞后一季披露
        nextQLabel: nextY + ' Q' + nextQ,
        q2LaterLabel: q2Y + ' Q' + q2Q,
        lastYear: y - 1,
        monthLabel: m + '月',
        prevMonthLabel: (m === 1 ? 12 : m - 1) + '月',
        // 南向 YTD：1 月显示刚结束的上年全年（前12个月），其余为年内累计
        ytdText: m === 1 ? '前12个月（' + (y - 1) + '年全年）' : '前' + m + '个月'
    };
}

/** 财报累计口径文案：Q1→前三个月，Q2→前半年，Q3→前三季，Q4→全年 */
function ytdByQuarter(q) {
    return q === 1 ? '前三个月' : q === 2 ? '前半年' : q === 3 ? '前三季' : '全年';
}

/** 从财报类型（如「2026年三季报」）解析季度，取不到则用当前季度 */
function financeQuarter(fin, fallback) {
    if (fin && fin.reportType) {
        var s = String(fin.reportType);
        var map = { '一': 1, '二': 2, '三': 3, '四': 4, '1': 1, '2': 2, '3': 3, '4': 4 };
        var hit = s.match(/([一二三四1-4])季/);
        if (hit && map[hit[1]]) return map[hit[1]];
        if (/年报/.test(s)) return 4;
    }
    return fallback;
}

/** 由恒科日K算：连跌天数、距阶段高点回撤、区间振幅、最新成交额 */
function trendMetrics(kline) {
    var rows = (kline && kline.rows) || [];
    var out = { streak: null, drawdown: null, amplitude: null, lastClose: null, low: null, amount: null, highRef: null, highRefDate: null };
    if (!rows.length) return out;
    var closes = rows.map(function (r) { return num(r.close, 0); });
    var last = closes.length - 1;
    out.lastClose = closes[last];
    var streak = 0;
    for (var i = last; i > 0; i--) {
        if (closes[i] < closes[i - 1]) streak++;
        else break;
    }
    out.streak = streak;
    var win = rows.slice(-60);
    var hi = -Infinity, hiIdx = 0;
    for (var j = 0; j < win.length; j++) {
        if (win[j].close > hi) { hi = win[j].close; hiIdx = j; }
    }
    out.highRef = hi === -Infinity ? null : hi;
    out.highRefDate = hi === -Infinity ? null : (win[hiIdx].date || '').slice(5);
    out.drawdown = hi > 0 ? (closes[last] - hi) / hi * 100 : null;
    var w20 = rows.slice(-20);
    var mx = -Infinity, mn = Infinity;
    for (var k = 0; k < w20.length; k++) {
        if (w20[k].high > mx) mx = w20[k].high;
        if (w20[k].low < mn) mn = w20[k].low;
    }
    out.amplitude = isFinite(mx) && mn > 0 ? (mx - mn) / mn * 100 : null;
    var tail = rows[last];
    out.low = num(tail.low, null);
    out.amount = num(tail.amount, null);
    return out;
}

/** 兼容数字数组与 {date,val} 对象数组，抽出每天的数值（单位百万港元） */
function southVals(series) {
    return (series || []).map(function (x) {
        if (x !== null && typeof x === 'object') return Number(x.val);
        return Number(x);
    }).filter(function (v) { return isFinite(v); });
}

/** 由南向净买入序列（每日，单位百万港元）算：连续净流入天数、近N日统计、单日极值 */
function southMetrics(series) {
    var arr = southVals(series);
    var out = { consecutive: 0, inDays: 0, outDays: 0, maxIn: null, maxOut: null, last: null, totalDays: arr.length };
    if (!arr.length) return out;
    out.last = arr[arr.length - 1];
    var streak = 0;
    for (var i = arr.length - 1; i >= 0; i--) {
        if (arr[i] > 0) streak++;
        else break;
    }
    out.consecutive = streak;
    for (var j = 0; j < arr.length; j++) {
        if (arr[j] > 0) out.inDays++;
        else if (arr[j] < 0) out.outDays++;
        if (out.maxIn === null || arr[j] > out.maxIn) out.maxIn = arr[j];
        if (out.maxOut === null || arr[j] < out.maxOut) out.maxOut = arr[j];
    }
    return out;
}

/**
 * 由带日期的南向序列实时算：本月/上月净流入、YTD累计、去年同期累计、同比比值。
 * 接口单位百万港元，÷100 转亿港元。全部随数据日期滚动，不写死。
 */
function southMonthly(series) {
    var rows = (series || []).filter(function (x) { return x && x.date && isFinite(Number(x.val)); });
    if (!rows.length) return null;
    var last = rows[rows.length - 1];
    var parts = last.date.split('-');
    var year = Number(parts[0]), month = Number(parts[1]);
    var curPrefix = year + '-' + (month < 10 ? '0' : '') + month;
    var pm = month === 1 ? 12 : month - 1, py = month === 1 ? year - 1 : year;
    var prevPrefix = py + '-' + (pm < 10 ? '0' : '') + pm;
    var curSum = 0, prevSum = 0, ytd = 0, ytdPrev = 0;
    for (var i = 0; i < rows.length; i++) {
        var d = rows[i].date, v = Number(rows[i].val) / 100; // 亿港元
        if (d.indexOf(curPrefix) === 0) curSum += v;
        if (d.indexOf(prevPrefix) === 0) prevSum += v;
        if (d.indexOf(String(year) + '-') === 0) ytd += v;
        if (d.indexOf(String(year - 1) + '-') === 0 && d.slice(5, 7) <= (month < 10 ? '0' : '') + month) ytdPrev += v;
    }
    return {
        year: year, month: month,
        curYi: curSum, prevYi: prevSum,        // 本月 / 上月（亿港元）
        ytdYi: ytd, ytdPrevYi: ytdPrev,        // 年初至今 / 去年同期
        ytdRatio: ytdPrev > 0 ? ytd / ytdPrev : null,
        lastDate: last.date
    };
}

/** 估值底：由 PE 分位算到达度与状态 */
function evalValuation(v, tm) {
    var pct = num(v && v.pePct5y, null);
    var progress, status, statusCls;
    if (pct === null) { progress = 0; status = '数据待更新'; statusCls = 'absent'; }
    else if (pct < THRESHOLD.peDonePct) { progress = 100; status = '已到'; statusCls = 'done'; }
    else if (pct < THRESHOLD.peGrindPct) { progress = 55; status = '磨底中'; statusCls = 'grinding'; }
    else { progress = 15; status = '未到'; statusCls = 'absent'; }
    var points = [];
    if (v) {
        points.push('PE-TTM ' + v.peLow + '–' + v.peHigh + ' 倍，近5年分位 ' + v.pePct5y + '%，2010年以来分位 ' + v.pePctSince2010 + '%');
        points.push('PB ' + v.pb + ' 倍，2010年以来 ' + v.pbPctSince2010 + '% 分位');
        points.push('已' + (progress >= 100 ? '' : '接近') + '跌破 ' + v.refDate + ' ' + v.refPoint + ' 点时的估值（当时 PE 约 ' + v.refPeLow + '–' + v.refPeHigh + ' 倍）');
    }
    if (tm && tm.drawdown !== null) {
        points.push('实时：恒科 ' + (tm.lastClose ? tm.lastClose.toFixed(2) : '--') + ' 点，' +
            (tm.streak !== null ? '连跌 ' + tm.streak + ' 日，' : '') +
            '距阶段高点（' + (tm.highRefDate || '--') + '）回撤 ' + tm.drawdown.toFixed(1) + '%');
    }
    return {
        key: 'valuation', name: '估值底', status: status, statusCls: statusCls,
        progress: progress, weight: WEIGHTS.valuation,
        oneLine: pct !== null
            ? ('PE 近5年分位 ' + pct + '%' + (progress >= 100 ? '，已到历史极低区' : progress >= 55 ? '，接近底部区' : '，仍未到便宜区'))
            : '估值分位待更新',
        points: points,
        caveat: '坑：估值低不是底。' + (v ? v.histEpisode + ' 那轮 PE 从 ' + v.histPeakPe + ' 倍砍到 ' + v.histCutPe + ' 倍才刚开始跌。' : '') +
            '低分位只说明「盈利不下修的话这里很便宜」，关键变量是分母（盈利）还在不在下修。'
    };
}

/** 资金底：南向连续性 + 主动低配 → 到达度（实时值用 sm/smonth，快照值锁定在 asOf 报告期） */
function evalCapital(c, sm, smonth, snapTc) {
    var pts = [];
    var progress = 0;
    var status, statusCls;
    var underweight = num(c && c.chinaUnderweightPct, 1.5);
    if (sm && sm.totalDays) {
        var ratio = sm.inDays / sm.totalDays;
        var flowScore = clamp(sm.consecutive / THRESHOLD.southDoneDays, 0, 1) * 50 + clamp(ratio, 0, 1) * 30;
        progress += flowScore;
        pts.push('南向实时：连续净流入 ' + sm.consecutive + ' 日，近 ' + sm.totalDays + ' 日 ' + sm.inDays + ' 流入 / ' + sm.outDays + ' 流出' +
            (sm.maxIn !== null ? '，单日最大流入 ' + (sm.maxIn / 100).toFixed(2) + ' 亿' : '') +
            (sm.maxOut !== null ? ' / 流出 ' + Math.abs(sm.maxOut / 100).toFixed(2) + ' 亿' : '') + '（港元）');
    }
    if (c) {
        // 外资持仓是季度低频快照：标签锁定在快照自身报告期，不随当前时间滚
        var fqLabel = c.reportQuarter || snapTc.qLabel;
        pts.push('外资被动进、主动出：' + fqLabel + ' 持股约 ' + c.foreignHoldWanYi + ' 万亿、占比 ' + c.foreignShare + '%（上季 ' + c.foreignSharePrev + '%）' +
            '；长线流入 ' + c.longInflowYi + ' 亿，短线流出 ' + c.shortOutflowYi + ' 亿' + '（研报快照）');
        pts.push('主动低配：中国 ' + c.chinaUnderweightPct + 'pct、EM 基金 ' + c.emUnderweightPct + 'pct；' +
            c.ubsUnderweightFunds + '/' + c.ubsFunds + ' 只外资主动基金低配中国（AUM ' + c.ubsAumWanYi + ' 万亿美元，均配低 ' + c.ubsUnderweightPct + 'pct）（研报快照）');
        // 南向总量：优先用实时序列算（本月/上月/YTD/同比），取不到才退回研报快照
        if (smonth) {
            var yoyS = smonth.ytdRatio !== null ? '，为去年同期 ' + (smonth.ytdRatio * 100).toFixed(0) + '%' : '';
            pts.push('南向总量（实时）：' + smonth.month + '月净流入 ' + smonth.curYi.toFixed(0) + ' 亿港元（上月 ' + smonth.prevYi.toFixed(0) + ' 亿）；' +
                '年内累计 ' + smonth.ytdYi.toFixed(0) + ' 亿港元' + yoyS + ' · 截至 ' + smonth.lastDate);
        } else {
            pts.push('南向总量：' + snapTc.monthLabel + '从' + snapTc.prevMonthLabel + ' ' + c.southJulInUSD + ' 亿美元降到 ' + c.southAugInUSD + ' 亿；前' + snapTc.month + '月累计约 ' + c.southYtdUSD + ' 亿美元，仅' + snapTc.lastYear + '年同期 ' + (c.southYtdYoy * 100).toFixed(0) + '%（研报快照）');
        }
        pts.push('EPFR 口径主动资金连续 ' + c.epfWeeksOut + ' 周净流出，被动流入盖不住主动抛售（研报快照）');
        progress += clamp((1.5 - underweight) / 1.5, 0, 1) * 20;
    }
    progress = Math.round(clamp(progress, 0, 100));
    if (progress >= 70) { status = '接近到底'; statusCls = 'done'; }
    else if (progress >= 30) { status = '磨底中'; statusCls = 'grinding'; }
    else { status = '未到'; statusCls = 'absent'; }
    if (!sm || !sm.totalDays) pts.unshift('南向净买入数据获取中…（当前仅研报快照）');
    return {
        key: 'capital', name: '资金底', status: status, statusCls: statusCls,
        progress: progress, weight: WEIGHTS.capital,
        oneLine: sm && sm.totalDays
            ? ('南向连续净流入 ' + sm.consecutive + ' 日 · 被动到底、主动未回')
            : '被动资金到底、主动资金未回（研报快照）',
        points: pts,
        caveat: '被动资金已到底（指数调仓驱动，不论贵贱），主动资金还没回来。历史主动外资回补总滞后估值底 2–3 个季度。'
    };
}

/** 叙事底：腾讯财报（实时）+ 研报细项 → 到达度（累计口径标签随财报季度变） */
function evalNarrative(n, fin, tc) {
    var pts = [];
    var progress = 5;
    var status, statusCls;
    var fq = financeQuarter(fin, (n && n.reportQuarter) || tc.quarter); // 财报实际季度
    var ytdLabel = ytdByQuarter(fq);                   // 前三个月 / 前半年 / 前三季 / 全年
    // 财报接口是「累计口径」：经营+投资现金流只能作旁证，不给高分
    if (fin && fin.reportType) {
        var revYoy = num(fin.revenueYoy, null);
        var netMargin = num(fin.netMargin, null);
        var opCash = num(fin.operateCash, null);
        var invCash = num(fin.investCash, null);
        pts.push('财报（' + fin.reportType + '，累计口径）：营收同比 ' + sign(revYoy, 1) + '%，净利润率 ' +
            (netMargin !== null ? netMargin.toFixed(1) + '%' : '--') +
            '，经营现金流 ' + (opCash !== null ? (opCash / 1e8).toFixed(0) + ' 亿' : '--') +
            '，投资现金流 ' + (invCash !== null ? (invCash / 1e8).toFixed(0) + ' 亿' : '--'));
        if (opCash !== null && invCash !== null) {
            var fcf = (opCash + invCash) / 1e8;
            pts.push('累计粗算自由现金流（经营+投资）约 ' + fcf.toFixed(0) + ' 亿元，' + (fcf > THRESHOLD.fcfDoneYi ? '为正' : '为负') + '（累计口径，非单季）');
            progress += fcf > 0 ? 10 : 3;
        }
    }
    // 决定性变量：资本开支环比拐点 + 利润增速拐点 + FCF 单季转正（换季度改这里即自动重算）
    if (n) {
        pts.push('腾讯营收同比 +' + n.tencentRevenueYoy + '%，资本开支 ' + n.capexYi + ' 亿（同比 +' + n.capexYoy + '% / 环比 ' + sign(n.capexQoq, 0) + '%），市场预期 ' + n.capexConsensusYi + ' 亿');
        pts.push(ytdLabel + '资本开支累计 ' + n.capexYtdYi + ' 亿（+' + n.capexYtdYoy + '%）；自由现金流净流出 ' + Math.abs(n.fcfNetYi) + ' 亿（经营现金流仅 ' + n.operateCashYi + ' 亿，被 ' + n.capexPaidYi + ' 亿资本开支付款吃掉），剔除预付款后 ' + sign(n.fcfExPrepayYi, 0) + ' 亿');
        pts.push('非IFRS经营利润 ' + n.opProfitAdjYi + ' 亿（' + sign(n.opProfitAdjYoy, 0) + '%），此前两季均为 +' + n.opProfitPrevYoy + '%');
        pts.push('阿里：资本开支 ' + n.alibabaCapexUSD + ' 亿美元、FCF ' + n.alibabaFcfQUSD + ' 亿美元；管理层「' + n.mgmtQuote + '」');
        // 环比由正转负 = 资本开支见顶 → 叙事底大幅推进；仍在加速则不推进
        var qoq = num(n.capexQoq, 0);
        if (qoq <= THRESHOLD.capexPeakDropPct) progress += 45;
        else if (qoq < 0) progress += 22;
        if (num(n.opProfitAdjYoy, -1) > 0) progress += 15;   // 利润增速拐点
        if (num(n.fcfNetYi, -1) > THRESHOLD.fcfDoneYi) progress += 15; // 单季 FCF 转正
    }
    progress = Math.round(clamp(progress, 0, 100));
    if (progress >= 70) { status = '接近到底'; statusCls = 'done'; }
    else if (progress >= 35) { status = '磨底中'; statusCls = 'grinding'; }
    else { status = '未到'; statusCls = 'absent'; }
    if (!fin || !fin.reportType) pts.unshift('腾讯财报数据获取中…（当前仅研报快照）');
    return {
        key: 'narrative', name: '叙事底', status: status, statusCls: statusCls,
        progress: progress, weight: WEIGHTS.narrative,
        oneLine: '市场按「资本开支三年后换回多少利润」定价 → ' + (progress >= 35 ? '拐点迹象出现' : '卡在估值真空'),
        points: pts,
        caveat: '核心矛盾：这个问题 2027 年前既无法证伪也无法证实，所以卡在估值真空。资本开支高峰未过、自由现金流未转正前，估值便宜不构成买入理由。'
    };
}

/** 坐标：日K + 研报估值拼装 */
function buildAnchors(v, tm) {
    var rows = [];
    if (tm && tm.lastClose !== null) rows.push({ k: '恒科最新', v: tm.lastClose.toFixed(2), note: tm.streak !== null ? ('连跌 ' + tm.streak + ' 日') : '' });
    if (tm && tm.low !== null) rows.push({ k: '今日最低', v: tm.low.toFixed(2), note: '' });
    if (tm && tm.highRef !== null) rows.push({ k: '阶段高点', v: tm.highRef.toFixed(2), note: (tm.highRefDate || '') + ' · 回撤 ' + (tm.drawdown !== null ? tm.drawdown.toFixed(1) + '%' : '--') });
    if (tm && tm.amplitude !== null) rows.push({ k: '20日振幅', v: tm.amplitude.toFixed(1) + '%', note: '' });
    if (tm && tm.amount !== null && tm.amount > 0) rows.push({ k: '成交额', v: (tm.amount / 1e8).toFixed(0) + ' 亿', note: '港元' });
    if (v) {
        rows.push({ k: 'PE-TTM', v: v.peLow + '–' + v.peHigh + ' 倍', note: '近5年 ' + v.pePct5y + '% 分位' });
        rows.push({ k: 'PE 极长分位', v: '2010年来 ' + v.pePctSince2010 + '%', note: '' });
        rows.push({ k: 'PB', v: v.pb + ' 倍', note: '2010年来 ' + v.pbPctSince2010 + '% 分位' });
    }
    return rows;
}

/** 信号清单：当前状态由实时数据填，时间段/数值由 tc + 快照派生，不写死 */
function buildSignals(mv, sm, e, tm, tc, fin) {
    var snap = mv.snap || {};
    var fq = financeQuarter(fin, (mv.narrative && mv.narrative.reportQuarter) || tc.quarter);
    var ir = snap.indexReview || { announce: '', effect: '', from: 30, to: 50 };
    var effectTs = ir.effect ? new Date(String(ir.effect).replace(/-/g, '/')).getTime() : NaN;
    var irNow = isFinite(effectTs) && tc.asOfTs >= effectTs
        ? ('扩容已生效，' + ir.from + '→' + ir.to + ' 只')
        : ((ir.announce || '--') + ' 公布检讨、' + (ir.effect || '--') + ' 生效，' + ir.from + '→' + ir.to + ' 只');
    var A = [
        { name: '恒科点位 / 量能', now: tm && tm.lastClose !== null
                ? (tm.lastClose.toFixed(0) + '，成交 ' + (tm.amount !== null && tm.amount > 0 ? (tm.amount / 1e8).toFixed(0) + ' 亿' : '--') + (tm.amplitude !== null ? '（振幅 ' + tm.amplitude.toFixed(0) + '%）' : ''))
                : '获取中', threshold: '破 3400 后放量收回，或缩量横盘 2 周' },
        { name: '南向连续性', now: sm && sm.totalDays
                ? ('连续 ' + sm.consecutive + ' 日净流入 · 近 ' + sm.totalDays + ' 日 ' + sm.inDays + ' 流入')
                : '获取中', threshold: '连续 5 日以上净流入且单日均超 50 亿' },
        { name: '中概 ETF 折价', now: e ? (e.code + ' 折价 ' + e.discLow + '–' + e.discHigh + '%（' + e.discDate + ' 最深）') : '--', threshold: '折价收敛到 1% 以内（恐慌盘出清）' },
        { name: 'ETF 份额', now: e ? (e.code + ' 从 ' + e.sharesLow + ' 增至 ' + e.sharesHigh + ' 亿份，创 ' + e.sharesHighDays + ' 日新高') : '--', threshold: '份额停止增长甚至回落（见底前兆）' },
        { name: '恒科成份扩容', now: irNow, threshold: '硬科技权重提升，或带来被动资金重配' }
    ];
    var noteA = e ? ('负反馈：' + e.code + ' 份额暴增（' + e.sharesFrom + '→' + e.sharesTo + ' 从 ' + e.sharesLow + ' 加到 ' + e.sharesHigh + ' 亿份）但价格一路跌、折价扩大到 ' + e.discHigh + '%——「越跌越申购、越申购越跌」。要等份额增长停滞、折价收敛才算抛压衰竭。') : '';
    var capex = mv.narrative ? mv.narrative.capexYi : '--';
    var opCashS = mv.narrative ? ('经营现金流仅 ' + mv.narrative.operateCashYi + ' 亿') : '--';
    var uw = mv.capital ? (mv.capital.chinaUnderweightPct + 'pct') : '--';
    return [
        { key: 'A', title: 'A 类 · 高频日度信号', sub: '实时刷新', items: A, note: noteA },
        { key: 'B', title: 'B 类 · 季度财务信号', sub: '决定叙事底', items: [
            { name: '腾讯资本开支环比见顶', now: 'Q' + fq + ' ' + capex + ' 亿（研报快照）', threshold: '下一季 / 再下一季环比回落 + 「投入高峰已过」指引' },
            { name: '真实自由现金流转正', now: opCashS + '（研报快照）', threshold: '回到 500 亿以上量级（不靠剔除预付款口径）' },
            { name: '云与 AI 利润率', now: '阿里云 EBITA 率约 ' + (snap.aliEbitaPct || '--') + '%（研报快照）', threshold: '抬到 13%+；腾讯金科企服毛利率抬升' },
            { name: 'AI 高毛利收入块', now: '仍以倒卖 GPU 算力为主', threshold: '出现 MaaS / 广告重构的高毛利增量' },
            { name: '阿里最新季报', now: snap.aliReportWindow || '报告期后发布', threshold: '资本开支指引继续上修则恒科还有一跌' }
        ], note: '' },
        { key: 'C', title: 'C 类 · 宏观与制度信号', sub: '决定外部抽水何时停', items: [
            { name: '美债 10 年期', now: snap.ust10y || '--', threshold: '回到 4.8% 以下（最硬一条，离岸贴现率）' },
            { name: '美国 CPI / 加息定价', now: snap.cpiNote || '--', threshold: 'CPI 回落、加息定价消退' },
            { name: '外资主动基金低配', now: '低配 ' + uw, threshold: '收窄到 0.5 以内' },
            { name: '南向定价权', now: '占恒指成交 ' + (snap.southTurnoverPct || '--') + '%', threshold: '稳定在 40% 以上' },
            { name: '政策端', now: '—', threshold: '平台经济表态、算力采购订单、南向通扩容' }
        ], note: '' }
    ];
}

/**
 * 主入口：输入实时数据，输出完整研判对象
 * @param live { quote, kline, south, finance } 任一可缺省；未取到的用 MANUAL 快照
 */
function evaluate(live) {
    live = live || {};
    // manual：云端定时任务维护的低频输入（若有）整体覆盖本地内置 MANUAL。
    // 云表 finance 字段结构与 market.fetchHKFinance 同构，直接当 live.finance 用。
    var mv = live.manual || MANUAL;
    // 两套时间语境：
    //  tc      = 当前时间 → 只用于实时数据的观察窗口（如下一季该看什么）
    //  snapTc  = 快照自身 asOf → 用于研报快照的报告期标签，锁定不随时间漂
    var tc = timeContext(live.asOf);
    var snapTc = timeContext(mv.asOf);
    var tm = trendMetrics(live.kline);
    if (live.quote && isFinite(Number(live.quote.price))) {
        tm.lastClose = Number(live.quote.price);
        if (live.quote.low !== null && live.quote.low !== undefined) tm.low = Number(live.quote.low);
    }
    // south 支持两种形态：实时接口的 [{date,val}] 数组；云端定时任务兜底的聚合摘要对象
    var southIsArr = Array.isArray(live.south);
    var sm = southIsArr ? southMetrics(live.south)
        : (live.south && live.south.totalDays ? {
            consecutive: live.south.consecutive || 0,
            inDays: live.south.inDays || 0,
            outDays: Math.max(0, (live.south.totalDays || 0) - (live.south.inDays || 0)),
            maxIn: null, maxOut: null, last: null, totalDays: live.south.totalDays || 0
          } : southMetrics(null));
    var smonth = southIsArr ? southMonthly(live.south)
        : (live.south && live.south.ytdYi !== undefined ? live.south : null);
    var fin = live.finance || null;

    var layers = [
        evalValuation(mv.valuation, tm),
        evalCapital(mv.capital, sm, smonth, snapTc),
        evalNarrative(mv.narrative, fin, snapTc)
    ];

    var raw = 0, arrived = 0;
    for (var i = 0; i < layers.length; i++) {
        raw += layers[i].progress * layers[i].weight / 100;
        if (layers[i].progress >= 60) arrived++;
    }
    var prob = Math.round(clamp(raw, 0, 100));
    var label, cls, verdict;
    if (prob >= 70) { label = '底部大概率已现'; cls = 'up'; verdict = '三层底多数到位，可按计划分批布局，回踩不破前低即确认。'; }
    else if (prob >= 45) { label = '接近底部区域'; cls = 'up'; verdict = '估值与资金改善，叙事待验证，左侧可小仓试探、留足子弹。'; }
    else if (prob >= 30) { label = '左侧磨底'; cls = 'warn'; verdict = '估值底已现，叙事底未到——只具备「便宜」，不具备「确认」，观察为主、不追反弹。'; }
    else { label = '底部未到'; cls = 'down'; verdict = '核心矛盾（盈利与资本开支）未见拐点，估值便宜不构成买入理由，继续等信号。'; }

    var liveParts = [];
    if (live.kline || live.quote) liveParts.push('行情实时');
    if (sm.totalDays) liveParts.push('南向实时');
    if (fin && fin.reportType) liveParts.push('财报 ' + fin.reportType);
    var snapParts = [];
    if (!smonth) snapParts.push('南向累计快照');
    snapParts.push('估值/外资/资本开支快照');

    return {
        asOf: mv.asOf,
        period: snapTc.qLabel + ' 基准 · ' + snapTc.ytdText,
        dataTag: liveParts.length ? (liveParts.join(' · ')) : '研报快照',
        snapTag: snapParts.join(' · '),
        prob: prob, probText: prob + '%', label: label, cls: cls, barPct: prob,
        verdict: verdict, layerCount: arrived + '/3 层到达', confirmed: arrived >= 3,
        layers: layers,
        anchorRows: buildAnchors(mv.valuation, tm),
        signals: buildSignals(mv, sm, mv.etf, tm, snapTc, fin)
    };
}

/** 兼容旧调用 */
function build() {
    return evaluate({});
}

module.exports = {
    AS_OF: AS_OF,
    MANUAL: MANUAL,
    WEIGHTS: WEIGHTS,
    THRESHOLD: THRESHOLD,
    evaluate: evaluate,
    build: build,
    trendMetrics: trendMetrics,
    southMetrics: southMetrics,
    southMonthly: southMonthly,
    timeContext: timeContext,
    ytdByQuarter: ytdByQuarter,
    financeQuarter: financeQuarter
};
