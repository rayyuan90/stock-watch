/**
 * 多空博弈模型（JS 移植）
 * - A股：ASFMM-A v2 资金燃料-动量模型（asfmm_a_model_v2.py 增强版）
 *   v2 升级：[1] 大资金层 BIG + 虚量闸门  [2] 政策向量 PolicyVector（分通道+半衰期）
 *            [3] 数据质量闸门 quality_gate  [4] 次日三场景推演（破5日线/炸板超标强制"下探后修复"）
 * - 美股：SFMM 空平燃料-动量模型（sfmm_model.py）
 *
 * 数据可得性说明（界面同步注明）：
 * - 小程序可实时获取：日K 收盘/最高/成交量、沪深两市成交额、涨停/炸板/连板高度（东财涨停池）
 * - 云端自动化回填（a_input_ext 表，每交易日收盘后任务写入）：两融 d_margin/margin_pct_rank、
 *   主力大单 big_order_net、宽基ETF申赎 etf_sub_rank、北向 north_net_rank、上涨占比 up_ratio_rank
 * - 无法获取：新发基金、解禁/减持/获利盘 -> 中性值(50/0)填充，并在数据质量闸门标注
 * - 政策无法自动抓取：人工判断后填到下方 A_POLICY_ACTIVE（v2 设计如此，政策解读不能交给爬虫）
 * - SFMM 的空头燃料 F 用「距20日高点回撤」同构代理：下跌攒燃料、上涨燃烧
 */
var market = require('./market');
var bgHist = require('./bgHist');
var cloudData = require('./cloudData');

function clamp(x, lo, hi) {
    return Math.max(lo === undefined ? 0 : lo, Math.min(hi === undefined ? 100 : hi, x));
}

function emaSeries(vals, span) {
    if (!vals.length) return [];
    var k = 2.0 / (span + 1.0);
    var out = [vals[0]];
    for (var i = 1; i < vals.length; i++) {
        out.push(out[i - 1] * (1 - k) + vals[i] * k);
    }
    return out;
}

function mean(arr) {
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return arr.length ? s / arr.length : 0;
}

function stdev(arr) {
    if (arr.length < 2) return 0;
    var m = mean(arr);
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += (arr[i] - m) * (arr[i] - m);
    return Math.sqrt(s / (arr.length - 1));
}

function fmtSigned(v, digits) {
    var d = digits === undefined ? 2 : digits;
    return (v >= 0 ? '+' : '') + v.toFixed(d);
}

/* ================= A股：ASFMM-A ================= */

// 模型固定参数（与 asfmm_a_model_v2.py 一致）
var A_W = { margin: 0.30, fund: 0.25, amt: 0.25, swap: 0.20 };          // 燃料 P 权重
var A_R = { margin: 0.35, etf: 0.25, amt: 0.25, newfund: 0.15 };        // 流入 R 权重
var A_M = { P: 0.20, R: 0.25, A: 0.25, E: 0.15, Ep: 0.15, G: 0.20, BIG: 0.10 };
var A_BIG = { big: 0.40, north: 0.30, etf: 0.30, confirmTh: 55, boostTh: 70 };
var A_G = { unlock: 0.30, reduce: 0.30, force: 0.20, profit: 0.20 };    // 卖压 G 权重
var A_E = { limit: 0.30, board: 0.25, broken: 0.25, up: 0.20 };         // 情绪 E 权重
var FLOAT_MV = 800000; // 流通市值近似（亿元）

function turnoverRank(amt, window) {
    var cnt = 0;
    for (var i = 0; i < window.length; i++) {
        if (window[i] <= amt) cnt++;
    }
    return cnt / window.length * 100.0;
}

function aQuadrant(rScore, a) {
    var rHigh = rScore >= 50;
    if (rHigh && a > 0) return 'Q1 加速主升';
    if (rHigh && a <= 0) return 'Q2 天量滞涨';
    if (!rHigh && a <= 0) return 'Q3 缩量耗尽';
    return 'Q4 地量重启';
}

/* ===== v2 政策向量库（与 POLICY_LIBRARY 一致；政策无法自动抓取，人工判断后填写）===== */
var POLICY_LIBRARY = {
    RRR_CUT:               { direction: 1,  channel: 'P', strength: 3, decay: 20, label: '降准' },
    RATE_CUT:              { direction: 1,  channel: 'R', strength: 3, decay: 15, label: '降息' },
    SFISF:                 { direction: 1,  channel: 'R', strength: 3, decay: 12, label: '互换便利/回购增持再贷款' },
    STRUCTURAL_EASE:       { direction: 1,  channel: 'R', strength: 2, decay: 10, label: '结构性工具扩容降息' },
    NATIONAL_TEAM:         { direction: 1,  channel: 'R', strength: 3, decay: 5,  label: '国家队/汇金增持ETF' },
    TRADING_COST_CUT:      { direction: 1,  channel: 'E', strength: 1, decay: 8,  label: '降印花税/降费' },
    IPO_PAUSE:             { direction: 1,  channel: 'G', strength: 2, decay: 15, label: 'IPO/再融资节奏放缓' },
    STOCK_PLEDGE_RELIEF:   { direction: 1,  channel: 'G', strength: 2, decay: 12, label: '纾困/股权质押风险缓解' },
    LONG_FUND_GUIDE:       { direction: 1,  channel: 'P', strength: 2, decay: 25, label: '中长期资金入市指引' },
    SPECULATION_CRACKDOWN: { direction: -1, channel: 'E', strength: 3, decay: 8,  label: '打击过度炒作/操纵' },
    QUANT_TIGHTEN:         { direction: -1, channel: 'E', strength: 2, decay: 15, label: '高频量化监管收紧' },
    SMALL_CAP_CRACKDOWN:   { direction: -1, channel: 'E', strength: 3, decay: 10, label: '整顿小市值炒作' },
    MARGIN_TIGHTEN:        { direction: -1, channel: 'R', strength: 2, decay: 12, label: '两融/杠杆收紧' },
    CLEARING_CRACKDOWN:    { direction: -1, channel: 'G', strength: 2, decay: 10, label: '减持/清仓式减持整治' },
    SECTOR_COOLING:        { direction: -1, channel: 'E', strength: 2, decay: 6,  label: '行业窗口指导降温' },
    CUSTOM:                { direction: -1, channel: 'E', strength: 1, decay: 5,  label: '自定义冲击' }
};

/* 当日政策叠加（人工判断填写，两处来源按优先级）：
   1) 云端 a_input_ext.policy_json —— 由每日自动化任务从 automation/policy_today.py 写入（推荐，无需发版）
   2) 本地 A_POLICY_ACTIVE —— 未接自动化或临时调试用
   条目格式：[{ ptype: 'RRR_CUT', age: 1 }, { ptype: 'SPECULATION_CRACKDOWN', age: 0 }]
   也可写完整向量：{ direction: -1, channel: 'E', strength: 2, decay: 8, age: 0, note: '自定义' } */
var A_POLICY_ACTIVE = [];

function normalizePolicy(c) {
    c = c || {};
    var lib = POLICY_LIBRARY[c.ptype] || POLICY_LIBRARY.CUSTOM;
    return {
        ptype: c.ptype || 'CUSTOM',
        direction: c.direction !== undefined ? c.direction : lib.direction,
        channel: c.channel || lib.channel,
        strength: c.strength !== undefined ? c.strength : lib.strength,
        decay: c.decay !== undefined ? c.decay : lib.decay,
        age: c.age || 0,
        note: c.note || lib.label
    };
}

function readPolicyStack(cloud) {
    var raw = null;
    if (cloud && cloud.policy_json) {
        try {
            raw = JSON.parse(cloud.policy_json);
        } catch (e) {
            raw = null;
        }
    }
    if (!raw || !raw.length) raw = A_POLICY_ACTIVE;
    var out = [];
    for (var i = 0; i < raw.length; i++) out.push(normalizePolicy(raw[i]));
    return out;
}

function policyWeight(p) {
    return Math.pow(0.5, p.age / Math.max(p.decay, 0.1));
}

/* 分通道调节量（与 v2._policy_deltas 一致）：
   R/E 从当前分位往中性 50 靠（已高难再抬/已低更易打下去）；
   P 用未占用空间；G 高卖压时纾困边际效果更大 */
function policyDeltas(stack, lastRE, lastP, lastG) {
    var deltas = { R: 0, E: 0, G: 0, P: 0 };
    for (var i = 0; i < stack.length; i++) {
        var p = stack[i];
        var base;
        if (p.channel === 'R' || p.channel === 'E') {
            var cur = lastRE[p.channel];
            base = p.direction > 0 ? 100 - cur : cur;
        } else if (p.channel === 'P') {
            base = p.direction > 0 ? 100 - lastP : lastP;
        } else {
            base = lastG;
        }
        deltas[p.channel] += p.direction * p.strength * 6.0 * policyWeight(p) * (base / 100.0);
    }
    return deltas;
}

function describePolicyStack(stack) {
    if (!stack || !stack.length) return '';
    var parts = [];
    for (var i = 0; i < stack.length; i++) {
        var p = stack[i];
        var tag = p.direction > 0 ? '利多' : (p.direction < 0 ? '利空' : '中性');
        parts.push(p.note + '(' + tag + '·通道' + p.channel + '·力度' + p.strength.toFixed(0) +
            '·当期效力' + Math.round(policyWeight(p) * 100) + '%)');
    }
    return parts.join(' ; ');
}

/* 情绪温度 E 原始分（不含政策调节） */
function calcERaw(d) {
    var limitScore = clamp(d.limitUpCnt);
    var boardScore = clamp(d.maxBoard / 8.0 * 100.0);
    var brokenScore = clamp(100 - d.brokenRate);
    return clamp(A_E.limit * limitScore + A_E.board * boardScore +
        A_E.broken * brokenScore + A_E.up * d.upRatioRank);
}

function calcRawG(d) {
    return A_G.unlock * d.unlock5dRank + A_G.reduce * d.reduceAmtRank +
        A_G.force * d.marginForceRank + A_G.profit * d.profitFloatRank;
}

function calcOccupied(d) {
    return A_W.margin * d.marginPctRank + A_W.fund * d.fundEquityRank +
        A_W.amt * d.turnoverAmtRank + A_W.swap * d.swapRateRank;
}

/* v2 大资金闸门：R 高 + BIG 低 -> 虚量打折；R 高 + BIG 高 -> 允许升档 */
function bigGate(rScore, big) {
    if (rScore >= 50 && big < A_BIG.confirmTh) {
        var adj = rScore * (0.55 + 0.45 * big / A_BIG.confirmTh);
        return { r: adj, msg: '⚠虚量折价: R ' + rScore.toFixed(0) + '→' + adj.toFixed(0) + '（大资金仅' + big.toFixed(0) + '）' };
    }
    if (rScore >= 50 && big >= A_BIG.boostTh) {
        var up = Math.min(100, rScore * 1.08);
        return { r: up, msg: '大资金确认: R ' + rScore.toFixed(0) + '→' + up.toFixed(0) };
    }
    return { r: rScore, msg: '大资金中性' };
}

/* v2 数据质量闸门 quality_gate：关键字段缺超过 2 项 -> M 不可用于方向判断，只能看象限+告警 */
function qualityGate(d) {
    var missing = [];
    var q = d.dataQuality || {};
    for (var k in q) {
        if (q.hasOwnProperty(k) && q[k] !== 'ok' && String(q[k]).indexOf('ok') !== 0) {
            missing.push(k + '(' + q[k] + ')');
        }
    }
    var critical = [];
    for (var j = 0; j < missing.length; j++) {
        var m = missing[j];
        if (m.indexOf('大单') >= 0 || m.indexOf('ETF') >= 0 || m.indexOf('两融') >= 0 ||
            m.indexOf('解禁') >= 0 || m.indexOf('浮盈') >= 0 || m.indexOf('NaN') >= 0) {
            critical.push(m);
        }
    }
    return { usable: critical.length <= 2, critical: critical, missingCount: missing.length };
}

/* ================= v3 脉冲市补丁（regime_pulse.py 移植） =================
 * 原 v2 用 EMA 平滑 R/A，隐含「地量→资金慢慢回流→量能中枢逐级上移→连续反弹」的连续市场假设。
 * 现实是「地量→天量→地量」跳变：量能是脉冲变量（泊松跳变）不是趋势变量（布朗运动），
 * EMA 会把跳变抹平，等 A 转正行情已经结束。故改为：
 *   ① 量能状态机 STARVE / PULSE / SUSTAIN / DUMP（离散，不做平滑）
 *   ② T+1 / T+2 硬确认（不反杀、量不塌、重心上移），PULSE 一律按一日游处理
 *   ③ 六条门禁，全亮才允许试错
 */
var A_TH = {
    starveRatio: 0.70,    // 成交 < 20日均值×0.7 -> STARVE
    // 跳变判定：补丁原值 1.50，但 A 股单日量能极难放大 50%，实际几乎永不触发。
    // 按 11/16 观察框架校准（1.48万亿 -> 1.8万亿 即 1.22 倍视为脉冲），取 1.25。
    pulseJump: 1.25,      // 单日较前日放量 >1.25倍
    pulseMaRatio: 1.10,   // 且 > 20日均值×1.1
    dumpMaRatio: 1.10,    // 放量下跌：量 > 均值1.1倍
    dumpPct: -1.0,        // 且跌幅 >1%
    sustainDays: 3,       // 连续3日站上均量
    sustainDecay: 0.85,   // 且每日量不低于前日85%
    t1VolKeep: 0.60,      // T+1 量能不得低于脉冲日60%
    t1PullbackMax: -1.5,  // T+1 收盘跌幅超1.5%视为反杀
    shadowRatio: 0.40,    // 下影线占全幅>40%
    rangeMin: 0.010       // 振幅下限1%
};

var AMT_AS_VOL = false; // 降级源（腾讯/缓存）无成交额时，量能按成交量(手)口径展示

function fmtAmt(v) {
    if (!isFinite(v)) return '--';
    if (AMT_AS_VOL) return v >= 1e8 ? (v / 1e8).toFixed(2) + '亿手' : (v / 1e4).toFixed(0) + '万手';
    return v >= 10000 ? (v / 10000).toFixed(2) + '万亿' : v.toFixed(0) + '亿';
}

/** 截至 i 日连续站上 20 日均量的天数 */
function consecAboveMa(amts, i) {
    var cnt = 0;
    for (var k = i; k >= 20; k--) {
        var ma = mean(amts.slice(k - 20, k));
        if (amts[k] > ma) cnt++;
        else break;
    }
    return cnt;
}

/** 第 i 日的量能状态（离散，不做任何平滑） */
function classifyAt(amts, closes, i) {
    if (i < 21) return null;
    var cur = amts[i];
    var prev = amts[i - 1];
    var ma20 = mean(amts.slice(i - 20, i));
    if (!ma20 || !prev) return null;
    var rMa = cur / ma20;
    var rPrev = cur / prev;
    var pct = closes[i - 1] ? (closes[i] / closes[i - 1] - 1) * 100 : 0;
    var consec = consecAboveMa(amts, i);
    var base = {
        amount: cur, ma20: ma20, rMa: rMa, rPrev: rPrev,
        pct: pct, consec: consec, idx: i
    };

    // 判定顺序：DUMP > STARVE > PULSE > SUSTAIN > NEUTRAL
    if (rMa > A_TH.dumpMaRatio && pct < A_TH.dumpPct) {
        base.state = 'DUMP';
        base.label = 'DUMP 出逃';
        base.reason = '放量下跌(量比均值' + rMa.toFixed(2) + '倍, 跌' + pct.toFixed(1) + '%) → 派发';
        return base;
    }
    if (rMa < A_TH.starveRatio) {
        base.state = 'STARVE';
        base.label = 'STARVE 枯竭';
        base.reason = '量能仅为20日均值' + rMa.toFixed(2) + '倍 → 流动性休眠';
        return base;
    }
    if (rPrev > A_TH.pulseJump && rMa > A_TH.pulseMaRatio && consec < A_TH.sustainDays) {
        base.state = 'PULSE';
        base.label = 'PULSE 脉冲';
        base.reason = '单日量能跳增' + rPrev.toFixed(2) + '倍但仅' + consec + '日 → 脉冲非趋势';
        return base;
    }
    if (consec >= A_TH.sustainDays) {
        var ok = true;
        for (var k = i; k > i - consec && k > 0; k--) {
            if (amts[k] < amts[k - 1] * A_TH.sustainDecay) { ok = false; break; }
        }
        if (ok) {
            base.state = 'SUSTAIN';
            base.label = 'SUSTAIN 持续';
            base.reason = '连续' + consec + '日站上均量且不衰减 → 真启动';
            return base;
        }
    }
    base.state = 'NEUTRAL';
    base.label = 'NEUTRAL 居中';
    base.reason = '量能居中(' + rMa.toFixed(2) + '倍均量), 无明确方向';
    return base;
}

/** 最近一次 PULSE 的位置（用于判断 T+1/T+2 是否已发生） */
function lastPulseIndex(amts, closes) {
    for (var i = amts.length - 1; i >= 22; i--) {
        var s = classifyAt(amts, closes, i);
        if (s && s.state === 'PULSE') return i;
    }
    return -1;
}

/** T+1 / T+2 硬确认（对最近一次 PULSE 做校验） */
function checkContinuity(bars, amts, closes, pulseIdx) {
    var out = { pulseIdx: pulseIdx, t1: null, t2: null, verdict: '无脉冲', text: '' };
    if (pulseIdx < 0) {
        out.text = '近期无脉冲，无需验证';
        return out;
    }
    var last = bars.length - 1;
    var p = bars[pulseIdx];
    var pTxt = p.time.slice(5);

    if (pulseIdx >= last) {
        out.verdict = '待 T+1 验证';
        out.text = pTxt + ' 脉冲日刚出现，明日开盘30分钟验：不破 ' + p.low.toFixed(0) +
            ' + 量能 ≥ ' + fmtAmt(p.amount * A_TH.t1VolKeep) + ' + 主线不换题材';
        return out;
    }

    var t1 = bars[pulseIdx + 1];
    var d1 = [], ok1 = true;
    if (t1.low < p.low) { ok1 = false; d1.push('破脉冲日低点(' + t1.low.toFixed(0) + '<' + p.low.toFixed(0) + ')'); }
    if (t1.amount < p.amount * A_TH.t1VolKeep) { ok1 = false; d1.push('量能塌陷(' + (t1.amount / p.amount * 100).toFixed(0) + '%)'); }
    var t1Pct = (t1.close / p.close - 1) * 100;
    if (t1Pct < A_TH.t1PullbackMax) { ok1 = false; d1.push('T+1反杀' + t1Pct.toFixed(1) + '%'); }
    out.t1 = { pass: ok1, detail: d1.length ? d1.join('、') : 'T+1 守住(不破低+量能未塌)' };

    if (pulseIdx + 2 > last) {
        out.verdict = ok1 ? 'T+1 通过·待 T+2' : '一日游确认';
        out.text = pTxt + ' 脉冲 → ' + out.t1.detail + '；T+2 待验';
        return out;
    }

    var t2 = bars[pulseIdx + 2];
    var d2 = [], ok2 = true;
    if (t2.low < t1.low) { ok2 = false; d2.push('T+2 再破低'); }
    if (t2.close < p.close) { ok2 = false; d2.push('T+2 回吐全部涨幅'); }
    out.t2 = { pass: ok2, detail: d2.length ? d2.join('、') : 'T+2 重心上移' };

    if (ok1 && ok2) out.verdict = '双确认通过';
    else if (ok1 && !ok2) out.verdict = '两日游后衰竭';
    else out.verdict = '一日游确认';

    out.text = pTxt + ' 脉冲 → ' + out.t1.detail + ' · ' + out.t2.detail;
    return out;
}

/** K 线探底形态：长下影或十字星 */
function klineShape(bar) {
    var hi = bar.high, lo = bar.low, cl = bar.close, op = (bar.open === undefined ? bar.close : bar.open);
    var rng = hi - lo;
    if (rng <= 0) return { ok: false, detail: '振幅为0' };
    var body = Math.abs(cl - op);
    var shadow = (Math.min(cl, op) - lo) / rng;
    var amp = cl ? rng / cl : 0;
    if (shadow >= A_TH.shadowRatio && amp >= A_TH.rangeMin) {
        return { ok: true, detail: '长下影(占' + (shadow * 100).toFixed(0) + '%, 振幅' + (amp * 100).toFixed(1) + '%)' };
    }
    if (body / (cl || 1) <= 0.003 && amp >= A_TH.rangeMin) {
        return { ok: true, detail: '十字星(实体' + (body / cl * 100).toFixed(2) + '%, 振幅' + (amp * 100).toFixed(1) + '%)' };
    }
    return { ok: false, detail: '无下影/十字(下影' + (shadow * 100).toFixed(0) + '%, 实体' + (body / cl * 100).toFixed(2) + '%)' };
}

/** 六条门禁：全亮才允许扣扳机 */
function bottomGate(o) {
    var bars = o.bars, amts = o.amts, regime = o.regime;
    var last = bars.length - 1;
    var items = [];

    // ① 地量衰竭：买点结构是「地量 → 脉冲 → 不反杀」，所以看近 3 日内是否出现过 STARVE，
    //    而不是要求今天仍是 STARVE（脉冲当天状态必然已经是 PULSE）
    var w20 = amts.slice(-20).slice().sort(function (a, b) { return a - b; });
    var q20 = w20[Math.max(0, Math.floor((w20.length - 1) * 0.2))];
    var starveIdx = -1;
    for (var si = Math.max(22, last - 4); si <= last; si++) {
        var st = si === last ? regime : classifyAt(amts, o.closes, si);
        if (st && st.state === 'STARVE') starveIdx = si;
    }
    var ok1 = starveIdx >= 0;
    var d1;
    if (ok1) {
        d1 = '地量 ' + bars[starveIdx].time.slice(5) + '（' + fmtAmt(amts[starveIdx]) + ' / ' +
            (amts[starveIdx] / mean(amts.slice(Math.max(0, starveIdx - 20), starveIdx))).toFixed(2) + '×均量）' +
            (regime.state === 'STARVE' ? ' · 今日仍在枯竭' : '');
    } else {
        d1 = regime.state + ' · 成交' + fmtAmt(amts[last]) + ' vs 近20日20%分位' + fmtAmt(q20) + '，近5日无地量';
    }
    items.push({ idx: '①', name: '地量衰竭', pass: ok1, cls: ok1 ? 'pass' : 'fail', detail: d1 });

    // ② 不破前低
    var prevLow = Infinity;
    for (var i = Math.max(0, last - 20); i < last; i++) {
        if (bars[i].low < prevLow) prevLow = bars[i].low;
    }
    var ok2 = bars[last].low > prevLow;
    items.push({
        idx: '②', name: '不破前低', pass: ok2, cls: ok2 ? 'pass' : 'fail',
        detail: '今低' + bars[last].low.toFixed(0) + ' vs 前20日低' + (isFinite(prevLow) ? prevLow.toFixed(0) : '--')
    });

    // ③ 情绪收敛
    var s = o.senti;
    var ok3 = false, d3;
    if (!s) {
        d3 = '情绪数据缺失(降级)';
    } else {
        ok3 = s.brokenRate <= 30 && s.limitUp >= 30;
        d3 = '炸板率' + s.brokenRate.toFixed(1) + '%, 涨停' + s.limitUp + '家, 高度' + s.maxBoard.toFixed(0) + '板';
    }
    items.push({ idx: '③', name: '情绪收敛', pass: ok3, cls: ok3 ? 'pass' : 'fail', detail: d3 });

    // ④ 探底形态：近 3 日内出现过长下影/十字星即算（买点结构跨日形成，脉冲当天未必是锤子线）
    var ks = null, ksIdx = -1;
    for (var ki = Math.max(1, last - 2); ki <= last; ki++) {
        var kk = klineShape(bars[ki]);
        if (kk.ok) { ks = kk; ksIdx = ki; break; }
    }
    if (!ks) ks = klineShape(bars[last]);
    items.push({
        idx: '④', name: '探底形态', pass: ksIdx >= 0, cls: ksIdx >= 0 ? 'pass' : 'fail',
        detail: (ksIdx >= 0 ? bars[ksIdx].time.slice(5) + ' ' : '今日 ') + ks.detail
    });

    // ⑤ 资金承接
    var ok5 = false, d5;
    if (!o.cloudReady) {
        d5 = '未接入(两融/大单/ETF 未回填, 保守记为未亮)';
    } else if (o.bigOrderNet > 0) {
        ok5 = true;
        d5 = '主力大单净流入' + o.bigOrderNet.toFixed(0) + '亿';
    } else if (o.bigOrderNetRank >= 55 && o.etfSubRank >= 50 && o.BIG >= 55) {
        ok5 = true;
        d5 = '大单分位' + o.bigOrderNetRank.toFixed(0) + ' + ETF分位' + o.etfSubRank.toFixed(0) + ' + BIG' + o.BIG.toFixed(0);
    } else {
        d5 = '大单' + (o.bigOrderNet ? o.bigOrderNet.toFixed(0) + '亿' : '--') + ' / 分位' + o.bigOrderNetRank.toFixed(0) + ' / BIG' + o.BIG.toFixed(0) + ' → 无承接';
    }
    items.push({ idx: '⑤', name: '资金承接', pass: ok5, cls: ok5 ? 'pass' : 'fail', detail: d5 });

    // ⑥ 无政策/外围雷
    var hit = null;
    for (var k = 0; k < o.policyStack.length; k++) {
        var p = o.policyStack[k];
        if (p.direction < 0 && p.strength * policyWeight(p) >= 1.2) { hit = p; break; }
    }
    var ok6 = !hit;
    items.push({
        idx: '⑥', name: '无政策雷', pass: ok6, cls: ok6 ? 'pass' : 'fail',
        detail: hit ? ('强利空[' + hit.note + '] 效力' + Math.round(hit.strength * policyWeight(hit) * 100) + '%')
            : (o.policyStack.length ? '仅有中性/利多政策' : '无政策输入(默认无雷)')
    });

    var score = 0;
    for (var m = 0; m < items.length; m++) if (items[m].pass) score++;

    // 双确认一票否决：最近 3 日内的脉冲若已被证伪，门禁再亮也不给买点
    var cv = o.cont && o.cont.verdict;
    var pulseAge = o.cont && o.cont.pulseIdx >= 0 ? (bars.length - 1 - o.cont.pulseIdx) : 99;
    var freshPulse = pulseAge <= 2;

    var verdict, action, cls;
    if (regime.state === 'DUMP') {
        verdict = '🚫 禁止买(派发中)';
        action = '不接飞刀，反抽减仓，等 STARVE 重新计时';
        cls = 'bad';
    } else if (freshPulse && cv === '一日游确认') {
        verdict = '🚫 禁止买(脉冲已证伪)';
        action = '反抽即卖点：借反抽减仓/优化持仓，等下一次「地量→脉冲」重新计时';
        cls = 'bad';
    } else if (freshPulse && cv === '两日游后衰竭') {
        verdict = '🟡 两日游后衰竭 · 只减不加';
        action = '冲高减仓，不新建头寸，等下一次地量重构';
        cls = 'mid';
    } else if (regime.state === 'PULSE' || (freshPulse && cv === '待 T+1 验证')) {
        verdict = '🚫 只看不买(等 T+1)';
        action = '脉冲诱多：只看不买，等 T+1 不反杀 + 量能不塌再谈';
        cls = 'bad';
    } else if (score >= 6) {
        verdict = '🟢 门禁全亮·可试错';
        action = '小仓(计划仓位1/3)分批，止损设前低下方1%，破位即走';
        cls = 'good';
    } else if (score >= 5) {
        verdict = '🟡 差一盏灯·观察';
        action = '不新建头寸，等最后一条亮起';
        cls = 'mid';
    } else {
        verdict = '🚫 禁止买';
        action = '空仓。所有反抽按一日游处理，借反抽优化持仓';
        cls = 'bad';
    }
    return { items: items, score: score, total: 6, verdict: verdict, action: action, cls: cls };
}

/** 次日观察框架（脉冲市口径，替代原「三场景推演」） */
function regimeScenarios(regime, gate, cont, bars) {
    var last = bars.length - 1;
    var out = [];
    var ma20 = regime.ma20;
    var starveLine = ma20 * A_TH.starveRatio;
    var pulseLine = Math.max(regime.amount * A_TH.pulseJump, ma20 * A_TH.pulseMaRatio);
    out.push('今日定位: ' + regime.label + ' · ' + regime.reason +
        (regime.state !== 'STARVE' && regime.rMa < 0.85 ? '（已到 STARVE 边缘）' : '') +
        ' · 门禁 ' + gate.score + '/6');
    out.push('量能跳变方向: 缩到 ' + fmtAmt(starveLine) + ' 以下 → STARVE 延续，继续等；' +
        '爆到 ' + fmtAmt(pulseLine) + ' 以上 → PULSE 触发，进 T+1 验证；' +
        '温和维持 ' + fmtAmt(ma20 * 1.0) + '~' + fmtAmt(ma20 * 1.15) + ' → SUSTAIN 苗头');
    out.push('T+1 验证(开盘30分钟): 不破今低 ' + bars[last].low.toFixed(0) +
        ' + 量能 ≥ ' + fmtAmt(regime.amount * A_TH.t1VolKeep) + ' + 主线不换题材，三条全过才算真底');
    out.push('反抽即卖点: 高开冲高但 10:00 前量能跟不上 / 炸板率回升 → 按 PULSE 诱多处理，借反抽减仓不新建头寸');
    if (cont && cont.verdict && cont.verdict !== '无脉冲') out.push('最近脉冲: ' + cont.text);
    return out;
}

/* 情绪-资金背离矩阵 */
function aDivergence(rScore, e) {
    var rOk = rScore >= 60, eOk = e >= 50;
    if (rOk && eOk) return '共振向上（健康）';
    if (rOk && !eOk) return '⚠资金强撑情绪退（顶部前兆，最危险）';
    if (!rOk && eOk) return '情绪虚火无量（诱多，别追）';
    return '双杀（Q3 空仓）';
}

function numOr(v, fallback) {
    var n = Number(v);
    return (v !== null && v !== undefined && v !== '' && isFinite(n)) ? n : fallback;
}

/* 只取当日云端行：过期数据不回填（避免陈旧两融污染 P 值，v2 陈旧数据防线同理） */
function pickCloudRow(rows, ymd) {
    if (!rows || !rows.length) return null;
    for (var i = 0; i < rows.length; i++) {
        if (rows[i].ymd === ymd) return rows[i];
    }
    return null;
}

function aPrMatrix(p, r) {
    var pHigh = p >= 50, rHigh = r >= 50;
    if (pHigh && rHigh) return '燃料足 + 流入猛 → 健康主升';
    if (!pHigh && rHigh) return '燃料少 + 猛烧 → ⚠Q2前兆（天量见天价）';
    if (!pHigh && !rHigh) return '燃料少 + 流入弱 → Q3 耗尽区';
    return '燃料足 + 流入弱 → 待催化启动';
}

function loadAGame() {
    return Promise.all([
        market.fetchBars('1.000001', 101, 46),
        market.fetchBars('0.399001', 101, 46)
    ]).then(function (res) {
        var sh = res[0], sz = res[1];
        if (sh.length < 25 || sz.length < 25) throw new Error('日K数据不足');

        // 对齐日期（两者交易日一致）
        var n = Math.min(sh.length, sz.length);
        var bars = [], dates = [], closes = [], amts = [];
        // 降级源适配：腾讯/缓存无成交额(amount=0)时，用成交量代替量能口径。
        // v3 状态机的全部判定（量比/分位/连站天数）都是比值，与绝对单位无关，安全。
        var amountMissing = !(sh[0].amount > 0) && !(sz[0].amount > 0);
        AMT_AS_VOL = amountMissing;
        var barsSource = sh.source || '';
        for (var i = n - Math.min(n, 46); i < n; i++) {
            var amtYi = amountMissing
                ? (sh[i].vol + sz[i].vol)  // 手（沪+深合计）
                : (sh[i].amount + sz[i].amount) / 1e8; // 亿元（沪+深=两市）
            var bar = {
                time: sh[i].time,
                open: sh[i].open,
                close: sh[i].close,
                high: sh[i].high,
                low: sh[i].low,
                amount: amtYi
            };
            bars.push(bar);
            dates.push(bar.time);
            closes.push(bar.close);
            amts.push(amtYi);
        }
        var lastIdx = amts.length - 1;
        var ymd = String(dates[lastIdx]).replace(/-/g, '');

        // v3 量能状态机（离散，替代 EMA 平滑后的 R 方向判断）
        var regime = classifyAt(amts, closes, lastIdx);
        if (!regime) throw new Error('量能历史不足（需≥22个交易日）');
        var pulseIdx = lastPulseIndex(amts, closes);

        // 并行：情绪层（东财涨停/炸板池）+ 云端慢变量（两融/大单/ETF，收盘后自动化回填）
        return Promise.all([
            market.fetchZtZb(ymd).catch(function () { return null; }),
            cloudData.loadAInputExt().catch(function () { return null; })
        ]).then(function (ext) {
            var senti = ext[0];
            var cloud = pickCloudRow(ext[1] && ext[1].data, dates[lastIdx]);

            // 情绪层降级链：东财涨停池(实时) -> 云端收盘值(自动化16:30写入) -> 中性
            // 真机上 push2ex 若未加域名白名单会取不到，此时用云端值兜底，E 仍是真实收盘情绪
            var eSrc = 'none';
            if (senti) {
                eSrc = 'live';
            } else if (cloud && cloudOk(cloud.limit_up_cnt)) {
                senti = {
                    limitUp: numOr(cloud.limit_up_cnt, 50),
                    maxBoard: numOr(cloud.max_board, 3),
                    brokenRate: numOr(cloud.broken_rate, 30),
                    ymd: cloud.ymd,
                    fromCloud: true
                };
                eSrc = 'cloud';
            }

            // ---- 输入组装（v2 DailyInput）：可用字段接真数据，其余中性降级并标注 ----
            var amtWin = amts.slice(lastIdx - 20, lastIdx);
            var amtRank = turnoverRank(amts[lastIdx], amtWin);
            var dMargin = numOr(cloud && cloud.d_margin, 0);
            // 获利盘本地兜底：20日乖离率代理（云端有 profit_float_rank 时优先用云端）
            var ma20pre = mean(closes.slice(-20));
            var dev20pct = ma20pre ? (closes[lastIdx] / ma20pre - 1) * 100 : 0;
            var profitLocal = clamp(50 + dev20pct * 4);
            var d = {
                marginPctRank: numOr(cloud && cloud.margin_pct_rank, 50),
                fundEquityRank: 50,
                turnoverAmtRank: amtRank,
                swapRateRank: amtRank,
                dMargin: dMargin,
                etfNetSubscribe: numOr(cloud && cloud.etf_net_subscribe, 0),
                amtOverMa20: amts[lastIdx] - mean(amtWin),
                newFundIssue: 0,
                floatMv: FLOAT_MV,
                bigOrderNet: numOr(cloud && cloud.big_order_net, 0),
                northNet: 0,
                bigOrderNetRank: numOr(cloud && cloud.big_order_net_rank, 50),
                northNetRank: numOr(cloud && cloud.north_net_rank, 50),
                etfSubRank: numOr(cloud && cloud.etf_sub_rank, 50),
                limitUpCnt: senti ? senti.limitUp : 50,
                maxBoard: senti ? senti.maxBoard : 3,
                brokenRate: senti ? senti.brokenRate : 30,
                upRatioRank: numOr(cloud && cloud.up_ratio_rank, 50),
                unlock5dRank: numOr(cloud && cloud.unlock_5d_rank, 50),
                reduceAmtRank: numOr(cloud && cloud.reduce_amt_rank, 50),
                marginForceRank: numOr(cloud && cloud.margin_force_rank,
                    dMargin >= -100 ? 50 : Math.min(100, 50 + (-dMargin - 100) / 5)),
                profitFloatRank: numOr(cloud && cloud.profit_float_rank, profitLocal),
                belowMa5: false,
                belowMa20: false,
                policyStack: readPolicyStack(cloud),
                dataQuality: {}
            };
            // 均线状态（v2 盘面字段：日内结构）
            var ma5 = mean(closes.slice(-5));
            var ma20c = mean(closes.slice(-20));
            d.belowMa5 = closes[lastIdx] < ma5;
            d.belowMa20 = closes[lastIdx] < ma20c;

            // ---- 数据质量报告（喂给 quality_gate）----
            var q = d.dataQuality;
            var cloudMissing = !cloud;
            function cloudOk(v) { return v !== null && v !== undefined && v !== ''; }
            if (eSrc === 'live') q['情绪(涨停池)'] = 'ok(涨停' + senti.limitUp + '/炸板率' + senti.brokenRate.toFixed(0) + '%/高度' + senti.maxBoard.toFixed(0) + '板)';
            else if (eSrc === 'cloud') q['情绪(涨停池)'] = 'ok(云端收盘值, 涨停池直连不可用)';
            else q['情绪(涨停池)'] = 'FAIL 无源, 置中性';
            q['两融'] = cloudMissing || !cloudOk(cloud.d_margin) ? 'FAIL 云端未回填, 置中性' : 'ok(云端自动化, T-1口径)';
            q['主力大单'] = cloudMissing || !cloudOk(cloud.big_order_net_rank) ? 'FAIL 云端未回填, 置中性' : 'ok(云端自动化)';
            q['宽基ETF'] = cloudMissing || !cloudOk(cloud.etf_sub_rank) ? 'FAIL 云端未回填, 置中性' : 'ok(云端自动化)';
            q['解禁(未来5日)'] = cloudMissing || !cloudOk(cloud.unlock_5d_rank) ? 'FAIL 云端未回填, 置中性' : 'ok(东财解禁)';
            q['减持(近20日)'] = cloudMissing || !cloudOk(cloud.reduce_amt_rank) ? 'FAIL 云端未回填, 置中性' : 'ok(高管净减持)';
            q['获利盘'] = cloudMissing || !cloudOk(cloud.profit_float_rank) ? 'ok(本地20日乖离代理)' : 'ok(云端乖离)';
            q['公募仓位'] = '季频无日频源, 置中性(仅影响 P)';

            // 界面上给 E / G 标注真实数据来源，避免被误读成中性值
            var eNote = eSrc === 'live' ? '（涨停池·实时）'
                : (eSrc === 'cloud' ? '（云端收盘值）' : '（中性·无数据源）');
            function _yi(v) { return numOr(v, 0).toFixed(0); }
            var gDetail = [
                '解禁 ' + (cloudOk(cloud && cloud.unlock_5d_yi) ? _yi(cloud.unlock_5d_yi) + '亿/5日' : '未回填'),
                '减持 ' + (cloudOk(cloud && cloud.reduce_20d_yi) ? numOr(cloud.reduce_20d_yi, 0).toFixed(2) + '亿/20日' : '未回填'),
                '强平 ' + (cloudOk(cloud && cloud.margin_force_rank)
                    ? (cloudOk(cloud.d_margin) ? '两融代理' : '中性(两融缺)') : '中性'),
                '浮盈 ' + (dev20pct >= 0 ? '+' : '') + dev20pct.toFixed(1) + '%乖离'
            ].join(' · ');

            // ---- R 序列（量能动量项；历史日无 BIG/政策，按基础 R 排 EMA）----
            var rScores = [];
            for (var j = 20; j < amts.length; j++) {
                var win = amts.slice(j - 20, j);
                var rRaw = (A_R.amt * (amts[j] - mean(win))) / FLOAT_MV * 100.0;
                rScores.push(clamp(50 + (rRaw - 0.05) / 0.02 * 10.0));
            }
            if (rScores.length < 3) throw new Error('量能历史不足');
            var emaR = emaSeries(rScores, 3);
            var R_score = emaR[emaR.length - 1];
            var A = R_score - emaR[emaR.length - 2];

            // ---- 政策分通道调节（基准 = 未调节的原始分位，避免自我放大）----
            var E_raw = calcERaw(d);
            var rawG = calcRawG(d);
            var rawP = 100 - calcOccupied(d);
            var pol = policyDeltas(d.policyStack, { R: R_score, E: E_raw }, rawP, rawG);

            // ---- P / BIG / 大资金闸门 / E / G ----
            var P = clamp(rawP + pol.P);
            var BIG = clamp(A_BIG.big * d.bigOrderNetRank + A_BIG.north * d.northNetRank + A_BIG.etf * d.etfSubRank);
            var bigG = bigGate(R_score, BIG);
            var R_adj = bigG.r;
            var E = clamp(E_raw + pol.E);
            var G = clamp(rawG + pol.G);
            var Ep = 0; // 无 E 历史序列，置 0（对 M 的影响走 Ep 权重 0.15×50 中性）

            // ---- 综合动量 M（v2：+BIG 确认项）----
            var M = Math.round(clamp(
                A_M.P * P + A_M.R * R_adj + A_M.A * (50 + A * 10) +
                A_M.E * E + A_M.Ep * (50 + Ep * 10) - A_M.G * G + A_M.BIG * (BIG - 50),
                -100, 100) * 100) / 100;

            var quad = aQuadrant(R_adj, A);

            // ---- v3 六条门禁 + T+1/T+2 硬确认（买点只认这个，不认 M 的大小）----
            var cont = checkContinuity(bars, amts, closes, pulseIdx);
            var gate = bottomGate({
                bars: bars, amts: amts, closes: closes, regime: regime, senti: senti, cont: cont,
                cloudReady: !!(cloud && cloudOk(cloud.big_order_net_rank)),
                bigOrderNet: d.bigOrderNet, bigOrderNetRank: d.bigOrderNetRank,
                etfSubRank: d.etfSubRank, BIG: BIG, policyStack: d.policyStack
            });
            var action = gate.action;
            var regimeActionText = regime.label + ' · ' + regime.reason;

            // 跳变监测（独立一行展示：今天有没有触发脉冲）
            var jumpOn = regime.rPrev >= A_TH.pulseJump;
            var jumpText;
            if (jumpOn && regime.state === 'PULSE') {
                jumpText = '已触发 ' + regime.rPrev.toFixed(2) + '× ≥ ' + A_TH.pulseJump + '× → 按一日游处理，只看不买';
            } else if (jumpOn && regime.state === 'DUMP') {
                jumpText = '已触发 ' + regime.rPrev.toFixed(2) + '× 但属于放量下跌 → 派发，不是买点';
            } else if (jumpOn) {
                jumpText = '已触发 ' + regime.rPrev.toFixed(2) + '×，但已连续站上 ' + regime.consec + ' 日 → 看能否转 SUSTAIN';
            } else {
                jumpText = '未触发（' + regime.rPrev.toFixed(2) + '×，需 ≥ ' + A_TH.pulseJump + '×，约 ' +
                    fmtAmt(regime.amount * A_TH.pulseJump) + '）';
            }
            var jump = { ratio: regime.rPrev, need: A_TH.pulseJump, triggered: jumpOn, text: jumpText };

            // 连续负加速度计数
            var negStreak = 0;
            for (var k3 = emaR.length - 1; k3 > 0; k3--) {
                if (emaR[k3] - emaR[k3 - 1] < 0) negStreak++;
                else break;
            }

            // ---- 告警（v2 全套；仅真实数据字段参与判定）----
            var alerts = [];
            if (R_score >= 60 && E < 45) alerts.push('🔴 资金强撑情绪退: 顶部前兆, 指数靠权重撑, 赚钱效应已散');
            if (R_adj < R_score - 1) alerts.push('🟠 ' + bigG.msg);
            if (d.bigOrderNet < -200) alerts.push('🔴 主力大单净流出 ' + Math.abs(d.bigOrderNet).toFixed(0) + '亿: 机构在卖, 反弹不可信');
            if (d.etfNetSubscribe < -20) alerts.push('🟠 宽基ETF净赎回 ' + Math.abs(d.etfNetSubscribe).toFixed(0) + '亿: 配置盘撤退');
            if (senti && amtRank >= 80 && d.limitUpCnt < 50) alerts.push('🔴 天量滞涨: 成交额高位 + 涨停家数萎缩, Q2典型');
            if (senti && d.brokenRate > 30) alerts.push('🟠 炸板率 ' + d.brokenRate.toFixed(0) + '% > 30%: 情绪转弱');
            if (senti && d.maxBoard <= 3) alerts.push('🟠 连板高度冰点: 高度板接力断裂');
            if (A < 0) alerts.push('🟠 加速度转负 A=' + fmtSigned(A) + '（连续 ' + negStreak + ' 期）');
            if (negStreak >= 3) alerts.push('🔴 A 连续3期为负: 顶部区高度确认, 立即减仓');
            if (P < 30) alerts.push('🔴 燃料告急 P=' + P.toFixed(1) + ' < 30: 仓位空间快没了, 不追多');
            if (G >= 70) alerts.push('🟠 卖压再生点火 G=' + G.toFixed(1) + ': 解禁/减持/获利盘集中');
            if (d.dMargin < -100) alerts.push('🟠 两融单日净流出 ' + Math.abs(d.dMargin).toFixed(0) + '亿: 杠杆资金撤退');
            if (d.belowMa20 && A < 0) alerts.push('🟠 跌破20日线 + 加速度负: 趋势转弱确认');
            if (d.belowMa5 && d.brokenRate > 30) alerts.push('🟠 破5日线 + 炸板率高: 短线惯性下, 次日易低开');
            for (var pi = 0; pi < d.policyStack.length; pi++) {
                var pp = d.policyStack[pi];
                alerts.push((pp.direction > 0 ? '🟢' : '🔴') + ' 政策[' + pp.note + ']' +
                    (pp.direction > 0 ? '利多' : '利空') + '·通道' + pp.channel +
                    '·当期效力' + Math.round(policyWeight(pp) * 100) + '%');
            }

            // ---- 波动率 & 明日幅度估计 ----
            var pcts = [];
            for (var k2 = 1; k2 < closes.length; k2++) {
                pcts.push((closes[k2] / closes[k2 - 1] - 1) * 100);
            }
            var sigma = stdev(pcts.slice(-20));
            var base = clamp((M - 50) / 12, -1.2, 1.2);
            var pred = base * sigma;
            var lo = clamp(pred - sigma * 0.4, -3.5, 3.5);
            var hi = clamp(pred + sigma * 0.4, -3.5, 3.5);

            // 预测落库（先算 pred 再 record）+ 用日K回填历史真实值（云端同步在 bgHist 内完成）
            bgHist.fillActual('a', dates, closes);
            bgHist.record({
                ymd: dates[lastIdx],
                model: 'a',
                pred: pred,
                lo: Math.min(lo, hi),
                hi: Math.max(lo, hi),
                m: M,
                quad: quad
            });

            // ---- 质量闸门 & 次日观察框架（脉冲市口径）----
            var gateQ = qualityGate(d);
            var scenarios = regimeScenarios(regime, gate, cont, bars);
            var qualityText = gateQ.usable
                ? '✅ 数据质量闸门: M 可用于方向判断'
                : '🚫 M=' + M.toFixed(2) + ' 不可用于方向判断，只能看象限+告警';
            var qParts = [];
            for (var qk in q) {
                if (q.hasOwnProperty(qk) && String(q[qk]).indexOf('ok') !== 0) qParts.push(qk);
            }
            if (qParts.length) qualityText += '（降级' + qParts.length + '项: ' + qParts.slice(0, 3).join(' / ') + '）';

            return {
                kind: 'a',
                date: dates[lastIdx],
                P: P, R: R_adj, R_score: R_score, BIG: BIG, bigMsg: bigG.msg,
                A: A, E: E, Ep: Ep, G: G, M: M, m: M,
                amtRank: amtRank,
                amtToday: amts[lastIdx],
                amtText: fmtAmt(amts[lastIdx]),
                ma20Text: fmtAmt(regime.ma20),
                quad: quad, action: action, matrix: aPrMatrix(P, R_adj),
                divergence: aDivergence(R_score, E),
                alerts: alerts, negStreak: negStreak,
                belowMa5: d.belowMa5, belowMa20: d.belowMa20,
                senti: senti ? { limitUp: senti.limitUp, brokenRate: senti.brokenRate, maxBoard: senti.maxBoard } : null,
                sigma: sigma,
                pred: pred, predLo: Math.min(lo, hi), predHi: Math.max(lo, hi),
                predText: predLabel(pred, lo, hi),
                // v3 脉冲市：状态机 + 双确认 + 六条门禁
                regime: {
                    state: regime.state, label: regime.label, reason: regime.reason,
                    amount: regime.amount, amountText: fmtAmt(regime.amount),
                    ma20: regime.ma20, ma20Text: fmtAmt(regime.ma20),
                    rMa: regime.rMa, rPrev: regime.rPrev, pct: regime.pct, consec: regime.consec
                },
                regimeAction: regimeActionText,
                jump: jump,
                cont: cont,
                gate: gate,
                gateScore: gate.score,
                gateVerdict: gate.verdict,
                gateCls: gate.cls,
                gateItems: gate.items,
                scenarios: scenarios,
                policyText: describePolicyStack(d.policyStack),
                qualityText: qualityText,
                mUsable: gateQ.usable,
                bigReal: !!(cloud && cloudOk(cloud.big_order_net_rank)),
                eSrc: eSrc, eNote: eNote, gDetail: gDetail,
                eReal: !!senti,
                // 数据源标注：东财正常时为空；降级时提示口径/新鲜度
                sourceText: amountMissing
                    ? (barsSource === '腾讯'
                        ? '日K来自腾讯备用源 · 量能按成交量口径（状态判定不受影响）'
                        : '日K来自本地缓存(' + (barsSource || '') .replace(/^缓存/, '') + ') · 数据较旧')
                    : ''
            };
        });
    });
}

/* v3：操作建议不再由 M 的大小推出，改由状态机+门禁给出（bottomGate.action） */

function predLabel(pred, lo, hi) {
    if (Math.abs(pred) < 0.08) {
        return '震荡 · 预计 ' + (lo >= 0 ? '+' : '') + lo.toFixed(2) + '% ~ ' + (hi >= 0 ? '+' : '') + hi.toFixed(2) + '%';
    }
    return (pred > 0 ? '偏涨 · 预计 +' : '偏跌 · 预计 ') + lo.toFixed(2) + '% ~ ' + (hi >= 0 ? '+' : '') + hi.toFixed(2) + '%';
}

/* ================= 美股：SFMM（回撤代理版） ================= */

var U_P = { w1: 0.5, w2: 0.3, w3: 0.2, gScale: 10.0 };

function uQuadrant(r, a) {
    if (r >= 5 && a > 0) return 'Q1 加速逼空';
    if (r >= 5 && a <= 0) return 'Q2 减速逼空';
    if (r < 5 && a <= 0) return 'Q3 燃料耗尽';
    return 'Q4 底部重启';
}

function uSignal(quad) {
    if (quad === 'Q1 加速逼空') return '持多，不猜顶';
    if (quad === 'Q2 减速逼空') return '减多 / 收紧止损 / 不新开多';
    if (quad === 'Q3 燃料耗尽') return '转空 / 空仓，等反抽';
    return '小仓试多，等价格确认';
}

function loadUsGame() {
    return market.fetchBars('100.NDX', 101, 46).then(function (rows) {
        if (rows.length < 25) throw new Error('日K数据不足');

        var n = rows.length;
        // 逐日燃料 F：距20日最高点的回撤（%），下跌攒燃料、上涨燃烧
        var Fs = [], dates = [], pcts = [], vols = [];
        for (var i = 20; i < n; i++) {
            var hh = 0;
            for (var j = i - 20; j < i; j++) {
                if (rows[j].high > hh) hh = rows[j].high;
            }
            var dd = (hh - rows[i].close) / hh * 100;
            Fs.push(clamp(dd * 10));
            dates.push(rows[i].time);
            pcts.push((rows[i].close / rows[i - 1].close - 1) * 100);
            vols.push(rows[i].vol);
        }

        // R = -dF/dt（F 下降 = 燃烧 = 上涨），A = dR/dt，均 EMA3 平滑
        var Rs = [];
        for (var k = 1; k < Fs.length; k++) Rs.push(Fs[k - 1] - Fs[k]);
        var emaR = emaSeries(Rs, 3);
        var R = emaR[emaR.length - 1];
        var emaA = emaSeries(Rs.map(function (v, idx) {
            return idx === 0 ? 0 : v - Rs[idx - 1];
        }), 3);
        var A = emaA[emaA.length - 1];

        var F = Fs[Fs.length - 1];
        var T = R > 0 ? F / R : Infinity;

        // 空头再生 G 代理：当日跌幅越深 + 缩量反弹 = 空头重新进场
        var li = n - 1;
        var volMa = mean(vols.slice(-21, -1));
        var volUp = pcts[pcts.length - 1] > 0 && vols[vols.length - 1] > volMa;
        var aboveMa = true;
        {
            var cw = [];
            for (var m = n - 21; m < n; m++) cw.push(rows[m].close);
            aboveMa = rows[n - 1].close >= mean(cw.slice(0, 20));
        }
        var G = clamp(Math.max(0, -pcts[pcts.length - 1]) / 1.5 +
            (pcts[pcts.length - 1] > 0 && vols[vols.length - 1] < volMa * 0.85 ? 1 : 0), 0, 3);

        var M = U_P.w1 * R + U_P.w2 * A - U_P.w3 * G * U_P.gScale;
        var quad = uQuadrant(R, A);
        var signal = uSignal(quad);

        var notes = [];
        if (A < 0 && !volUp) notes.push('🔴 顶背离：价涨量缩 + 加速度转负，减仓信号加倍');
        if (!volUp && !aboveMa) notes.push('🔴 放量滞涨 + 跌破均线：派发特征，偏空确认');
        if (F < 20) notes.push('🟠 燃料低于 20：回撤已基本修复，逼空逻辑失效');
        if (R > 0 && T < 3) notes.push('🟠 续航 T=' + T.toFixed(1) + '天 < 3天：即便强也不追高');
        if (G >= 1.5) notes.push('🟠 空头再生点火 G=' + G.toFixed(1) + '：对面在补燃料');
        if (pcts[pcts.length - 1] > 0 && !volUp && aboveMa) notes.push('🟠 缩量上涨：动能存疑');

        var sigma = stdev(pcts.slice(-20));

        // 预测落库 + 用日K回填历史真实值（云端同步在 bgHist 内完成）
        var uDates = [], uCloses = [];
        for (var ui = 20; ui < n; ui++) {
            uDates.push(rows[ui].time);
            uCloses.push(rows[ui].close);
        }
        bgHist.fillActual('us', uDates, uCloses);

        var base = clamp(M / 10, -1.2, 1.2);
        var pred = base * sigma * 0.8;
        var lo = clamp(pred - sigma * 0.4, -3.5, 3.5);
        var hi = clamp(pred + sigma * 0.4, -3.5, 3.5);

        // 预测落库（先算 pred 再 record）
        bgHist.record({
            ymd: dates[dates.length - 1],
            model: 'us',
            pred: pred,
            lo: Math.min(lo, hi),
            hi: Math.max(lo, hi),
            m: M,
            quad: quad
        });

        return {
            kind: 'us',
            date: dates[dates.length - 1],
            F: F, R: R, A: A, T: T, G: G, M: M,
            volUp: volUp, aboveMa: aboveMa,
            quad: quad, signal: signal,
            notes: notes,
            sigma: sigma,
            pred: pred, predLo: Math.min(lo, hi), predHi: Math.max(lo, hi),
            predText: predLabel(pred, lo, hi)
        };
    });
}

/* ================= 缓存 ================= */

var TTL = 10 * 60 * 1000;
var cache = { a: null, us: null };

function loadAGameCached() {
    if (cache.a && Date.now() - cache.a.ts < TTL) return Promise.resolve(cache.a.data);
    return loadAGame().then(function (d) {
        cache.a = { ts: Date.now(), data: d };
        return d;
    });
}

function loadUsGameCached() {
    if (cache.us && Date.now() - cache.us.ts < TTL) return Promise.resolve(cache.us.data);
    return loadUsGame().then(function (d) {
        cache.us = { ts: Date.now(), data: d };
        return d;
    });
}

module.exports = {
    loadAGame: loadAGameCached,
    loadUsGame: loadUsGameCached
};
