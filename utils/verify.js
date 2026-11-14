/**
 * 明日实操验证面板
 * 把「多空博弈模型」的底牌与盘面实时数据结合，三个检查点：
 *  ① 早盘承接（验证模型）：低开 + 早盘缩量 + 核心标的守住支撑 → 洗盘成立，模型 Q4 重启逻辑生效
 *  ② 量能回升（模型核心）：全天成交额同刻维持/放大 + 半导体主线翻红 → 偏涨预判兑现
 *  ③ 破位止损（防范惯性）：低开低走 + 放量跌破 5 日均线 → 执行防守（减仓/空仓）
 * 数据：上证指数日K（5日线）、flowBase 同刻量比、核心半导体标的实时行情
 */
var market = require('./market');

var SH_SEC = '1.000001';
var CORE_SECS = ['1.513310', '0.159995', '1.512480', '1.688825'];

/** 上证 MA5（最近 5 根已完成日K收盘价，始终排除最新一根，防盘中未收盘价污染） */
var ma5Cache = { at: 0, val: null };

function loadMa5() {
    if (ma5Cache.val !== null && Date.now() - ma5Cache.at < 5 * 60 * 1000) {
        return Promise.resolve(ma5Cache.val);
    }
    return market.fetchBars(SH_SEC, 101, 12).then(function (rows) {
        if (!rows || rows.length < 7) throw new Error('日K数据不足');
        var closes = [];
        for (var i = rows.length - 2; i >= 0 && closes.length < 5; i--) {
            closes.push(rows[i].close);
        }
        if (closes.length < 5) throw new Error('日K数据不足');
        var sum = 0;
        for (var j = 0; j < closes.length; j++) sum += closes[j];
        ma5Cache = { at: Date.now(), val: sum / 5 };
        return ma5Cache.val;
    });
}

/** 交易阶段：pre 盘前 / live 盘中 / closed 已收盘或休市 */
function stageOf(time) {
    var day = time.getDay();
    if (day === 0 || day === 6) return 'closed';
    var m = time.getHours() * 60 + time.getMinutes();
    if (m < 570) return 'pre';
    if (m > 900) return 'closed';
    return 'live';
}

function pctText(v, digits) {
    if (v === null || v === undefined || !isFinite(Number(v))) return '--';
    var d = digits === undefined ? 2 : digits;
    return (v > 0 ? '+' : '') + Number(v).toFixed(d) + '%';
}

function xText(v) {
    if (v === null || v === undefined || !isFinite(Number(v))) return '--';
    return Number(v).toFixed(2) + 'x';
}

/** 早盘时段下标：09:35 起 5 分钟一根，10:00 = 第 5 根 */
function morningIdx(flow) {
    if (!flow || !flow.today || !flow.prev) return -1;
    var idx = Math.min(5, flow.todayCount - 1);
    if (idx < 0) return -1;
    var t = flow.today[idx];
    var p = flow.prev[idx];
    if (t == null || p == null || p <= 0) return -1;
    return t / p;
}

/**
 * @param quotes  行情 map（secid -> quote）
 * @param flow    market.flowBase() 结果（可为 null）
 * @param time    当前时间
 * @param model   A股模型底牌 { pred, lo, hi, m, quad }（可为 null）
 */
function load(quotes, flow, time, model) {
    var stage = stageOf(time || new Date());
    var sh = quotes && quotes[SH_SEC];
    var cores = [];
    if (quotes) {
        for (var i = 0; i < CORE_SECS.length; i++) {
            var c = quotes[CORE_SECS[i]];
            if (c && isFinite(Number(c.price)) && isFinite(Number(c.prevClose)) && c.prevClose > 0) {
                cores.push(c);
            }
        }
    }
    var dayRatio = flow && isFinite(Number(flow.ratio)) ? Number(flow.ratio) : null;
    var mRatio = morningIdx(flow);

    return loadMa5().then(function (ma5) {
        return build(stage, sh, cores, dayRatio, mRatio, ma5, flow, time, model);
    }).catch(function () {
        return build(stage, sh, cores, dayRatio, mRatio, null, flow, time, model);
    });
}

function build(stage, sh, cores, dayRatio, mRatio, ma5, flow, time, model) {
    var stageText = stage === 'pre'
        ? '待开盘 · 9:30 后自动开始验证'
        : stage === 'live'
            ? '实时验证 · 盘中自动刷新'
            : '已收盘 · 保留今日结论';

    // ---------- ① 早盘承接 ----------
    var gapPct = (sh && isFinite(Number(sh.open)) && isFinite(Number(sh.prevClose)) && sh.prevClose > 0)
        ? (sh.open / sh.prevClose - 1) * 100
        : null;
    var holdCount = 0;
    for (var h = 0; h < cores.length; h++) {
        if (cores[h].price >= cores[h].prevClose) holdCount++;
    }
    var half = cores.length ? Math.ceil(cores.length / 2) : 2;
    var c1Lines = [
        { k: '开盘跳空', v: pctText(gapPct), cls: gapPct === null ? 'flat' : (gapPct >= 0 ? 'up' : 'down') },
        { k: '早盘量比(10:00)', v: xText(mRatio), cls: 'flat' },
        { k: '核心标的守昨收', v: cores.length ? holdCount + '/' + cores.length : '--', cls: 'flat' },
        { k: '上证现价/昨收', v: sh && sh.prevClose > 0 ? ((sh.price / sh.prevClose - 1) * 100).toFixed(2) + '%' : '--', cls: sh && sh.pct !== null && sh.pct !== undefined ? (sh.pct >= 0 ? 'up' : 'down') : 'flat' }
    ];
    var c1;
    if (stage === 'pre') {
        c1 = { key: 'c1', cls: 'pending', badge: '待验证', title: '① 早盘承接（验证模型）', lines: c1Lines };
    } else if (gapPct === null) {
        c1 = { key: 'c1', cls: 'flat', badge: '无数据', title: '① 早盘承接（验证模型）', lines: c1Lines };
    } else if (gapPct >= -0.05) {
        c1 = { key: 'c1', cls: 'flat', badge: '非低开', title: '① 早盘承接（验证模型）', lines: c1Lines };
    } else if (mRatio !== null && mRatio < 0.9 && holdCount >= half) {
        c1 = { key: 'c1', cls: 'ok', badge: '洗盘成立', title: '① 早盘承接（验证模型）', lines: c1Lines };
    } else if (mRatio !== null && mRatio >= 1) {
        c1 = { key: 'c1', cls: 'bad', badge: '放量下杀', title: '① 早盘承接（验证模型）', lines: c1Lines };
    } else if (holdCount < half) {
        c1 = { key: 'c1', cls: 'bad', badge: '核心破位', title: '① 早盘承接（验证模型）', lines: c1Lines };
    } else {
        c1 = { key: 'c1', cls: 'warn', badge: '观察中', title: '① 早盘承接（验证模型）', lines: c1Lines };
    }

    // ---------- ② 量能回升 ----------
    var mainCount = 0;
    for (var m2 = 0; m2 < cores.length; m2++) {
        if (Number(cores[m2].pct) >= 0.5) mainCount++;
    }
    var c2Lines = [
        { k: '同刻量比(vs' + (flow && flow.prevDate ? String(flow.prevDate).slice(5, 10) : '昨日') + ')', v: xText(dayRatio), cls: dayRatio === null ? 'flat' : (dayRatio >= 1 ? 'up' : 'down') },
        { k: '主线翻红(≥+0.5%)', v: cores.length ? mainCount + '/' + cores.length : '--', cls: 'flat' },
        { k: '上证现价', v: sh && isFinite(Number(sh.price)) ? Number(sh.price).toFixed(2) : '--', cls: 'flat' }
    ];
    var c2;
    if (stage === 'pre') {
        c2 = { key: 'c2', cls: 'pending', badge: '待验证', title: '② 量能回升（模型核心）', lines: c2Lines };
    } else if (dayRatio === null) {
        c2 = { key: 'c2', cls: 'flat', badge: '无数据', title: '② 量能回升（模型核心）', lines: c2Lines };
    } else if (dayRatio >= 1 && mainCount >= 2) {
        c2 = { key: 'c2', cls: 'ok', badge: '偏涨兑现', title: '② 量能回升（模型核心）', lines: c2Lines };
    } else if (mainCount >= 2 && dayRatio >= 0.9) {
        c2 = { key: 'c2', cls: 'warn', badge: '主线强量欠', title: '② 量能回升（模型核心）', lines: c2Lines };
    } else if (dayRatio >= 1) {
        c2 = { key: 'c2', cls: 'warn', badge: '放量无主线', title: '② 量能回升（模型核心）', lines: c2Lines };
    } else {
        c2 = { key: 'c2', cls: 'bad', badge: '量能不足', title: '② 量能回升（模型核心）', lines: c2Lines };
    }

    // ---------- ③ 破位止损 ----------
    var lowWalk = sh && isFinite(Number(sh.open)) && isFinite(Number(sh.price)) && isFinite(Number(sh.pct))
        ? (sh.price < sh.open && sh.pct < 0)
        : false;
    var heavy = dayRatio !== null && dayRatio >= 1.05;
    var breakMa5 = sh && ma5 !== null && isFinite(Number(sh.price)) ? sh.price < ma5 : false;
    var walkText = stage === 'pre' ? '--' : (lowWalk
        ? (gapPct !== null && gapPct < 0 ? '低开低走' : (gapPct !== null ? '高开低走' : '盘中走低'))
        : (gapPct !== null && gapPct < 0 ? '低开回稳' : (sh && sh.pct >= 0 ? '走强' : '回落')));
    var c3Lines = [
        { k: '5日均线', v: ma5 !== null ? ma5.toFixed(2) : '--', cls: 'flat' },
        { k: '现价 vs 5日线', v: ma5 !== null && sh ? (sh.price >= ma5 ? '上方 +' : '下方 ') + (((sh.price / ma5) - 1) * 100).toFixed(2) + '%' : '--', cls: breakMa5 ? 'down' : 'up' },
        { k: '走势', v: walkText, cls: lowWalk ? 'down' : 'up' },
        { k: '量能', v: dayRatio === null ? '--' : (heavy ? '放量' : (dayRatio < 0.85 ? '明显缩量' : '温和')), cls: heavy ? 'down' : 'flat' }
    ];
    var c3;
    if (stage === 'pre') {
        c3 = { key: 'c3', cls: 'pending', badge: '待验证', title: '③ 破位止损（防范惯性）', lines: c3Lines };
    } else if (lowWalk && heavy && breakMa5) {
        c3 = { key: 'c3', cls: 'bad', badge: '破位触发', title: '③ 破位止损（防范惯性）', lines: c3Lines };
    } else if (breakMa5 && (lowWalk || heavy)) {
        c3 = { key: 'c3', cls: 'warn', badge: '贴近破位', title: '③ 破位止损（防范惯性）', lines: c3Lines };
    } else {
        c3 = { key: 'c3', cls: 'ok', badge: '未触发', title: '③ 破位止损（防范惯性）', lines: c3Lines };
    }

    // ---------- 今日总结论：综合模型底牌 + 三项检查点，给出唯一可执行结论 ----------
    var dateLabel = (time || new Date());
    dateLabel = ('0' + (dateLabel.getMonth() + 1)).slice(-2) + '-' + ('0' + dateLabel.getDate()).slice(-2);
    var verdict = verdictOf(stage, c1, c2, c3, model);

    return {
        stage: stage,
        stageText: stageText,
        dateLabel: dateLabel,
        verdict: verdict,
        items: [c1, c2, c3]
    };
}

/** 脉冲市口径：只有门禁全亮且状态非 PULSE/DUMP/STARVE 时，模型才给方向 */
function modelGivesDirection(model) {
    if (!model) return false;
    if (model.gateScore !== undefined && model.gateScore !== null && Number(model.gateScore) < 6) return false;
    var st = model.regimeState;
    if (st === 'PULSE' || st === 'DUMP' || st === 'STARVE') return false;
    return true;
}

/** 模型底牌方向：pred 主判，M 兜底；门禁未全亮则不给方向 */
function modelDirOf(model) {
    if (!model) return null;
    if (!modelGivesDirection(model)) return null;
    var pred = Number(model.pred);
    if (isFinite(pred)) return pred > 0.05 ? 'up' : (pred < -0.05 ? 'down' : 'flat');
    var m = Number(model.m);
    if (isFinite(m)) return m >= 55 ? 'up' : (m <= 45 ? 'down' : 'flat');
    return null;
}

/** 模型底牌描述（放进结论 detail，让两个板块互相咬合） */
function modelChip(model) {
    if (!model) return '';
    var quad = model.quad ? String(model.quad) : '';
    var pred = Number(model.pred);
    var range = '';
    if (isFinite(pred) && isFinite(Number(model.lo)) && isFinite(Number(model.hi))) {
        range = ' 明日 ' + pred.toFixed(2) + '%（' + Number(model.lo).toFixed(2) + '% ~ ' + Number(model.hi).toFixed(2) + '%）';
    }
    // 脉冲市：状态机+门禁优先，幅度只作参考；门禁未全亮明确写「不给方向」
    if (model.regimeState) {
        var head = '模型：' + model.regimeState + (model.regimeLabel ? '（' + model.regimeLabel + '）' : '') +
            ' · 门禁 ' + (model.gateScore === undefined ? '--' : model.gateScore) + '/6 · ';
        return head + (modelGivesDirection(model) ? '可看方向' + range : '不给方向（等脉冲+确认）') + '。';
    }
    return '模型底牌：' + quad + range + '。';
}

/** 综合三项检查点 + 模型方向 → 一句话结论（优先级：防守 > 盘面强于模型 > 兑现 > 印证偏跌 > 洗盘 > 待确认 > 观察） */
function verdictOf(stage, c1, c2, c3, model) {
    if (stage === 'pre') {
        return { cls: 'pending', text: '待开盘验证', detail: '9:30 开盘后自动逐项验证，早盘 15 分钟量价结构是关键' };
    }
    var dir = modelDirOf(model);
    var chip = modelChip(model);
    var c3bad = c3.cls === 'bad';
    var c3warn = c3.cls === 'warn';
    var c2ok = c2.cls === 'ok';
    var c2bad = c2.cls === 'bad';
    var c1ok = c1.cls === 'ok';
    var c1bad = c1.cls === 'bad';

    // 防守优先：破位触发是最强信号，压过一切多头结论
    if (c3bad) {
        return { cls: 'bad', text: '执行防守 · 减仓/空仓', detail: chip + '破位止损已触发：走低+放量破5日线，下跌惯性优先，等真正企稳再回补' };
    }
    if (c3warn) {
        return { cls: 'warn', text: '收紧止损 · 贴近破位', detail: chip + '已破或贴近5日线，小仓试多动作降级为观望，破线放量即离场' };
    }
    if (c2ok) {
        if (dir === 'down') {
            return { cls: 'warn', text: '盘面强于模型 · 谨慎持多', detail: chip + '量能+主线已确认走强，短线以盘面为准、控制仓位，模型偏跌暂视为失效' };
        }
        return { cls: 'ok', text: '偏涨兑现 · 持多', detail: chip + '量能维持/放大且主线站出来，偏涨预判正在兑现，持股待涨' };
    }
    if (c1ok && c2bad) {
        if (dir === 'down') {
            return { cls: 'warn', text: '缩量洗盘 · 偏跌底牌未解除', detail: chip + '早盘承接健康（缩量+核心守住），说明不是恐慌出货；但全天量能未回升，反弹无量不追，缩量反弹到位不走强则兑现模型偏跌' };
        }
        return { cls: 'warn', text: '洗盘成立 · 持有不加仓', detail: chip + '早盘承接健康（缩量+核心守住），但全天量能未回升，模型 Q4 重启待量能确认' };
    }
    if (c1bad && c2bad) {
        return { cls: 'bad', text: '承接失败 · 偏空观望', detail: chip + '低开放量下杀或核心破位，且量能未回升，短线空头占优' + (dir === 'down' ? '，与模型偏跌共振' : '') };
    }
    if (c2bad) {
        if (dir === 'down') {
            return { cls: 'warn', text: '偏跌待确认 · 观望不追多', detail: chip + '今日量能不足且主线未站出，缩量反弹可信度低——反弹不放量则兑现模型偏跌区间；若后续放量转强则模型失效、恢复偏多' };
        }
        return { cls: 'warn', text: '中性偏谨慎 · 观望', detail: chip + '无破位风险但量能不足，模型信号未被盘面确认，持有者不动、空仓者不追' };
    }
    if (c1ok) {
        return { cls: 'ok', text: '洗盘成立 · 可多看一眼', detail: chip + '低开缩量+核心守住支撑，洗盘概率大，模型 Q4 重启逻辑生效' };
    }
    if (dir === 'down') {
        return { cls: 'warn', text: '观察确认 · 偏跌为主', detail: chip + '盘面暂无破位但量能未确认方向，模型偏跌为底牌，反弹无量则按模型执行' };
    }
    return { cls: 'warn', text: '观察确认 · 等量能回升', detail: chip + '模型给的是底牌倾向，等量能或主线给出方向后再执行' };
}

module.exports = {
    load: load
};
