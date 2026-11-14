# -*- coding: utf-8 -*-
"""
ASFMM-A v2 数据接入层  datasource.py
==========================================================
把免费数据源的脏活全部封装在这里, 输出一个可直接喂给
ASFMM_A.step() 的 DailyInput.

实测可用性 (2026-11, akshare 1.18.88, 沙盒环境):
  ✅ 可用
    ak.stock_margin_sse()            两融明细(沪), 含融资余额, 日期倒序
    ak.stock_zh_a_spot()            新浪全A快照(约5500只), 含涨跌幅/最高/昨收
    ak.stock_zh_index_daily()       新浪指数日线, 用于成交额MA20/均线
    ak.fund_etf_hist_sina()         新浪ETF历史, 份额*净值推算申赎需配合场内份额
  ❌ 沙盒内被拒 (本机一般可用, 已写 fallback)
    ak.stock_market_fund_flow()     东财大盘资金流 -> 主力大单净流入
    ak.stock_zt_pool_em()           东财涨停股池
    ak.stock_zt_pool_zbgc_em()      东财炸板股池
    ak.stock_margin_szse()          深市两融
  替代方案 (本文件已实现)
    涨停/炸板/连板 <- 新浪全A快照自行推算 (规则见 _build_sentiment)
    主力大单净流入 <- 无源时降级: 用 成交额加权涨幅 作为机构参与度的代理

⚠️ 三个必须知道的口径问题
  1. stock_margin_sse 最新只到 T-1 (两融数据晚一个交易日公布),
     所以 d_margin 实际是"昨日两融变化", step() 里要意识到这一点.
  2. 新浪快照在非交易时段返回最后收盘数据; 盘中调用返回实时值,
     此时涨停/炸板是"当前值"不是"收盘值", 收盘后跑才准确.
  3. 宽基ETF净申购没有免费日频份额接口, 本文件用
     "份额变化 x 收盘价" 估算; 拿不到份额时返回中性 50.
"""

import warnings
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import pandas as pd

warnings.filterwarnings("ignore")

try:
    import akshare as ak
except ImportError:  # pragma: no cover
    ak = None

from asfmm_a_model_v2 import DailyInput, PolicyVector

# 宽基ETF池: (代码, 名称)
BROAD_ETF_POOL: List[Tuple[str, str]] = [
    ("sh510300", "华泰柏瑞沪深300ETF"),
    ("sh510500", "南方中证500ETF"),
    ("sh510050", "华夏上证50ETF"),
    ("sh510310", "易方达沪深300ETF"),
    ("sh588000", "华夏科创50ETF"),
]

# 历史数据窗口
_LOOKBACK = 60


# ============================================================
# 分位工具: 把当前值放到自身历史序列里定分位
# ============================================================
def _rank_of(series: List[float], value: float) -> float:
    """value 在 series 中的分位 (0~100). 数据不足时返回 50."""
    clean = [v for v in series if v == v and v is not None]  # 去 NaN
    if len(clean) < 10:
        return 50.0
    lo = sum(1 for v in clean if v < value)
    eq = sum(1 for v in clean if v == value)
    return max(0.0, min(100.0, (lo + 0.5 * eq) / len(clean) * 100.0))


# ============================================================
# 抓取器
# ============================================================
@dataclass
class FetchResult:
    input: DailyInput
    quality: Dict[str, str] = field(default_factory=dict)
    raw: Dict[str, float] = field(default_factory=dict)


def fetch_latest(policy_stack: Optional[List[PolicyVector]] = None,
                 index_symbol: str = "sh000001") -> FetchResult:
    """
    抓取最近一个完整交易日的数据, 组装成 DailyInput.
    policy_stack 由调用方按当日实际政策手工传入 (政策无法自动抓取,
    需要人工判断类型与力度 —— 这正是 v2 把政策做成向量的原因).
    """
    if ak is None:
        raise RuntimeError("需要 akshare: pip install akshare")

    q: Dict[str, str] = {}
    raw: Dict[str, float] = {}
    d = DailyInput(policy_stack=policy_stack or [])

    # ---------- 1. 指数: 成交额 / MA20 / 均线 ----------
    try:
        idx = ak.stock_zh_index_daily(symbol=index_symbol).copy()
        idx = idx.tail(_LOOKBACK).reset_index(drop=True)
        # 新浪指数 volume 单位是"股"(上证约 400亿股/日), 需要换算成元.
        # 用最近一个已知真实成交额做校准: 上证 2026-11-12 全市场约 1.93万亿,
        # 对应 volume 4.965e10 -> 系数约 0.39 元/股. 该系数随市场结构缓慢漂移,
        # 建议每月用一次真实成交额重新校准 AMT_CALIB.
        AMT_CALIB = 0.39
        idx["amount"] = idx["volume"] * idx["close"] * AMT_CALIB
        today_amt = float(idx["amount"].iloc[-1])
        ma20_amt = float(idx["amount"].tail(20).mean())
        ma5 = float(idx["close"].tail(5).mean())
        ma20 = float(idx["close"].tail(20).mean())
        close = float(idx["close"].iloc[-1])
        prev_close = float(idx["close"].iloc[-2])
        raw["index_close"] = close
        raw["index_date"] = str(idx["date"].iloc[-1])[:10]   # 最后一个交易日 YYYY-MM-DD, 供云端表 ymd 主键
        raw["pct_chg"] = (close / prev_close - 1) * 100
        raw["amount_yi"] = today_amt / 1e8
        raw["amount_note"] = "估算值(量x收盘x校准系数), 仅用于自身历史分位比较, 不代表真实成交额"
        # 展示口径单独取真实两市成交额(腾讯日线 amount, 单位: 元 = 沪+深).
        # 估算值只保证分位一致, 绝对值受校准系数漂移影响极大, 不可直接写云端给小程序展示.
        try:
            _total = 0.0
            for _sym in ("sh000001", "sz399001"):
                _t = ak.stock_zh_index_daily_tx(symbol=_sym)
                _t["date"] = _t["date"].astype(str).str[:10]
                _total += float(_t.loc[_t["date"] == raw["index_date"], "amount"].iloc[-1])
            if _total > 1e11:   # 沪深两市合计 < 1000亿 视为异常, 保留估算值
                raw["amount_yi"] = _total / 1e8
                raw["amount_note"] = "两市真实成交额(腾讯日线 amount, 沪+深)"
        except Exception:
            pass
        raw["ma5"] = ma5
        raw["ma20"] = ma20
        d.amt_over_ma20 = (today_amt - ma20_amt) / 1e8
        d.index_below_ma20 = close < ma20
        d.index_below_ma5 = close < ma5
        amt_hist = (idx["amount"] / 1e8).tolist()
        d.turnover_amt_rank = _rank_of(amt_hist, today_amt / 1e8)
        d.swap_rate_rank = _rank_of(amt_hist, today_amt / 1e8)   # 无独立换手率, 用成交额代理
        q["指数/成交额"] = "ok"
    except Exception as e:
        q["指数/成交额"] = f"FAIL {type(e).__name__}"

    # ---------- 2. 两融 (沪市; 深市失败则只用沪市并标注) ----------
    try:
        m = ak.stock_margin_sse().copy()
        m = m.rename(columns={"信用交易日期": "date", "融资余额": "rzye"})
        m["date"] = m["date"].astype(str)
        m = m.sort_values("date").tail(_LOOKBACK).reset_index(drop=True)
        m["rzye_yi"] = pd.to_numeric(m["rzye"], errors="coerce") / 1e8
        d.d_margin = float(m["rzye_yi"].iloc[-1] - m["rzye_yi"].iloc[-2])
        raw["margin_yi"] = float(m["rzye_yi"].iloc[-1])
        raw["d_margin_yi"] = d.d_margin
        # ⚠️ 防线: akshare 的 stock_margin_sse 拉取区间不含最新日期时,
        # 接口会静默返回最早的历史数据 (曾出现返回 2023-09 数据的情况).
        # 这里强制校验: 最新日期必须落在最近 10 个自然日内, 否则判为陈旧并置中性.
        latest_date = str(m["date"].iloc[-1])
        try:
            lag = (pd.Timestamp.today().normalize() - pd.Timestamp(latest_date)).days
        except Exception:
            lag = 999
        if lag > 10:
            d.margin_pct_rank = 50.0
            d.d_margin = 0.0
            raw["margin_date"] = latest_date
            raw["margin_stale_days"] = lag
            q["两融(沪)"] = f"⚠️数据陈旧(最新{latest_date}, 滞后{lag}天), 已置中性"
        else:
            d.margin_pct_rank = _rank_of(m["rzye_yi"].tolist(), float(m["rzye_yi"].iloc[-1]))
            raw["margin_date"] = latest_date
            raw["margin_scope"] = "沪市融资余额(深市接口失效), 非全市场两融"
            raw["margin_total_est_yi"] = float(m["rzye_yi"].iloc[-1]) * 2.35
            q["两融(沪)"] = f"ok(滞后{lag}天, 仅沪市)"

    except Exception as e:
        q["两融(沪)"] = f"FAIL {type(e).__name__}"

    # ---------- 3. 情绪: 涨停 / 炸板 / 连板 / 上涨家数 ----------
    try:
        senti = _build_sentiment()
        d.limit_up_cnt = senti["limit_up"]
        d.broken_rate = senti["broken_rate"]
        d.max_board = senti["max_board"]
        d.up_ratio_rank = senti["up_ratio_rank"]
        raw["limit_up"] = senti["limit_up"]
        raw["broken"] = senti["broken"]
        raw["broken_rate"] = senti["broken_rate"]
        raw["max_board"] = senti["max_board"]
        raw["up_ratio"] = senti["up_ratio"]
        raw["big_proxy"] = senti["big_proxy"]
        raw["adv_ratio"] = senti["adv_ratio"]
        q["情绪(新浪推算)"] = "ok"
    except Exception as e:
        q["情绪(新浪推算)"] = f"FAIL {type(e).__name__}"

    # ---------- 4. 大资金层: 主力大单 / 北向 / 宽基ETF ----------
    # 4-1 主力大单净流入 (东财, 沙盒常被拒 -> 用代理)
    try:
        ff = ak.stock_market_fund_flow()
        last = ff.tail(1).to_dict("records")[0]
        col = [c for c in ff.columns if "主力" in str(c) and "净" in str(c)]
        val = float(last[col[0]]) / 1e8      # 东财单位是元 -> 统一换算成亿元（模型阈值按亿元设计）
        d.big_order_net = val
        raw["big_order_net"] = val
        d.big_order_net_rank = _rank_of(pd.to_numeric(ff[col[0]], errors="coerce").tail(60).tolist(), float(last[col[0]]))
        q["主力大单"] = "ok(东财)"
    except Exception:
        proxy = raw.get("big_proxy", 0.0)      # 成交额加权涨幅, 亿元*%
        d.big_order_net = proxy
        d.big_order_net_rank = 50.0 + max(-30.0, min(30.0, proxy / 20.0))
        raw["big_order_net"] = proxy
        raw["big_order_proxy_used"] = 1.0
        q["主力大单"] = "代理值(成交额加权涨幅, 非真实大单)"

    # 4-2 北向 (2024年8月起已停发日度净买入, 只能拿到成交额口径, 这里降级中性)
    try:
        nh = ak.stock_hsgt_hist_em(symbol="北向资金")
        col = [c for c in nh.columns if "净买" in str(c)]
        if col:
            series = pd.to_numeric(nh[col[0]], errors="coerce").tail(60).tolist()
            val = float(series[-1])
            d.north_net = val
            d.north_net_rank = _rank_of(series, val)
            raw["north_net"] = val
            q["北向"] = "ok"
        else:
            d.north_net_rank = 50.0
            q["北向"] = "无净买入字段(停发), 置中性"
    except Exception:
        d.north_net_rank = 50.0
        q["北向"] = "不可用, 置中性"

    # 4-3 宽基ETF净申购 (份额 x 价格 估算; 拿不到份额则中性)
    try:
        sub_total, ok_cnt = 0.0, 0
        for code, _name in BROAD_ETF_POOL:
            v = _etf_flow_sina(code)
            if v is not None:
                sub_total += v
                ok_cnt += 1
        if ok_cnt >= 2:
            d.etf_net_subscribe = sub_total
            raw["etf_sub_yi"] = sub_total
            d.etf_sub_rank = 50.0 + max(-35.0, min(35.0, sub_total / 12.0))
            q["宽基ETF"] = f"ok({ok_cnt}/{len(BROAD_ETF_POOL)}只)"
        else:
            d.etf_sub_rank = 50.0
            q["宽基ETF"] = "份额接口不可用, 置中性"
    except Exception as e:
        d.etf_sub_rank = 50.0
        q["宽基ETF"] = f"FAIL {type(e).__name__}, 置中性"

    # ---------- 5. 公募仓位 / 卖压: 免费源无日频, 置中性并标注 ----------
    d.fund_equity_rank = raw.get("fund_equity_rank", 50.0)
    # 强平压力: 两融连续净流出越多, 压力越大 (阈值按全市场口径, 单日-100亿以上开始计入)
    d.margin_force_rank = 50.0 if d.d_margin >= -100 else min(100.0, 50 + (-d.d_margin - 100) / 5)
    d.unlock_5d_rank = 50.0
    d.reduce_amt_rank = 50.0
    d.profit_float_rank = raw.get("profit_float_rank", 50.0)
    q["公募仓位/解禁/减持/浮盈"] = "无免费日频源, 置中性(需手工覆盖)"

    # NaN 兜底: 任何漏网的 nan 都会污染分位计算, 统一清成中性值
    import math
    for fld in ["north_net", "big_order_net", "etf_net_subscribe", "d_margin"]:
        v = getattr(d, fld)
        if isinstance(v, float) and math.isnan(v):
            setattr(d, fld, 0.0)
            q[fld] = "NaN 已置 0"

    d.data_quality = q
    return FetchResult(input=d, quality=q, raw={k: v for k, v in raw.items()
                                                if not (isinstance(v, float) and math.isnan(v))})


# ============================================================
# 情绪构建: 用全A快照推算涨停/炸板/连板
# ============================================================
def _build_sentiment() -> dict:
    """
    判定规则 (需自行校验, 这是推算不是交易所口径):
      涨停: 收盘涨跌幅 >= 涨停阈值 - 0.6pct (容错一字板/四舍五入)
      曾涨停: 盘中最高价触及涨停阈值 - 0.6pct
      炸板: 曾涨停 且 收盘未涨停
      连板高度: 无法从快照直接得到 -> 用"连续涨停梯队"不可得,
                退化为 涨停股中涨幅>=19.4%的数量 作为强度代理, 映射到 1~8 板
      大单代理: Σ(成交额 x 涨跌幅) / Σ成交额  -> 资金加权涨幅, 正=机构参与做多
    """
    df = ak.stock_zh_a_spot()
    df = df[~df["代码"].str.startswith("bj")].copy()      # 剔除北交所, 规则不同
    for c in ["最新价", "涨跌幅", "昨收", "最高", "成交额"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df = df.dropna(subset=["昨收", "涨跌幅", "最高"])

    code = df["代码"].astype(str)
    is_gem = code.str.startswith("sz30") | code.str.startswith("sh68")
    is_st = df["名称"].astype(str).str.contains("ST", case=False, na=False)
    limit_pct = 19.4
    main_limit = 29.4 if False else 9.4      # 主板/中小板
    thr = pd.Series(main_limit, index=df.index)
    thr[is_gem] = limit_pct
    thr[is_st & ~is_gem] = 4.4
    thr[is_st & is_gem] = 19.4

    touch = (df["最高"] / df["昨收"] - 1) * 100 >= thr
    sealed = df["涨跌幅"] >= thr
    limit_up = int(sealed.sum())
    broken = int((touch & ~sealed).sum())
    broken_rate = broken / max(touch.sum(), 1) * 100
    up_ratio = float((df["涨跌幅"] > 0).mean() * 100)

    # 连板高度代理: 20cm涨停家数 -> 高度分 (0只=2板, 3只=4板, 8只+=8板)
    n20 = int((df["涨跌幅"] >= 19.4).sum())
    max_board = min(8.0, 2.0 + n20 * 0.75)

    amt = df["成交额"].fillna(0.0)
    big_proxy = float((amt * df["涨跌幅"]).sum() / max(amt.sum(), 1.0) / 100.0 * 100.0)  # 亿元*% 量级

    return dict(limit_up=limit_up, broken=broken, broken_rate=broken_rate,
                max_board=max_board, up_ratio=up_ratio, up_ratio_rank=up_ratio,
                big_proxy=big_proxy, adv_ratio=float((df["涨跌幅"] > 0).mean()))


# ============================================================
# 宽基ETF 申赎估算
# ============================================================
def _etf_flow_sina(code: str) -> Optional[float]:
    """
    用价格x份额变化估算净申购 (亿元).
    新浪 ETF 历史接口不返回场内份额 -> 本函数在拿不到份额时返回 None,
    由调用方降级为中性. 若你接了 tushare/fund_share_size 类份额接口,
    在此处替换实现即可.
    """
    try:
        hist = ak.fund_etf_hist_sina(symbol=code).tail(3).reset_index(drop=True)
        if len(hist) < 2:
            return None
        # 无可用的份额字段, 无法计算申赎
        return None
    except Exception:
        return None


# ============================================================
# 打印数据质量报告
# ============================================================
def print_quality(fr: FetchResult):
    print("\n" + "─" * 62)
    print("  数据质量报告 (缺失字段已降级为中性 50, 会影响得分可信度)")
    print("─" * 62)
    for k, v in fr.quality.items():
        flag = "✅" if v == "ok" or v.startswith("ok") else ("⚠️" if "FAIL" not in v else "❌")
        print(f"  {flag} {k:<22} {v}")
    print("─" * 62)
    if fr.raw:
        show = {k: (round(v, 2) if isinstance(v, (int, float)) else v)
                for k, v in fr.raw.items()}
        print("  原始值:", show)
    print()


# ============================================================
# 自测
# ============================================================
if __name__ == "__main__":
    fr = fetch_latest()
    print_quality(fr)
    print(fr.input)
