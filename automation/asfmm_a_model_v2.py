# -*- coding: utf-8 -*-
"""
ASFMM-A v2 : A股资金燃料-动量模型 (增强版)
==========================================================
v2 相对 v1 的三处升级
  [1] 大资金层 BIG
        big_order_net  : 主力大单净流入 (亿元)
        north_net      : 北向资金净流入 (亿元)
        etf_broad_sub  : 宽基ETF净申购 (亿元)
        三者合成 BIG 分位, 作为流入强度 R 的"质量校验"
        —— 散户情绪能把成交额推上去, 但推不动 BIG.
           R 高 + BIG 低 = 虚量, 自动降级为"情绪虚火".

  [2] 政策向量 PolicyVector (替代 bool policy_window)
        不再是"一刀切降权50%", 而是
        direction  : +1 流动性红利 / -1 监管打压 / 0 无
        channel    : 政策作用的通道 (R / E / G / P)
        strength   : 0~3 力度
        decay      : 半衰期(天), 政策效力随时间衰减
        分通道调节: 降准打 R/P, 打压打 E/A, 纾困打 G ...
        同一天可以叠加多条政策 (policy_stack)

  [3] 数据接入层 datasource.py
        自动抓取两融 / 宽基ETF申赎 / 全A快照(涨停·炸板·连板) / 解禁
        字段缺失时降级为中性 50, 并在 data_quality 里标注

四象限 (横轴 R, 纵轴 A):
  Q1 加速主升 : R高 A>0   -> 持多
  Q2 天量滞涨 : R高 A<0   -> 减仓  (最关键)
  Q3 缩量耗尽 : R低 A<0   -> 空仓
  Q4 地量重启 : R低 A>0   -> 试多

A股特有处理 (沿用 v1):
  1. 涨停板扭曲价格 -> R 用资金合成, 不用纯价格
  2. 期指净空 != 看空 -> 只看基差, 不看净空手数
  3. 政策 -> 分类向量, 分通道调节 (v2 升级)

注意: 所有"分位"输入 0~100, 越高代表该指标绝对值越大.
      P 内部会自动反向 (仓位越高 -> 空间越小).
"""

from dataclasses import dataclass, field
from typing import List, Optional, Dict, Tuple

# ============================================================
# 工具函数
# ============================================================
def ema(values: List[float], span: int = 3) -> List[float]:
    """指数移动平均, 用于平滑 R / E / BIG, 压噪音"""
    if not values:
        return []
    k = 2.0 / (span + 1.0)
    out = [values[0]]
    for v in values[1:]:
        out.append(out[-1] * (1 - k) + v * k)
    return out


def clamp(x: float, lo: float = 0.0, hi: float = 100.0) -> float:
    return max(lo, min(hi, x))


def pct_rank_label(v: float) -> str:
    if v >= 80:
        return "极高"
    if v >= 60:
        return "偏高"
    if v >= 40:
        return "中性"
    if v >= 20:
        return "偏低"
    return "极低"


# ============================================================
# [2] 政策向量
# ============================================================
# 通道常量
CH_R = "R"   # 流入强度
CH_E = "E"   # 情绪温度
CH_G = "G"   # 卖压再生 (负向调节: 纾困降低卖压)
CH_P = "P"   # 仓位空间 (流动性放松 -> 空间实际扩大)

# 政策类型库: 名称 -> (方向, 主通道, 默认力度, 半衰期天, 说明)
POLICY_LIBRARY: Dict[str, dict] = {
    # ---- 流动性红利 (direction = +1) ----
    "RRR_CUT":        dict(direction=+1, channel=CH_P, strength=3, decay=20,
                           label="降准", note="释放长期流动性, 扩大仓位空间上限"),
    "RATE_CUT":       dict(direction=+1, channel=CH_R, strength=3, decay=15,
                           label="降息", note="降低资金成本, 直接抬升流入强度"),
    "SFISF":          dict(direction=+1, channel=CH_R, strength=3, decay=12,
                           label="互换便利/回购增持再贷款", note="两类资本市场工具, 机构增量弹药"),
    "STRUCTURAL_EASE": dict(direction=+1, channel=CH_R, strength=2, decay=10,
                           label="结构性工具扩容降息", note="定向支持科技/小微, 中等力度"),
    "NATIONAL_TEAM":  dict(direction=+1, channel=CH_R, strength=3, decay=5,
                           label="国家队/汇金增持ETF", note="直接买盘, 效力强但衰减快"),
    "TRADING_COST_CUT": dict(direction=+1, channel=CH_E, strength=1, decay=8,
                           label="降印花税/降费", note="情绪催化, 一次性"),
    "IPO_PAUSE":      dict(direction=+1, channel=CH_G, strength=2, decay=15,
                           label="IPO/再融资节奏放缓", note="降低供给, 削减卖压"),
    "STOCK_PLEDGE_RELIEF": dict(direction=+1, channel=CH_G, strength=2, decay=12,
                           label="纾困/股权质押风险缓解", note="强平卖压下降"),
    "LONG_FUND_GUIDE": dict(direction=+1, channel=CH_P, strength=2, decay=25,
                           label="中长期资金入市指引", note="慢变量, 抬升仓位空间天花板"),
    # ---- 监管打压 (direction = -1) ----
    "SPECULATION_CRACKDOWN": dict(direction=-1, channel=CH_E, strength=3, decay=8,
                           label="打击过度炒作/操纵", note="直接摧毁情绪与连板生态"),
    "QUANT_TIGHTEN":  dict(direction=-1, channel=CH_E, strength=2, decay=15,
                           label="高频量化监管收紧", note="微观流动性下降, 小盘承压"),
    "SMALL_CAP_CRACKDOWN": dict(direction=-1, channel=CH_E, strength=3, decay=10,
                           label="整顿小市值炒作", note="微盘股情绪断层"),
    "MARGIN_TIGHTEN": dict(direction=-1, channel=CH_R, strength=2, decay=12,
                           label="两融/杠杆收紧", note="直接削减流入强度"),
    "CLEARING_CRACKDOWN": dict(direction=-1, channel=CH_G, strength=2, decay=10,
                           label="减持/清仓式减持整治", note="注: 整治减持实为减卖压, 若方向填-1需自行判断"),
    "SECTOR_COOLING": dict(direction=-1, channel=CH_E, strength=2, decay=6,
                           label="行业窗口指导降温", note="主题情绪快速退潮"),
    # ---- 外部冲击 (可自定义) ----
    "CUSTOM":         dict(direction=-1, channel=CH_E, strength=1, decay=5,
                           label="自定义冲击", note="自行填写方向与通道"),
}


@dataclass
class PolicyVector:
    """单条政策向量. age=0 表示当天生效."""
    ptype: str = "CUSTOM"
    direction: int = 0            # +1 利多 / -1 利空
    channel: str = CH_E           # R / E / G / P
    strength: float = 1.0         # 0~3
    decay: float = 5.0            # 半衰期(天)
    age: float = 0.0              # 已生效天数
    note: str = ""

    @classmethod
    def from_library(cls, ptype: str, age: float = 0.0,
                     strength: Optional[float] = None,
                     direction: Optional[int] = None) -> "PolicyVector":
        lib = POLICY_LIBRARY.get(ptype, POLICY_LIBRARY["CUSTOM"])
        return cls(
            ptype=ptype,
            direction=direction if direction is not None else lib["direction"],
            channel=lib["channel"],
            strength=strength if strength is not None else lib["strength"],
            decay=lib["decay"],
            age=age,
            note=lib["label"],
        )

    def weight(self) -> float:
        """时间衰减权重: 半衰期模型 0.5^(age/decay)"""
        return 0.5 ** (self.age / max(self.decay, 0.1))

    def delta(self, base: float) -> float:
        """对某通道基准分(0~100)的调节量. 力度3 -> 满衰减时约 ±18 分"""
        return self.direction * self.strength * 6.0 * self.weight() * (base / 100.0)


def describe_policy_stack(stack: List[PolicyVector]) -> str:
    if not stack:
        return "无政策叠加"
    parts = []
    for p in stack:
        tag = "利多" if p.direction > 0 else ("利空" if p.direction < 0 else "中性")
        parts.append(f"{p.note}({tag}·{p.channel}·力度{p.strength:.0f}·衰减{p.weight()*100:.0f}%)")
    return " ; ".join(parts)


# ============================================================
# 输入数据结构
# ============================================================
@dataclass
class DailyInput:
    """单日输入. 分位字段单位 0~100, 资金字段单位 亿元."""
    # ---- 燃料: 仓位空间 ----
    margin_pct_rank: float = 50.0      # 两融占流通市值 分位
    fund_equity_rank: float = 50.0     # 公募股票仓位 分位 (季频, 用最近值)
    turnover_amt_rank: float = 50.0    # 成交额 20日分位
    swap_rate_rank: float = 50.0       # 换手率 分位

    # ---- 流入: 增量资金 ----
    d_margin: float = 0.0              # 两融余额变化 (亿元)
    etf_net_subscribe: float = 0.0     # 宽基ETF 净申购 (亿元)  <-- v2 明确为宽基
    amt_over_ma20: float = 0.0         # 成交额 - 20日均 (亿元)
    new_fund_issue: float = 0.0        # 新发基金 (亿元)
    float_mv: float = 800000.0         # 流通市值 (亿元), 用于归一化

    # ---- [1] 大资金层 (v2 新增) ----
    big_order_net: float = 0.0         # 主力大单净流入 (亿元)
    north_net: float = 0.0             # 北向资金净流入 (亿元)
    big_order_net_rank: float = 50.0   # 大单净流入 分位 (0~100)
    north_net_rank: float = 50.0       # 北向净流入 分位 (0~100)
    etf_sub_rank: float = 50.0        # 宽基ETF净申购 分位 (0~100)

    # ---- 情绪: A股特有 ----
    limit_up_cnt: float = 50.0         # 涨停家数
    max_board: float = 3.0             # 最高连板高度
    broken_rate: float = 30.0          # 炸板率 (%)
    up_ratio_rank: float = 50.0        # 上涨家数占比 分位

    # ---- 卖压: 再生 ----
    unlock_5d_rank: float = 50.0       # 未来5日解禁 分位
    reduce_amt_rank: float = 50.0      # 减持公告金额 分位
    margin_force_rank: float = 50.0    # 两融强平压力 分位
    profit_float_rank: float = 50.0    # 获利盘浮盈 分位

    # ---- 状态 ----
    index_below_ma20: bool = False     # 指数是否跌破20日线
    index_below_ma5: bool = False      # 指数是否跌破5日线
    # v2: 保留 bool 字段仅为向后兼容; 有 policy_stack 时优先用 stack
    policy_window: bool = False
    policy_stack: List[PolicyVector] = field(default_factory=list)

    # ---- v2: 数据质量 (由 datasource 填充) ----
    data_quality: Dict[str, str] = field(default_factory=dict)


# ============================================================
# 模型主体
# ============================================================
@dataclass
class ASFMM_A:
    # 燃料权重
    w_margin: float = 0.30
    w_fund: float = 0.25
    w_amt: float = 0.25
    w_swap: float = 0.20

    # 流入权重
    r_margin: float = 0.35
    r_etf: float = 0.25
    r_amt: float = 0.25
    r_newfund: float = 0.15

    # [1] 大资金层权重
    b_big: float = 0.40
    b_north: float = 0.30
    b_etf: float = 0.30
    big_confirm_th: float = 55.0    # BIG 低于此值即判定"虚量"
    big_boost_th: float = 70.0      # BIG 高于此值视为"真金白银", 允许升档

    # 情绪权重
    e_limit: float = 0.30
    e_board: float = 0.25
    e_broken: float = 0.25
    e_up: float = 0.20

    # 卖压权重
    g_unlock: float = 0.30
    g_reduce: float = 0.30
    g_force: float = 0.20
    g_profit: float = 0.20

    # 综合动量权重
    m_P: float = 0.20
    m_R: float = 0.25
    m_A: float = 0.25
    m_E: float = 0.15
    m_Ep: float = 0.15
    m_G: float = 0.20   # 反向
    m_BIG: float = 0.10  # [1] 大资金确认项
    M_cap: float = 100.0  # M 上限裁剪: 分位加总天然封顶 100, 不裁会出现 M>100 的假强信号

    # 阈值
    P_danger: float = 30.0        # 燃料告急线
    R_th: float = 3.0             # 流入强度阈值 (%/日 等价分位)
    A_th: float = -1.5            # 加速度阈值
    limit_warn: float = 50.0      # 涨停警戒 (家)
    broken_warn: float = 30.0     # 炸板警戒 (%)
    policy_discount: float = 0.5  # 仅向后兼容: bool 模式下的整体降权

    # 内部历史
    _hist_R: List[float] = field(default_factory=list)
    _hist_E: List[float] = field(default_factory=list)
    _ema_R: Optional[float] = None
    _ema_E: Optional[float] = None
    _neg_A_streak: int = 0
    # 政策通道基准分缓存 (由 step 在每次计算前写入)
    _last_RE: Dict[str, float] = field(default_factory=lambda: {"R": 50.0, "E": 50.0})
    _last_P: Optional[float] = None
    _last_G: Optional[float] = None

    # --------------------------------------------------------
    # 0. 政策调节量 (分通道, 带时间衰减)
    # --------------------------------------------------------
    def _policy_deltas(self, d: DailyInput) -> Dict[str, float]:
        stack = list(d.policy_stack)
        # 向后兼容: 老的 bool 字段等价为"一次未知方向降温", 只压情绪
        if not stack and d.policy_window:
            stack.append(PolicyVector(ptype="CUSTOM", direction=-1, channel=CH_E,
                                      strength=1.0, decay=5.0, note="政策窗口(未分类)"))
        deltas = {CH_R: 0.0, CH_E: 0.0, CH_G: 0.0, CH_P: 0.0}
        for p in stack:
            # 通道基准分: 用"可被调节的空间", 不是当前绝对值
            #   R/E: 从当前分位往中性 50 靠 (已经高的更难再抬, 已经低的更容易被打下去)
            #   P  : 用"未占用空间"即 100-P 的相对量, 这里统一用 50 作中性基准
            #   G  : 卖压越高, 纾困政策的边际效果越大
            if p.channel in (CH_R, CH_E):
                cur = self._last_RE.get(p.channel, 50.0)
                base = 100.0 - cur if p.direction > 0 else cur
            elif p.channel == CH_P:
                cur = self._last_P if self._last_P is not None else 50.0
                base = 100.0 - cur if p.direction > 0 else cur
            else:  # CH_G: 高卖压时纾困更有效; 打压类作用于 G 时按现有卖压放大
                cur = self._last_G if self._last_G is not None else 50.0
                base = cur
            deltas[p.channel] += p.direction * p.strength * 6.0 * p.weight() * (base / 100.0)
        return deltas

    # --------------------------------------------------------
    # 1. 仓位空间 P (燃料存量, 高分位 = 空间大)
    # --------------------------------------------------------
    def calc_P(self, d: DailyInput, pol: Dict[str, float]) -> float:
        occupied = (self.w_margin * d.margin_pct_rank
                    + self.w_fund * d.fund_equity_rank
                    + self.w_amt * d.turnover_amt_rank
                    + self.w_swap * d.swap_rate_rank)
        p = 100.0 - occupied
        # 流动性红利扩大空间天花板; 杠杆收紧压缩空间
        return clamp(p + pol[CH_P])

    # --------------------------------------------------------
    # 2. 流入强度 R
    # --------------------------------------------------------
    def calc_R_raw(self, d: DailyInput) -> float:
        net = (self.r_margin * d.d_margin
               + self.r_etf * d.etf_net_subscribe
               + self.r_amt * d.amt_over_ma20
               + self.r_newfund * d.new_fund_issue)
        return net / d.float_mv * 100.0   # 单位: %

    def calc_R_score(self, r_raw: float) -> float:
        """把 % 映射到 0~100 分位式强度. 0.05% 视为中性50, 每 0.02% 约 10 分."""
        return clamp(50.0 + (r_raw - 0.05) / 0.02 * 10.0)

    # --------------------------------------------------------
    # [1] 大资金确认层 BIG
    # --------------------------------------------------------
    def calc_BIG(self, d: DailyInput) -> float:
        return clamp(self.b_big * d.big_order_net_rank
                     + self.b_north * d.north_net_rank
                     + self.b_etf * d.etf_sub_rank)

    def big_gate(self, R_score: float, BIG: float) -> (float, str):
        """
        大资金闸门: 用 BIG 校验 R 的成色
          R 低 + BIG 低 -> 真弱, 维持
          R 高 + BIG 低 -> 虚量(散户/游资推动), 打折
          R 高 + BIG 高 -> 真金白银, 允许小幅升档
        """
        r_high = R_score >= 50.0
        if r_high and BIG < self.big_confirm_th:
            adj = R_score * (0.55 + 0.45 * BIG / self.big_confirm_th)
            return adj, f"⚠虚量折价: R {R_score:.0f}->{adj:.0f} (大资金仅{BIG:.0f})"
        if r_high and BIG >= self.big_boost_th:
            adj = min(100.0, R_score * 1.08)
            return adj, f"大资金确认: R {R_score:.0f}->{adj:.0f}"
        return R_score, "大资金中性"

    # --------------------------------------------------------
    # 3. 情绪温度 E
    # --------------------------------------------------------
    def calc_E_raw(self, d: DailyInput) -> float:
        """不含政策调节的纯情绪分位, 用作政策通道基准"""
        limit_score = clamp(d.limit_up_cnt / 100.0 * 100.0)
        board_score = clamp(d.max_board / 8.0 * 100.0)
        broken_score = clamp(100.0 - d.broken_rate)
        e = (self.e_limit * limit_score
             + self.e_board * board_score
             + self.e_broken * broken_score
             + self.e_up * d.up_ratio_rank)
        return clamp(e)

    def calc_E(self, d: DailyInput, pol: Dict[str, float]) -> float:
        # 监管打压 / 情绪催化 直接作用于 E
        return clamp(self.calc_E_raw(d) + pol[CH_E])

    # --------------------------------------------------------
    # 4. 卖压再生 G (高 = 卖压大)
    # --------------------------------------------------------
    def calc_G(self, d: DailyInput, pol: Dict[str, float]) -> float:
        g = (self.g_unlock * d.unlock_5d_rank
             + self.g_reduce * d.reduce_amt_rank
             + self.g_force * d.margin_force_rank
             + self.g_profit * d.profit_float_rank)
        # 纾困/IPO放缓 等降低卖压 (pol[CH_G] 为负即减压)
        return clamp(g + pol[CH_G])

    # --------------------------------------------------------
    # 5. 综合动量 M
    # --------------------------------------------------------
    def calc_M(self, P, R_score, A, E, Ep, G, BIG) -> float:
        raw = (self.m_P * P
                + self.m_R * R_score
                + self.m_A * (50.0 + A * 10.0)
                + self.m_E * E
                + self.m_Ep * (50.0 + Ep * 10.0)
                - self.m_G * G
                + self.m_BIG * (BIG - 50.0))
        return clamp(raw, -self.M_cap, self.M_cap)

    # --------------------------------------------------------
    # 数据质量闸门: 慢变量缺失过多时, M 不可用于方向判断
    # --------------------------------------------------------
    @staticmethod
    def quality_gate(d: DailyInput) -> Tuple[bool, List[str]]:
        """返回 (是否可用于方向判断, 缺失字段清单).
        中性 50 本身不偏多也不偏空, 但 BIG/G 同时缺失时,
        模型的"虚量折价"和"卖压"两道防线全部失效, 此时 M 只反映情绪脉冲."""
        missing = []
        if d.data_quality:
            for k, v in d.data_quality.items():
                if v != "ok" and not v.startswith("ok"):
                    missing.append(f"{k}({v})")
        critical = [m for m in missing if any(s in m for s in
                    ["大单", "ETF", "两融", "解禁", "浮盈", "NaN"])]
        return (len(critical) <= 2), critical

    # --------------------------------------------------------
    # 象限判定
    # --------------------------------------------------------
    def quadrant(self, R_score: float, A: float) -> str:
        r_high = R_score >= 50.0
        if r_high and A > 0:
            return "Q1 加速主升"
        if r_high and A <= 0:
            return "Q2 天量滞涨"
        if (not r_high) and A <= 0:
            return "Q3 缩量耗尽"
        return "Q4 地量重启"

    # --------------------------------------------------------
    # 单日计算
    # --------------------------------------------------------
    def step(self, d: DailyInput, verbose: bool = True) -> dict:
        # 先用未调节的原始分位做政策基准, 再算调节量 (避免自我放大)
        self._last_RE = {"R": self.calc_R_score(self.calc_R_raw(d)),
                         "E": self.calc_E_raw(d)}
        self._last_P = 100.0 - (self.w_margin * d.margin_pct_rank
                                + self.w_fund * d.fund_equity_rank
                                + self.w_amt * d.turnover_amt_rank
                                + self.w_swap * d.swap_rate_rank)
        self._last_G = (self.g_unlock * d.unlock_5d_rank
                        + self.g_reduce * d.reduce_amt_rank
                        + self.g_force * d.margin_force_rank
                        + self.g_profit * d.profit_float_rank)
        pol = self._policy_deltas(d)

        P = self.calc_P(d, pol)
        r_raw = self.calc_R_raw(d)
        R_score = self.calc_R_score(r_raw)
        BIG = self.calc_BIG(d)
        R_adj, big_msg = self.big_gate(R_score, BIG)
        E = self.calc_E(d, pol)

        # 加速度: EMA 平滑后差分 (避免单点初始化失真)
        k = 2.0 / (3 + 1.0)
        prev_ema_R = self._ema_R
        prev_ema_E = self._ema_E
        if prev_ema_R is None:
            self._ema_R = R_adj
            self._ema_E = E
            A = 0.0
            Ep = 0.0
        else:
            self._ema_R = prev_ema_R * (1 - k) + R_adj * k
            self._ema_E = prev_ema_E * (1 - k) + E * k
            A = self._ema_R - prev_ema_R
            Ep = self._ema_E - prev_ema_E
        self._hist_R.append(R_adj)
        self._hist_E.append(E)

        if A < 0:
            self._neg_A_streak += 1
        else:
            self._neg_A_streak = 0

        G = self.calc_G(d, pol)
        M = self.calc_M(P, R_adj, A, E, Ep, G, BIG)
        quad = self.quadrant(R_adj, A)

        # ---- 告警 ----
        alerts: List[str] = []
        if R_score >= 60 and E < 45:
            alerts.append("🔴 资金强撑情绪退: 顶部前兆, 指数靠权重撑, 赚钱效应已散")
        if R_adj < R_score - 1:
            alerts.append(f"🟠 {big_msg}")
        if d.big_order_net < -200:
            alerts.append(f"🔴 主力大单净流出 {abs(d.big_order_net):.0f}亿: 机构在卖, 反弹不可信")
        if d.north_net < -50:
            alerts.append(f"🟠 北向净流出 {abs(d.north_net):.0f}亿: 外资减仓")
        if d.etf_net_subscribe < -20:
            alerts.append(f"🟠 宽基ETF净赎回 {abs(d.etf_net_subscribe):.0f}亿: 配置盘撤退")
        if (d.turnover_amt_rank >= 80 and d.limit_up_cnt < self.limit_warn):
            alerts.append("🔴 天量滞涨: 成交额高位 + 涨停家数萎缩, Q2典型")
        if d.broken_rate > self.broken_warn:
            alerts.append(f"🟠 炸板率 {d.broken_rate:.0f}% > {self.broken_warn:.0f}%: 情绪转弱")
        if d.max_board <= 3:
            alerts.append("🟠 连板高度冰点: 高度板接力断裂")
        if A < 0:
            alerts.append(f"🟠 加速度转负 A={A:+.2f} (连续 {self._neg_A_streak} 期)")
            if self._neg_A_streak >= 3:
                alerts.append("🔴 A 连续3期为负: 顶部区高度确认, 立即减仓")
        if P < self.P_danger:
            alerts.append(f"🔴 燃料告急 P={P:.1f} < {self.P_danger}: 仓位空间快没了, 不追多")
        if G >= 70:
            alerts.append(f"🟠 卖压再生点火 G={G:.1f}: 解禁/减持/获利盘集中")
        if d.d_margin < -100:
            alerts.append(f"🟠 两融单日净流出 {abs(d.d_margin):.0f}亿: 杠杆资金撤退")
        if d.index_below_ma20 and A < 0:
            alerts.append("🟠 跌破20日线 + 加速度负: 趋势转弱确认")
        if d.index_below_ma5 and d.broken_rate > self.broken_warn:
            alerts.append("🟠 破5日线 + 炸板率高: 短线惯性下, 次日易低开")
        # 政策类告警
        for p in d.policy_stack:
            tag = "利多" if p.direction > 0 else "利空"
            alerts.append(f"{'🟢' if p.direction > 0 else '🔴'} 政策[{p.note}]{tag}·通道{p.channel}·"
                          f"当期效力{p.weight()*100:.0f}%")

        # ---- 操作建议 ----
        if quad.startswith("Q1") and M > 65 and BIG >= self.big_confirm_th:
            action = "持多 / 可加仓 (大资金已确认)"
        elif quad.startswith("Q1") and M > 65:
            action = "持多但不加仓 (大资金未确认, 防虚量)"
        elif quad.startswith("Q2"):
            action = "减仓 / 收紧止损 / 不新开多"
        elif quad.startswith("Q3"):
            action = "空仓 / 等政策或地量信号"
        elif quad.startswith("Q4") and M > 50:
            action = "小仓试多 / 等涨停家数回升确认"
        else:
            action = "观望"

        result = {
            "P": P, "R_raw": r_raw, "R_score": R_score, "R_adj": R_adj,
            "BIG": BIG, "big_msg": big_msg,
            "A": A, "E": E, "Ep": Ep, "G": G,
            "M": M, "quad": quad, "action": action,
            "alerts": alerts, "neg_streak": self._neg_A_streak,
            "policy": describe_policy_stack(d.policy_stack),
            "policy_deltas": pol,
        }

        if verbose:
            self._print(result, d)

        return result

    # --------------------------------------------------------
    # 打印
    # --------------------------------------------------------
    def _print(self, r: dict, d: DailyInput):
        print("=" * 62)
        print(f"  仓位空间 P = {r['P']:5.1f}  ({pct_rank_label(r['P'])})"
              f"   {'⚠燃料告急' if r['P'] < self.P_danger else ''}")
        print(f"  流入强度 R = {r['R_score']:5.1f} -> 校准后 {r['R_adj']:5.1f}  (原始 {r['R_raw']:+.3f}%/日)")
        print(f"  大资金 BIG = {r['BIG']:5.1f}  ({pct_rank_label(r['BIG'])})   {r['big_msg']}")
        print(f"  加速度   A = {r['A']:+.2f}   连续负值 {r['neg_streak']} 期")
        print(f"  情绪温度 E = {r['E']:5.1f}   情绪加速度 E' = {r['Ep']:+.2f}")
        print(f"  卖压再生 G = {r['G']:5.1f}")
        print(f"  综合动量 M = {r['M']:5.1f}")
        print(f"  ▶ 象限：{r['quad']}")
        print(f"  ▶ 背离：{self.divergence(r['R_adj'], r['E'])}")
        print(f"  ▶ 政策：{r['policy']}")
        print(f"  ▶ 操作：{r['action']}")
        if r["alerts"]:
            print("  -- 告警 --")
            for a in r["alerts"]:
                print(f"    {a}")
        print("=" * 62)

    # --------------------------------------------------------
    # P-R 二维矩阵 (替代失真的续航 T)
    # --------------------------------------------------------
    @staticmethod
    def pr_matrix(P: float, R_score: float) -> str:
        p_high, r_high = P >= 50, R_score >= 50
        if p_high and r_high:
            return "燃料足 + 流入猛 -> Q1 健康主升"
        if (not p_high) and r_high:
            return "燃料少 + 猛烧 -> ⚠Q2前兆, 最危险 (天量见天价)"
        if (not p_high) and (not r_high):
            return "燃料少 + 流入弱 -> Q3 耗尽区"
        return "燃料足 + 流入弱 -> Q4 待政策/催化启动"

    # --------------------------------------------------------
    # 情绪-资金背离矩阵
    # --------------------------------------------------------
    @staticmethod
    def divergence(R_score: float, E: float) -> str:
        r_ok, e_ok = R_score >= 60, E >= 50
        if r_ok and e_ok:
            return "共振向上 (健康)"
        if r_ok and not e_ok:
            return "⚠资金强撑情绪退 (顶部前兆, 最危险)"
        if (not r_ok) and e_ok:
            return "情绪虚火无量 (诱多, 别追)"
        return "双杀 (Q3 空仓)"

    # --------------------------------------------------------
    # 三场景次日推演 (替代"单点幅度预测")
    # --------------------------------------------------------
    @staticmethod
    def next_day_scenarios(r: dict, d: "DailyInput") -> List[str]:
        """
        三场景次日推演. 关键: 若当日已经"冲高回落/破5日线",
        次日基准必须写成"下探修复", 不能因为 R 高就写"高开延续" ——
        这是 v1 被诟病的点: 收盘数据里的 R 是全天累计流入, 它无法表达
        "钱是上午进的、下午走的". 日内结构必须用 d 里的盘面字段补进来.
        """
        P, R, A, E, G, BIG = r["P"], r["R_adj"], r["A"], r["E"], r["G"], r["BIG"]
        intraday_bad = bool(getattr(d, "index_below_ma5", False)) or (d.broken_rate > 30.0)
        out = []
        if intraday_bad and A <= 0:
            out.append("基准: 当日冲高回落/破5日线, 且加速度非正 -> 次日惯性偏下探, 先等承接再谈修复")
        elif intraday_bad and A > 0:
            out.append("基准: 当日冲高回落(破5日线/炸板率高), 但资金动量仍为正 -> 次日多半低开或下探后修复, "
                       "关键看前低能否守住; 不可直接按 R 高就预期高开")
        elif A <= 0 and R >= 50:
            out.append("基准: 天量滞涨, 次日大概率低开或下探后震荡, 反抽先看量能与主线")
        elif A <= 0 and R < 50:
            out.append("基准: 缩量下探, 等企稳信号, 不猜底")
        elif A > 0 and R < 50:
            out.append("基准: 地量后小幅修复, 需放量确认")
        else:
            out.append("基准: 动能仍正, 平开或小高开延续, 但需防冲高回落")
        if P >= 40 and BIG >= 55 and A > -3:
            out.append("偏多触发: 低开不破前低 + 大资金不缩 -> 修复成立, 可小仓试多")
        else:
            out.append("偏多触发: 需 大资金回流 + 涨停家数回升 同时出现, 当前条件不足")
        if A < 0 and G >= 50:
            out.append("偏空触发: 破前低放量 + 大单续流出 -> 转 Q3, 减仓")
        else:
            out.append("偏空触发: 放量破位且反抽无量 -> 降级 Q3")
        return out

# ============================================================
# 批量扫描
# ============================================================
def scan(model: ASFMM_A, days: List[DailyInput], labels: Optional[List[str]] = None):
    print("\n" + "━" * 70)
    print("  滚动扫描：象限迁移与拐点")
    print("━" * 70)
    print(f"  {'期':<5}{'P':>7}{'R':>7}{'R校准':>8}{'BIG':>7}{'A':>8}{'E':>7}{'G':>7}   {'象限':<14}矩阵")
    print("  " + "-" * 66)
    for i, d in enumerate(days):
        r = model.step(d, verbose=False)
        lbl = labels[i] if labels else f"T{i}"
        mat = ASFMM_A.pr_matrix(r["P"], r["R_adj"])
        print(f"  {lbl:<5}{r['P']:>7.1f}{r['R_score']:>7.1f}{r['R_adj']:>8.1f}"
              f"{r['BIG']:>7.1f}{r['A']:>+8.2f}{r['E']:>7.1f}{r['G']:>7.1f}   {r['quad']:<14}{mat}")
    print("━" * 70 + "\n")


# ============================================================
# 示例
# ============================================================
def demo():
    def warmup(model, base, n=3, step_r=0, step_e=0):
        import copy
        for i in range(n):
            b = copy.deepcopy(base)
            b.d_margin += step_r * i
            b.amt_over_ma20 += step_r * i * 15
            b.limit_up_cnt += step_e * i
            b.big_order_net += step_r * i * 0.6
            model.step(b, verbose=False)

    # ---------- 示例1: 虚量顶 —— R 很高但大资金在跑 ----------
    print("\n【示例1】虚量冲高 —— 成交额放大但主力大单净流出")
    m1 = ASFMM_A()
    base1 = DailyInput(
        margin_pct_rank=70, fund_equity_rank=72, turnover_amt_rank=75, swap_rate_rank=68,
        d_margin=90, etf_net_subscribe=60, amt_over_ma20=2000, new_fund_issue=25,
        big_order_net=80, north_net=20,
        big_order_net_rank=62, north_net_rank=55, etf_sub_rank=60,
        limit_up_cnt=95, max_board=7, broken_rate=20, up_ratio_rank=70,
        unlock_5d_rank=55, reduce_amt_rank=50, margin_force_rank=40, profit_float_rank=60,
    )
    warmup(m1, base1, n=3, step_r=15, step_e=5)
    d1 = DailyInput(
        margin_pct_rank=88, fund_equity_rank=90, turnover_amt_rank=95, swap_rate_rank=85,
        d_margin=120, etf_net_subscribe=80, amt_over_ma20=3500, new_fund_issue=40,
        big_order_net=-260, north_net=-60,          # ← 大资金跑
        big_order_net_rank=22, north_net_rank=25, etf_sub_rank=40,
        limit_up_cnt=45, max_board=4, broken_rate=38, up_ratio_rank=35,
        unlock_5d_rank=75, reduce_amt_rank=70, margin_force_rank=60, profit_float_rank=80,
        index_below_ma5=True,
    )
    r1 = m1.step(d1)
    print("  二维矩阵：", m1.pr_matrix(r1["P"], r1["R_adj"]))
    print("  次日推演：")
    for s in m1.next_day_scenarios(r1, d1):
        print("    -", s)

    # ---------- 示例2: 降准对冲监管打压 ----------
    print("\n\n【示例2】政策向量对冲 —— 降准(利多·P) vs 打击炒作(利空·E)")
    m2 = ASFMM_A()
    base2 = DailyInput(
        margin_pct_rank=55, fund_equity_rank=58, turnover_amt_rank=60, swap_rate_rank=55,
        d_margin=60, etf_net_subscribe=90, amt_over_ma20=1200, new_fund_issue=30,
        big_order_net=150, north_net=40,
        big_order_net_rank=68, north_net_rank=62, etf_sub_rank=70,
        limit_up_cnt=80, max_board=6, broken_rate=25, up_ratio_rank=60,
        unlock_5d_rank=50, reduce_amt_rank=45, margin_force_rank=40, profit_float_rank=55,
    )
    warmup(m2, base2, n=3, step_r=10, step_e=4)
    d2 = DailyInput(
        margin_pct_rank=82, fund_equity_rank=84, turnover_amt_rank=88, swap_rate_rank=80,
        d_margin=140, etf_net_subscribe=180, amt_over_ma20=2200, new_fund_issue=45,
        big_order_net=320, north_net=90,
        big_order_net_rank=80, north_net_rank=75, etf_sub_rank=82,
        limit_up_cnt=70, max_board=5, broken_rate=28, up_ratio_rank=58,
        unlock_5d_rank=55, reduce_amt_rank=50, margin_force_rank=42, profit_float_rank=60,
        policy_stack=[
            PolicyVector.from_library("RRR_CUT", age=1),            # 降准第2天, 仍在效力期
            PolicyVector.from_library("SPECULATION_CRACKDOWN", age=0),  # 当天打击炒作
        ],
    )
    r2 = m2.step(d2)
    print("  政策分通道调节量：", {k: round(v, 1) for k, v in r2["policy_deltas"].items() if abs(v) > 0.1})
    print("  二维矩阵：", m2.pr_matrix(r2["P"], r2["R_adj"]))
    print("  次日推演：")
    for s in m2.next_day_scenarios(r2, d2):
        print("    -", s)

    # ---------- 示例3: 国家队救市 (效力强但衰减快) ----------
    print("\n\n【示例3】国家队增持ETF —— 强效力、半衰期5天")
    m3 = ASFMM_A()
    base3 = DailyInput(
        margin_pct_rank=30, fund_equity_rank=40, turnover_amt_rank=25, swap_rate_rank=30,
        d_margin=-40, etf_net_subscribe=100, amt_over_ma20=-800, new_fund_issue=20,
        big_order_net=120, north_net=-30,
        big_order_net_rank=60, north_net_rank=35, etf_sub_rank=75,
        limit_up_cnt=40, max_board=3, broken_rate=35, up_ratio_rank=30,
        unlock_5d_rank=60, reduce_amt_rank=55, margin_force_rank=65, profit_float_rank=35,
    )
    warmup(m3, base3, n=3, step_r=-8, step_e=-3)
    d3 = DailyInput(
        margin_pct_rank=28, fund_equity_rank=38, turnover_amt_rank=30, swap_rate_rank=28,
        d_margin=20, etf_net_subscribe=600, amt_over_ma20=500, new_fund_issue=25,
        big_order_net=480, north_net=10,
        big_order_net_rank=88, north_net_rank=45, etf_sub_rank=95,
        limit_up_cnt=62, max_board=4, broken_rate=26, up_ratio_rank=48,
        unlock_5d_rank=58, reduce_amt_rank=52, margin_force_rank=55, profit_float_rank=30,
        index_below_ma20=True,
        policy_stack=[PolicyVector.from_library("NATIONAL_TEAM", age=0)],
    )
    r3 = m3.step(d3)
    print("  二维矩阵：", m3.pr_matrix(r3["P"], r3["R_adj"]))
    print("  次日推演：")
    for s in m3.next_day_scenarios(r3, d3):
        print("    -", s)

    # ---------- 示例4: 政策效力衰减曲线 ----------
    print("\n\n【示例4】同一条降准政策, 效力随天数衰减")
    for age in [0, 5, 10, 20, 40]:
        p = PolicyVector.from_library("RRR_CUT", age=age)
        print(f"  第{age:>2}天: 权重 {p.weight()*100:5.1f}%   对P通道调节 {p.delta(50):+5.2f} 分")

    # ---------- 示例5: 滚动扫描 ----------
    print("\n\n【示例5】滚动扫描：虚量顶 -> 政策对冲 -> 修复")
    m5 = ASFMM_A()
    days = [
        DailyInput(margin_pct_rank=50, fund_equity_rank=55, turnover_amt_rank=45, swap_rate_rank=50,
                   d_margin=60, etf_net_subscribe=80, amt_over_ma20=800, new_fund_issue=25,
                   big_order_net=120, north_net=30, big_order_net_rank=65, north_net_rank=58, etf_sub_rank=66,
                   limit_up_cnt=75, max_board=6, broken_rate=22, up_ratio_rank=60),
        DailyInput(margin_pct_rank=62, fund_equity_rank=65, turnover_amt_rank=62, swap_rate_rank=60,
                   d_margin=100, etf_net_subscribe=100, amt_over_ma20=1600, new_fund_issue=30,
                   big_order_net=200, north_net=50, big_order_net_rank=74, north_net_rank=66, etf_sub_rank=72,
                   limit_up_cnt=90, max_board=7, broken_rate=20, up_ratio_rank=68),
        DailyInput(margin_pct_rank=78, fund_equity_rank=80, turnover_amt_rank=85, swap_rate_rank=78,
                   d_margin=130, etf_net_subscribe=90, amt_over_ma20=2800, new_fund_issue=35,
                   big_order_net=60, north_net=-20, big_order_net_rank=45, north_net_rank=38, etf_sub_rank=55,
                   limit_up_cnt=60, max_board=5, broken_rate=32, up_ratio_rank=50),
        DailyInput(margin_pct_rank=85, fund_equity_rank=88, turnover_amt_rank=92, swap_rate_rank=84,
                   d_margin=90, etf_net_subscribe=50, amt_over_ma20=3200, new_fund_issue=30,
                   big_order_net=-240, north_net=-70, big_order_net_rank=24, north_net_rank=22, etf_sub_rank=38,
                   limit_up_cnt=42, max_board=4, broken_rate=40, up_ratio_rank=38,
                   index_below_ma5=True,
                   policy_stack=[PolicyVector.from_library("SPECULATION_CRACKDOWN", age=0)]),
        DailyInput(margin_pct_rank=80, fund_equity_rank=84, turnover_amt_rank=70, swap_rate_rank=72,
                   d_margin=-60, etf_net_subscribe=200, amt_over_ma20=-400, new_fund_issue=20,
                   big_order_net=-80, north_net=-10, big_order_net_rank=38, north_net_rank=42, etf_sub_rank=70,
                   limit_up_cnt=35, max_board=3, broken_rate=45, up_ratio_rank=32,
                   index_below_ma20=True,
                   policy_stack=[PolicyVector.from_library("SPECULATION_CRACKDOWN", age=2),
                                 PolicyVector.from_library("NATIONAL_TEAM", age=0)]),
        DailyInput(margin_pct_rank=72, fund_equity_rank=78, turnover_amt_rank=48, swap_rate_rank=60,
                   d_margin=40, etf_net_subscribe=420, amt_over_ma20=-200, new_fund_issue=25,
                   big_order_net=260, north_net=40, big_order_net_rank=78, north_net_rank=65, etf_sub_rank=90,
                   limit_up_cnt=55, max_board=4, broken_rate=28, up_ratio_rank=45,
                   index_below_ma20=True,
                   policy_stack=[PolicyVector.from_library("NATIONAL_TEAM", age=1)]),
    ]
    scan(m5, days, labels=["T0", "T1", "T2", "T3打压", "T4救市", "T5"])


if __name__ == "__main__":
    demo()


# ============================================================
# 历史预热: 让 EMA 有真实历史, 否则首日 A / E' 恒为 0
# ============================================================
def warmup_history(model: "ASFMM_A", latest: DailyInput,
                   ak_symbol: str = "sh000001", n_days: int = 20) -> int:
    """
    用指数历史 + 当日静态分位回放 n_days 天, 把 EMA 推到当前状态.
    只有"随市场波动的字段"(成交额分位/情绪/大单代理/破位状态)会按历史重算,
    两融、ETF、卖压等慢变量沿用最新值 —— 这是近似, 不是精确回测.
    """
    import copy
    try:
        import akshare as _ak
        idx = _ak.stock_zh_index_daily(symbol=ak_symbol).tail(n_days + 25).reset_index(drop=True)
    except Exception:
        return 0
    closes = idx["close"].astype(float).tolist()
    vols = idx["volume"].astype(float).tolist()
    start = len(closes) - n_days
    cnt = 0
    for i in range(start, len(closes)):
        d = copy.deepcopy(latest)
        amt_hist = [vols[j] * closes[j] for j in range(max(0, i - 60), i + 1)]
        cur_amt = vols[i] * closes[i]
        rank = sum(1 for v in amt_hist if v < cur_amt) / max(len(amt_hist), 1) * 100
        d.turnover_amt_rank = rank
        d.swap_rate_rank = rank
        ma20_amt = sum(amt_hist[-20:]) / max(len(amt_hist[-20:]), 1)
        d.amt_over_ma20 = (cur_amt - ma20_amt) / 1e8 * 0.39   # 与 datasource 的校准系数一致
        ma5 = sum(closes[i - 4:i + 1]) / 5
        ma20c = sum(closes[i - 19:i + 1]) / 20
        d.index_below_ma5 = closes[i] < ma5
        d.index_below_ma20 = closes[i] < ma20c
        # 情绪随市场同步缩放: 用当日涨跌幅的方向近似情绪强弱
        chg = (closes[i] / closes[i - 1] - 1) * 100
        d.limit_up_cnt = max(10.0, min(120.0, latest.limit_up_cnt * (1 + chg / 2.0)))
        d.broken_rate = max(10.0, min(60.0, latest.broken_rate * (1 - chg / 3.0)))
        d.up_ratio_rank = max(5.0, min(95.0, 50 + chg * 8))
        d.big_order_net_rank = max(5.0, min(95.0, 50 + chg * 10))
        d.big_order_net = chg * 30
        model.step(d, verbose=False)
        cnt += 1
    return cnt
