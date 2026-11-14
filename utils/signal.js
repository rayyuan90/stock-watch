/**
 * 信号模型
 * 目的：用可解释的加权因子给出「次日倾向」分数，而不是黑盒预测。
 * 逻辑依据：中韩半导体 ETF 跨市场，韩股与美股半导体先于 A 股反应；
 * 股指期货相对现货的强弱反映资金多空意愿。
 */

var WEIGHTS = {
    korea: 0.32,
    us: 0.28,
    futures: 0.22,
    momentum: 0.18
};

function clamp(v, lo, hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
}

function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
}

/** 把涨跌幅映射到 -100..100，span 为饱和阈值 */
function norm(pctValue, span) {
    return clamp((num(pctValue) / span) * 100, -100, 100);
}

function level(score) {
    if (score >= 25) return { label: '偏多', cls: 'up', hint: '跨市场与期货情绪同步转强' };
    if (score >= 8) return { label: '偏多震荡', cls: 'up', hint: '多头略占优，留意量能' };
    if (score > -8) return { label: '震荡', cls: 'flat', hint: '多空分歧，方向不明' };
    if (score > -25) return { label: '偏空震荡', cls: 'down', hint: '空头略占优，注意止盈' };
    return { label: '偏空', cls: 'down', hint: '跨市场与期货情绪同步走弱' };
}

function factor(name, value, detail) {
    var v = Math.round(value);
    return {
        name: name,
        value: v,
        text: (v > 0 ? '+' : '') + v,
        cls: v > 5 ? 'up' : v < -5 ? 'down' : 'flat',
        detail: detail || ''
    };
}

/**
 * @param {Object} input
 * @param {number} input.skPct        SK海力士涨跌幅
 * @param {number} input.samsungPct   三星电子涨跌幅
 * @param {number} input.soxPct       美股半导体 ETF 涨跌幅
 * @param {number} input.nvdaPct      英伟达涨跌幅
 * @param {number} input.futRel       期货相对现货当日强弱（百分点）
 * @param {number} input.etfPct       中韩半导体 ETF 涨跌幅
 * @param {number} input.chipPct      芯片 ETF 涨跌幅
 * @param {number} [input.netShortRatio] 净空单 / 总持仓（0..1，可负）
 */
function buildSignal(input) {
    var i = input || {};

    var koreaRaw = num(i.skPct) * 0.65 + num(i.samsungPct) * 0.35;
    var usRaw = num(i.soxPct) * 0.6 + num(i.nvdaPct) * 0.4;
    var momentumRaw = num(i.etfPct) * 0.6 + num(i.chipPct) * 0.4;

    var futuresRaw = norm(i.futRel, 1.5);
    var hasPosition = i.netShortRatio !== null && i.netShortRatio !== undefined &&
        isFinite(Number(i.netShortRatio));
    if (hasPosition) {
        futuresRaw = futuresRaw * 0.5 + norm(-Number(i.netShortRatio) * 100, 8) * 0.5;
    }

    var korea = norm(koreaRaw, 5);
    var us = norm(usRaw, 5);
    var momentum = norm(momentumRaw, 5);

    var score = korea * WEIGHTS.korea + us * WEIGHTS.us +
        futuresRaw * WEIGHTS.futures + momentum * WEIGHTS.momentum;
    score = Math.round(clamp(score, -100, 100));

    var lv = level(score);

    return {
        score: score,
        scoreText: (score > 0 ? '+' : '') + score,
        label: lv.label,
        hint: lv.hint,
        cls: lv.cls,
        barPct: clamp((score + 100) / 2, 2, 98),
        factors: [
            factor('韩股', korea, '海力士/三星'),
            factor('美半', us, 'SOXX/NVDA'),
            factor('期货', futuresRaw, hasPosition ? '含净空单' : '相对现货'),
            factor('A股', momentum, '两只ETF')
        ]
    };
}

/**
 * 跨市场信号 × A股多空模型（ASFMM-A）汇总
 * - 跨市场分 sig.score：-100..100（权重 0.6）
 * - 模型动量 M：约 -50..50，放大 2 倍到同轴（权重 0.4）
 * - 方向一致 → 共振；相反 → 分歧提示；否则按汇总分定级
 */
function buildFuse(sig, model) {
    if (!sig || !isFinite(Number(sig.score))) return null;
    var cross = Number(sig.score);
    var m = model && isFinite(Number(model.m)) ? Number(model.m) : null;
    if (m === null || !model) {
        return {
            score: cross,
            scoreText: (cross > 0 ? '+' : '') + cross,
            label: '仅跨市场信号',
            cls: sig.cls,
            hint: 'A股模型未就绪，暂只计跨市场因子',
            agree: null
        };
    }
    var modelScore = clamp(m * 2, -100, 100);
    // 脉冲市口径：门禁未全亮 / PULSE / DUMP / STARVE 时，模型不给方向，不参与合成
    var noDir = (model.gateScore !== undefined && model.gateScore !== null && Number(model.gateScore) < 6) ||
        model.regimeState === 'PULSE' || model.regimeState === 'DUMP' || model.regimeState === 'STARVE';
    if (noDir) {
        return {
            score: cross,
            scoreText: (cross > 0 ? '+' : '') + cross,
            label: '仅跨市场信号',
            cls: sig.cls,
            hint: 'A股模型 ' + (model.regimeState || '') + ' · 门禁 ' + model.gateScore + '/6 未全亮 → 不给方向，等脉冲 + T+1 确认',
            agree: null
        };
    }
    var combined = Math.round(clamp(cross * 0.6 + modelScore * 0.4, -100, 100));
    var lv = level(combined);

    var agree;
    var label;
    var hint;
    var cls;
    if (cross >= 8 && modelScore >= 8) {
        agree = 'resonance';
        label = '共振偏多';
        hint = '跨市场与A股模型同向看多，信号可信度最高';
        cls = 'up';
    } else if (cross <= -8 && modelScore <= -8) {
        agree = 'resonance';
        label = '共振偏空';
        hint = '跨市场与A股模型同向看空，信号可信度最高';
        cls = 'down';
    } else if ((cross >= 8 && modelScore <= -8) || (cross <= -8 && modelScore >= 8)) {
        agree = 'conflict';
        label = '信号分歧';
        hint = '跨市场与A股模型方向相反，以量能定方向，仓位保守';
        cls = 'flat';
    } else {
        agree = combined >= 8 ? 'lean-up' : combined <= -8 ? 'lean-down' : 'neutral';
        label = lv.label + '（含模型）';
        hint = lv.hint + ' · A股模型 ' + (model.quad || '');
        cls = lv.cls;
    }

    return {
        score: combined,
        scoreText: (combined > 0 ? '+' : '') + combined,
        label: label,
        cls: cls,
        hint: hint,
        agree: agree,
        crossScore: cross,
        modelScore: Math.round(modelScore),
        quad: model.quad || ''
    };
}

/**
 * 多空结构
 * @param {Object} pos { netShort: 手数(正=净空/负=净多), totalOi: 手数, date: 'YYYY-MM-DD' }
 * @param {Object} prev 上一交易日记录
 */
function buildLongShort(pos, prev) {
    var has = pos && isFinite(Number(pos.netShort));
    if (!has) {
        return { has: false };
    }
    var net = Number(pos.netShort);
    var total = Number(pos.totalOi);
    var base = total > 0 ? total : 80000;
    var ratio = clamp(net / base, -1, 1);

    var shortPct = 50 + ratio * 45;
    var longPct = 100 - shortPct;

    var diff = null;
    if (prev && isFinite(Number(prev.netShort))) {
        diff = net - Number(prev.netShort);
    }

    return {
        has: true,
        net: Math.round(net),
        netCls: net > 0 ? 'down' : net < 0 ? 'up' : 'flat',
        side: net > 0 ? '净空单' : net < 0 ? '净多单' : '多空平衡',
        totalOi: total > 0 ? Math.round(total) : null,
        date: pos.date || '',
        shortPct: Math.round(shortPct),
        longPct: Math.round(longPct),
        diff: diff === null ? null : Math.round(diff),
        diffCls: diff === null ? 'flat' : diff > 0 ? 'down' : diff < 0 ? 'up' : 'flat',
        ratioText: (ratio * 100).toFixed(1) + '%'
    };
}

/** 持仓盈亏 */
function buildPosition(quote, cost, shares) {
    if (!quote || !isFinite(Number(quote.price))) return null;
    var price = Number(quote.price);
    var c = Number(cost);
    var s = Number(shares);
    if (!isFinite(c) || !isFinite(s) || c <= 0 || s <= 0) return null;
    var marketValue = price * s;
    var costValue = c * s;
    var profit = marketValue - costValue;
    var profitPct = costValue > 0 ? (profit / costValue) * 100 : 0;
    var todayProfit = isFinite(Number(quote.change)) ? Number(quote.change) * s : 0;
    return {
        shares: s,
        cost: c,
        marketValue: marketValue,
        costValue: costValue,
        profit: profit,
        profitPct: profitPct,
        todayProfit: todayProfit,
        cls: profit > 0 ? 'up' : profit < 0 ? 'down' : 'flat'
    };
}

module.exports = {
    buildSignal: buildSignal,
    buildFuse: buildFuse,
    buildLongShort: buildLongShort,
    buildPosition: buildPosition
};
