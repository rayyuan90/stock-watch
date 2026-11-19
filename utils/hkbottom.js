/**
 * 港股科技 · 底部研判模型
 * ------------------------------------------------------------------
 * 数据快照：2026-11-19（研究结论，静态研判，不随实时行情变动）
 * 框架：三层底 = 估值底 / 资金底 / 叙事底
 *
 * 核心判断（放最前面，避免误读）：
 *   估值处在历史 6%–9% 分位，听着极便宜，但这不是底——
 *   2021–2022 那轮 PE 从 48 倍砍到 37 倍才刚刚开始跌。
 *   低估值只说明「如果盈利不再下修，这里很便宜」，
 *   真正的关键变量是分母（盈利）是否还在往下走 → 叙事底才是核心矛盾。
 *
 * 底部概率 = 三层底加权到达度。权重刻意体现「低估值 ≠ 底」：
 *   叙事底（盈利/资本开支/自由现金流）权重最高，估值底最低。
 *   三层全到才算「确认大底」，只到估值底属于左侧磨底。
 */

var AS_OF = '2026-11-19';

// 综合底部概率：权重 × 到达度（研究结论更新时改这里即可）
var WEIGHTS = { valuation: 20, capital: 30, narrative: 50 };
var ARRIVAL = { valuation: 100, capital: 40, narrative: 5 };

// 关键坐标（钉死当下的位置）
var ANCHOR_ROWS = [
    { k: '恒科收盘', v: '3651.6', note: '七连跌' },
    { k: '盘中最低', v: '3639.58', note: '' },
    { k: '11/5 高点', v: '4168', note: '回撤 -12.4%' },
    { k: '区间振幅', v: '14%', note: '' },
    { k: 'PE-TTM', v: '19.07–19.77 倍', note: '近5年 6.51% 分位' },
    { k: 'PE 极长分位', v: '2010年来 9%', note: '' },
    { k: 'PB', v: '2.05 倍', note: '2010年来 7% 分位' },
    { k: '对照 2022/10', v: '2720 点', note: '当时 PE 约 20–23 倍' }
];

// 三层底
var LAYERS = [
    {
        key: 'valuation',
        name: '估值底',
        status: '已到',
        statusCls: 'done',
        progress: ARRIVAL.valuation,
        weight: WEIGHTS.valuation,
        oneLine: '19 倍 PE、6.5% 分位，已跌破 2022/10 的 2720 点时的估值水平',
        points: [
            'PE-TTM 19.07–19.77 倍，近 5 年分位 6.51%，2010 年以来分位 9%',
            'PB 2.05 倍，2010 年以来 7% 分位',
            '这一层不需要再验证：估值维度已经到位'
        ],
        caveat: '坑：估值低不是底。2021–2022 那轮 PE 从 48 倍砍到 37 倍才刚开始跌。低分位只说明「盈利不下修的话这里很便宜」，关键变量是分母（盈利）还在不在下修。'
    },
    {
        key: 'capital',
        name: '资金底',
        status: '磨底中',
        statusCls: 'grinding',
        progress: ARRIVAL.capital,
        weight: WEIGHTS.capital,
        oneLine: '被动资金已到底，主动资金还没回来；南向越跌越买但总量急剧萎缩',
        points: [
            '南向越跌越买：11/18 净买 27.51 亿（腾讯 8.66 / 阿里 3.29 / 中芯 7.43），11/19 再超 40 亿',
            '13 个交易日里 7 日净流入；最大单日流出 67.66 亿(11/9)、最大流入 49.5 亿(11/16)',
            '但总量萎缩：8 月南向净流入从 7 月 80 亿美元断崖到 13 亿美元；前 8 月累计约 480 亿美元，仅 2025 同期 39%',
            '外资被动进、主动出：Q3 持股约 16.9 万亿、占比 56%（环比升）；长线稳定外资流入 861 亿，短线灵活外资流出 908 亿',
            '主动低配扩大：中国低配 1.0pct、EM 基金低配 1.8pct；8 月阿里主动权重 -1.7%、腾讯 -0.7%（当月减仓之最）',
            '瑞银跟踪约 800 只外资主动基金：495 只低配中国，AUM 合计 2.5 万亿美元，平均低配 3.5pct',
            '大行密集唱多窗口期，EPFR 口径主动资金连续 6 周净流出，被动流入盖不住主动抛售'
        ],
        caveat: '信号：被动资金已到底（指数调仓驱动，不论贵贱），主动资金还没回来。历史上主动外资回补总滞后估值底 2–3 个季度。'
    },
    {
        key: 'narrative',
        name: '叙事底',
        status: '未到',
        statusCls: 'absent',
        progress: ARRIVAL.narrative,
        weight: WEIGHTS.narrative,
        oneLine: '市场不按利润定价，按「资本开支三年后换回多少利润」定价 → 卡在估值真空',
        points: [
            '腾讯 Q3 营收 2073 亿(+8%)，资本开支 814.33 亿（同比 +527%、环比 +54%），远超预期 554 亿',
            '前三季资本开支累计 1661.53 亿(+179%)；自由现金流净流出 691 亿（经营现金流仅 26 亿，被 651 亿资本开支付款吃掉），剔除算力预付款后 +169 亿',
            '腾讯非 IFRS 经营利润 680.73 亿(-6%)，一、二季度均为 +9%',
            '阿里 2027 财年 Q1 资本开支 99.4 亿美元、自由现金流 -65.7 亿美元；2026 财年自由现金流 -71.4 亿美元',
            '马化腾：「不投入拥抱就是被颠覆，这是生死存亡的问题」——管理层明确还要继续投，利润率底还没到'
        ],
        caveat: '核心矛盾：这个问题在 2027 年前既无法证伪也无法证实，所以卡在估值真空。不管自由现金流转正还是资本开支见顶，都要跌的机理就在这里。'
    }
];

// 底部信号清单（逐日 / 逐季可验证）
var SIGNALS = [
    {
        key: 'A',
        title: 'A 类 · 高频日度信号',
        sub: '这两周就能看',
        items: [
            { name: '恒科点位 / 量能', now: '3651，成交 325 亿（缩量）', threshold: '破 3400 后放量收回，或缩量到 250 亿以下横盘 2 周' },
            { name: '南向连续性', now: '13 日里 7 日净流入', threshold: '连续 5 日以上净流入且单日均超 50 亿' },
            { name: '中概 ETF 折价', now: '513050 折价 1.69%–3.62%（11/12 最深 3.62%）', threshold: '折价收敛到 1% 以内（恐慌盘出清）' },
            { name: 'ETF 份额', now: '513050 从 357.5 增至 371.7 亿份，创 60 日新高', threshold: '份额停止增长甚至回落（抄底盘开始撤，见底前兆）' },
            { name: '恒科成份扩容', now: '11/20 公布检讨、12/7 生效，30→50 只', threshold: '硬科技权重提升，或带来被动资金重配' }
        ],
        note: '负反馈要看破：513050 份额暴增（11/6→11/17 从 357.66 加到 371.68 亿份）但价格一路跌、折价扩大到 3.6%——「越跌越申购、申购越多跌越狠」，场外接、场内砸。要等份额增长停滞、折价自然收敛，才算场内抛压衰竭。'
    },
    {
        key: 'B',
        title: 'B 类 · 季度财务信号',
        sub: '决定叙事底',
        items: [
            { name: '腾讯资本开支环比见顶', now: 'Q3 为 814 亿', threshold: 'Q4 或 2027Q1 环比回落，且管理层给出「投入高峰已过」指引' },
            { name: '真实自由现金流转正', now: 'Q3 经营现金流仅 26 亿', threshold: '回到 500 亿以上量级（不靠剔除预付款口径）' },
            { name: '云与 AI 收入利润率', now: '阿里云 EBITA 率约 9%', threshold: '抬到 13%+；腾讯金融科技与企业服务毛利率抬升' },
            { name: 'AI 高毛利收入块', now: '仍以倒卖 GPU 算力为主', threshold: '出现 WorkBuddy / MaaS / 广告重构带来的高毛利增量' },
            { name: '阿里四季报', now: '通常 11 月中下旬发布', threshold: '若资本开支指引继续上修，恒科还有一跌' }
        ],
        note: ''
    },
    {
        key: 'C',
        title: 'C 类 · 宏观与制度信号',
        sub: '决定外部抽水何时停',
        items: [
            { name: '美债 10 年期', now: '5.1%–5.3%', threshold: '回到 4.8% 以下（最硬的一条：港股是离岸市场，贴现率一抬远期现金流现值砍半）' },
            { name: '美国 CPI / 加息定价', now: '通胀超预期是这波回吐的直接触发', threshold: 'CPI 回落、加息定价消退' },
            { name: '外资主动基金低配', now: '低配 1.0pct', threshold: '收窄到 0.5 以内' },
            { name: '南向定价权', now: '已占恒指成交额 37.04%', threshold: '稳定在 40% 以上' },
            { name: '政策端', now: '—', threshold: '平台经济表态、算力采购定向订单、南向通扩容' }
        ],
        note: ''
    }
];

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

/** 综合底部概率（0–100）+ 结论分档 */
function probInfo() {
    var raw = 0;
    for (var i = 0; i < LAYERS.length; i++) {
        var l = LAYERS[i];
        raw += (ARRIVAL[l.key] || 0) * (WEIGHTS[l.key] || 0) / 100;
    }
    var prob = Math.round(clamp(raw, 0, 100));
    var label, cls, verdict;
    if (prob >= 70) {
        label = '底部大概率已现'; cls = 'up';
        verdict = '三层底多数到位，可按计划分批布局，回踩不破前低即确认。';
    } else if (prob >= 45) {
        label = '接近底部区域'; cls = 'up';
        verdict = '估值与资金改善，叙事仍待验证，左侧可小仓试探、留足子弹。';
    } else if (prob >= 30) {
        label = '左侧磨底'; cls = 'warn';
        verdict = '估值底已现，叙事底未到——只具备「便宜」，不具备「确认」，以观察为主、不追反弹。';
    } else {
        label = '底部未到'; cls = 'down';
        verdict = '核心矛盾（盈利与资本开支）未见拐点，估值便宜不构成买入理由，继续等信号。';
    }
    var arrived = 0;
    for (var j = 0; j < LAYERS.length; j++) if (ARRIVAL[LAYERS[j].key] >= 60) arrived++;
    return {
        prob: prob,
        probText: prob + '%',
        label: label,
        cls: cls,
        barPct: prob,
        verdict: verdict,
        layerCount: arrived + '/3 层到达',
        confirmed: arrived >= 3
    };
}

/** 生成页面可直接渲染的研判对象 */
function build() {
    var p = probInfo();
    var layers = [];
    for (var i = 0; i < LAYERS.length; i++) {
        var l = LAYERS[i];
        layers.push({
            key: l.key,
            name: l.name,
            status: l.status,
            statusCls: l.statusCls,
            progress: l.progress,
            weight: l.weight,
            oneLine: l.oneLine,
            points: l.points,
            caveat: l.caveat
        });
    }
    return {
        asOf: AS_OF,
        prob: p.prob,
        probText: p.probText,
        label: p.label,
        cls: p.cls,
        barPct: p.barPct,
        verdict: p.verdict,
        layerCount: p.layerCount,
        confirmed: p.confirmed,
        layers: layers,
        anchorRows: ANCHOR_ROWS,
        signals: SIGNALS
    };
}

module.exports = {
    AS_OF: AS_OF,
    WEIGHTS: WEIGHTS,
    ARRIVAL: ARRIVAL,
    LAYERS: LAYERS,
    SIGNALS: SIGNALS,
    probInfo: probInfo,
    build: build
};
