/**
 * 港股科技板块模型
 * - BASKET：港股科技核心标的（与 market.js EM_LIST 里的 116.x 一一对应）
 * - buildAnalysis(quotes)：按当日涨跌算「港股次日倾向」打分卡，
 *   结构参照首页半导体「次日倾向」信号卡（分数 + 因子条 + 提示）
 *
 * 口径说明（模型是启发式打分，非预测承诺）：
 * - F1 恒科指数：权重最高，指数本身代表了板块全貌
 * - F2 龙头加权：腾讯/阿里/美团/小米四家权重股的加权涨跌，决定南向情绪
 * - F3 涨跌家数：板块宽度，普涨/普跌比个股拉动更可信
 * - F4 半导体链：中芯国际 + 华虹半导体（本 app 主线的港股镜像）
 * - 港股 16:00 收盘早于 A 股，收盘后的恒科指数期货夜盘可二次验证
 */

var BASKET = [
    { sec: '116.00700', name: '腾讯控股', code: '00700', w: 16 },
    { sec: '116.09988', name: '阿里巴巴-W', code: '09988', w: 14 },
    { sec: '116.03690', name: '美团-W', code: '03690', w: 9 },
    { sec: '116.09618', name: '京东集团-SW', code: '09618', w: 8 },
    { sec: '116.09999', name: '网易-S', code: '09999', w: 7 },
    { sec: '116.09888', name: '百度集团-W', code: '09888', w: 7 },
    { sec: '116.01024', name: '快手-W', code: '01024', w: 7 },
    { sec: '116.01810', name: '小米集团-W', code: '01810', w: 9 },
    { sec: '116.00981', name: '中芯国际', code: '00981', w: 6 },
    { sec: '116.01347', name: '华虹半导体', code: '01347', w: 4 },
    { sec: '116.00763', name: '中兴通讯', code: '00763', w: 4 },
    { sec: '116.00992', name: '联想集团', code: '00992', w: 4 },
    { sec: '116.09961', name: '携程集团-S', code: '09961', w: 5 },
    { sec: '116.09626', name: '哔哩哔哩-W', code: '09626', w: 5 }
];

var LEADERS = ['116.00700', '116.09988', '116.03690', '116.01810'];
var SEMIS = ['116.00981', '116.01347'];
var INDEX_SEC = '124.HSTECH';

function pctOf(q) {
    return q && isFinite(Number(q.pct)) ? Number(q.pct) : null;
}

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

/** 涨跌% → 因子贡献：±1.5% 打满量程 */
function pctContrib(pct, scale, weight) {
    if (pct === null) return null;
    return clamp(pct / scale, -1, 1) * weight;
}

/**
 * @param quotes 首页行情 map（key=secid）
 * @returns 次日倾向分析 { score, scoreText, label, cls, barPct, factors, hint, breadthText, note }
 *          全部缺数时返回 null（离线快照里没有港股数据就不显示）
 */
function buildAnalysis(quotes) {
    var q = quotes || {};
    var factors = [];
    var score = 0;
    var got = 0;

    // F1 恒科指数（权重 32）
    var idxPct = pctOf(q[INDEX_SEC]);
    var f1 = pctContrib(idxPct, 1.5, 32);
    if (f1 !== null) { score += f1; got++; }
    factors.push({
        name: '恒科指数',
        text: idxPct === null ? '--' : (idxPct > 0 ? '+' : '') + idxPct.toFixed(2) + '%',
        cls: idxPct === null ? 'flat' : idxPct > 0.05 ? 'up' : idxPct < -0.05 ? 'down' : 'flat',
        detail: '板块全貌 · 权重最大'
    });

    // F2 龙头加权（权重 28）：腾讯/阿里/美团/小米 按市值权重的简单等权近似
    var lSum = 0, lN = 0;
    for (var i = 0; i < LEADERS.length; i++) {
        var lp = pctOf(q[LEADERS[i]]);
        if (lp !== null) { lSum += lp; lN++; }
    }
    var lAvg = lN ? lSum / lN : null;
    var f2 = pctContrib(lAvg, 1.8, 28);
    if (f2 !== null) { score += f2; got++; }
    factors.push({
        name: '龙头加权',
        text: lAvg === null ? '--' : (lAvg > 0 ? '+' : '') + lAvg.toFixed(2) + '%',
        cls: lAvg === null ? 'flat' : lAvg > 0.05 ? 'up' : lAvg < -0.05 ? 'down' : 'flat',
        detail: '腾讯/阿里/美团/小米 · ' + lN + '/4'
    });

    // F3 涨跌家数（权重 22）：板块宽度
    var up = 0, down = 0, flat = 0, total = 0;
    for (var b = 0; b < BASKET.length; b++) {
        var bp = pctOf(q[BASKET[b].sec]);
        if (bp === null) continue;
        total++;
        if (bp > 0.05) up++;
        else if (bp < -0.05) down++;
        else flat++;
    }
    var breadth = total ? (up - down) / total : null;
    var f3 = breadth === null ? null : breadth * 22;
    if (f3 !== null) { score += f3; got++; }
    factors.push({
        name: '涨跌家数',
        text: total ? up + '涨 / ' + down + '跌' : '--',
        cls: breadth === null ? 'flat' : breadth > 0.15 ? 'up' : breadth < -0.15 ? 'down' : 'flat',
        detail: '14 只核心标的宽度' + (flat ? ' · ' + flat + '平' : '')
    });

    // F4 半导体链（权重 18）：中芯国际 + 华虹
    var sSum = 0, sN = 0;
    for (var s = 0; s < SEMIS.length; s++) {
        var sp = pctOf(q[SEMIS[s]]);
        if (sp !== null) { sSum += sp; sN++; }
    }
    var sAvg = sN ? sSum / sN : null;
    var f4 = pctContrib(sAvg, 2.5, 18);
    if (f4 !== null) { score += f4; got++; }
    factors.push({
        name: '半导体链',
        text: sAvg === null ? '--' : (sAvg > 0 ? '+' : '') + sAvg.toFixed(2) + '%',
        cls: sAvg === null ? 'flat' : sAvg > 0.05 ? 'up' : sAvg < -0.05 ? 'down' : 'flat',
        detail: '中芯国际 + 华虹 · 权重 ' + sN + '/2'
    });

    // 全部缺数（离线快照）时不出卡片
    if (!got) return null;

    score = Math.round(clamp(score, -100, 100));
    var cls = score >= 15 ? 'up' : score <= -15 ? 'down' : 'flat';
    var label = score >= 40 ? '偏多' : score >= 15 ? '偏强' : score <= -40 ? '偏空' : score <= -15 ? '偏弱' : '震荡';
    var hint;
    if (score >= 40) hint = '港股科技普涨且龙头领涨，次日 A 股算力链开盘情绪大概率受带动，可观察高开承接力度';
    else if (score >= 15) hint = '港股科技偏强，恒科指数收在高位，对次日 A 股半导体链偏正面，注意量能是否跟上';
    else if (score <= -40) hint = '港股科技普跌且龙头走弱，次日 A 股算力链承压概率大，警惕低开后无承接';
    else if (score <= -15) hint = '港股科技偏弱，南向情绪转冷，次日 A 股半导体链开盘以防守为主，观察是否低开高走';
    else hint = '港股科技涨跌互现，对次日 A 股方向指引有限，重点看恒科期货夜盘与美股半导体走势';

    return {
        score: score,
        scoreText: (score > 0 ? '+' : '') + score,
        label: label,
        cls: cls,
        barPct: Math.round((score + 100) / 2),
        factors: factors,
        hint: hint,
        breadthText: total ? up + '涨 / ' + down + '跌 / ' + flat + '平' : '',
        note: '港股 16:00 收盘早于 A 股 1 小时 · 收盘后看恒科指数期货夜盘二次验证 · 启发式打分不构成投资建议'
    };
}

module.exports = {
    BASKET: BASKET,
    INDEX_SEC: INDEX_SEC,
    buildAnalysis: buildAnalysis
};
