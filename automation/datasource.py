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
# 东财 datacenter 通用抓取 (卖压 G 三个通道的真数据源, 不依赖 akshare)
# ============================================================
_EM_DC = "https://datacenter-web.eastmoney.com/api/data/v1/get"


def _em_get(params: dict, timeout: int = 20) -> dict:
    import json
    import urllib.parse
    import urllib.request

    url = _EM_DC + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Referer": "https://data.eastmoney.com/",
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "ignore"))


def _next_trading_days(n: int = 5):
    """从今天(含)起, 往后数 n 个交易日(跳过周末; 不含法定节假日日历)"""
    from datetime import date, timedelta

    out, cur = [], date.today()
    while len(out) < n:
        if cur.weekday() < 5:
            out.append(cur)
        cur += timedelta(days=1)
    return out


def _fetch_unlock_5d() -> Tuple[float, int, str]:
    """未来 5 个交易日内的限售解禁市值合计.

    RPT_LIFT_STAGE.LIFT_MARKET_CAP 单位为万元 -> 除以 1e4 得亿元.
    返回 (亿元, 条数, 日期区间说明)
    """
    days = _next_trading_days(5)
    start, end = days[0].isoformat(), days[-1].isoformat()
    total, n, page = 0.0, 0, 1
    while page <= 6:
        d = _em_get({
            "reportName": "RPT_LIFT_STAGE",
            "columns": "SECURITY_CODE,FREE_DATE,LIFT_MARKET_CAP",
            "filter": f"(FREE_DATE>='{start}')(FREE_DATE<='{end}')",
            "pageNumber": page, "pageSize": 500,
            "sortColumns": "FREE_DATE", "sortTypes": 1,
            "source": "WEB", "client": "WEB",
        })
        res = d.get("result") or {}
        rows = res.get("data") or []
        for r in rows:
            total += float(r.get("LIFT_MARKET_CAP") or 0)
            n += 1
        if page >= int(res.get("pages") or 1):
            break
        page += 1
    return total / 1e4, n, f"{start}~{end}"


def _fetch_reduce_20d() -> Tuple[float, int, str]:
    """近 20 个自然日「董监高及关联人」净减持金额 (亿元, 负数=净减持).

    口径说明: 东财 RPT_EXECUTIVE_HOLD_DETAILS 只覆盖高管/关联人变动,
    不含 5% 以上大股东的大宗减持, 因此数值远小于全市场真实减持规模,
    作为「卖压方向」的代理足够, 但不可当绝对规模用.
    """
    from datetime import date, timedelta

    end = date.today().isoformat()
    start = (date.today() - timedelta(days=20)).isoformat()
    net, n, page = 0.0, 0, 1
    while page <= 8:
        d = _em_get({
            "reportName": "RPT_EXECUTIVE_HOLD_DETAILS",
            "columns": "CHANGE_DATE,CHANGE_AMOUNT,CHANGE_SHARES",
            "filter": f"(CHANGE_DATE>='{start}')(CHANGE_DATE<='{end}')",
            "pageNumber": page, "pageSize": 500,
            "sortColumns": "CHANGE_DATE", "sortTypes": -1,
            "source": "WEB", "client": "WEB",
        })
        res = d.get("result") or {}
        rows = res.get("data") or []
        for r in rows:
            net += float(r.get("CHANGE_AMOUNT") or 0)
            n += 1
        if page >= int(res.get("pages") or 1):
            break
        page += 1
    return net / 1e8, n, f"{start}~{end}"


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
        idx["date"] = idx["date"].astype(str).str[:10]
        # 新浪指数日线常在收盘后数小时才补当日K线, 而涨停/大单/解禁等慢变量
        # 用的是当日收盘快照. 若不补齐, 会写出"ymd=昨日 但慢变量已是今日"的错位行.
        # 腾讯日线通常更早更新, 用其当日 OHLC 补齐(volume 为"手", 需 x100 换算成股).
        try:
            _tx = ak.stock_zh_index_daily_tx(symbol=index_symbol).copy()
            _tx["date"] = _tx["date"].astype(str).str[:10]
            if str(_tx["date"].iloc[-1]) > str(idx["date"].iloc[-1]):
                _r = _tx.iloc[-1]
                idx = pd.concat([idx, pd.DataFrame([{
                    "date": str(_r["date"]),
                    "open": float(_r["open"]), "high": float(_r["high"]),
                    "low": float(_r["low"]), "close": float(_r["close"]),
                    "volume": float(_r["amount"]) * 100.0,
                }])], ignore_index=True)
                raw["index_source"] = "新浪+腾讯补齐当日"
            else:
                raw["index_source"] = "新浪"
        except Exception:
            raw["index_source"] = "新浪(腾讯补齐失败)"
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
        # 展示口径取交易所官方真实成交额: 沪 stock_sse_deal_daily(亿元) +
        # 深 stock_szse_summary(元). 腾讯日线 amount 实为"手", 不可直接当成交额.
        try:
            _d8 = str(raw["index_date"]).replace("-", "")
            _total = 0.0
            _sse = ak.stock_sse_deal_daily(date=_d8)
            _row = _sse[_sse["单日情况"].astype(str).str.strip() == "成交金额"].iloc[0]
            _total += float(_row["股票"])                       # 亿元
            _sz = ak.stock_szse_summary(date=_d8)
            _szr = _sz[_sz["证券类别"].astype(str).str.strip() == "股票"].iloc[0]
            _total += float(_szr["成交金额"]) / 1e8             # 元 -> 亿元
            if _total > 1000:   # 两市合计 < 1000亿 视为异常, 保留估算值
                raw["amount_yi"] = _total
                raw["amount_note"] = "两市真实成交额(交易所官方: 沪+深股票)"
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

    # ---------- 5. 卖压层 G: 解禁 / 减持 / 强平 / 获利盘 ----------
    # 5-1 解禁 (东财 RPT_LIFT_STAGE, 未来 5 个交易日)
    try:
        unlock_yi, unlock_n, unlock_span = _fetch_unlock_5d()
        d.unlock_5d_rank = max(0.0, min(100.0, unlock_yi / 600.0 * 100.0))  # 600亿/5日 -> 满分
        raw["unlock_5d_yi"] = unlock_yi
        raw["unlock_5d_rank"] = d.unlock_5d_rank
        raw["unlock_5d_span"] = unlock_span
        raw["unlock_5d_n"] = unlock_n
        q["解禁(未来5日)"] = f"ok({unlock_n}条, {unlock_yi:.0f}亿)"
    except Exception as e:
        d.unlock_5d_rank = 50.0
        q["解禁(未来5日)"] = f"FAIL {type(e).__name__}, 置中性"

    # 5-2 减持 (东财 RPT_EXECUTIVE_HOLD_DETAILS, 近20日董监高及关联人净额)
    try:
        reduce_yi, reduce_n, reduce_span = _fetch_reduce_20d()
        # 净额 -20亿 -> 100 分(极端抛压); 0 -> 50; 净增持 -> <50
        d.reduce_amt_rank = max(0.0, min(100.0, 50.0 - reduce_yi * 2.5))
        raw["reduce_20d_yi"] = reduce_yi
        raw["reduce_amt_rank"] = d.reduce_amt_rank
        raw["reduce_20d_span"] = reduce_span
        raw["reduce_20d_n"] = reduce_n
        q["减持(近20日)"] = f"ok({reduce_n}条, 净{reduce_yi:+.2f}亿)"
    except Exception as e:
        d.reduce_amt_rank = 50.0
        q["减持(近20日)"] = f"FAIL {type(e).__name__}, 置中性"

    # 5-3 获利盘浮盈: 20日乖离率代理 (close/MA20-1). 浮盈越多, 兑现卖压越大
    try:
        _c = float(raw["index_close"])
        _ma20 = float(raw["ma20"])
        dev = _c / _ma20 - 1.0 if _ma20 else 0.0
        d.profit_float_rank = max(0.0, min(100.0, 50.0 + dev * 100.0 * 4.0))
        raw["profit_float_rank"] = d.profit_float_rank
        raw["dev_ma20_pct"] = dev * 100.0
        q["获利盘(乖离代理)"] = f"ok(20日乖离{dev*100:+.2f}%)"
    except Exception:
        d.profit_float_rank = 50.0
        q["获利盘(乖离代理)"] = "无指数数据, 置中性"

    # 5-4 公募仓位 (季频, 无日频免费源) 与 强平压力(两融代理) 保持原逻辑
    d.fund_equity_rank = raw.get("fund_equity_rank", 50.0)
    # 强平压力: 两融连续净流出越多, 压力越大 (阈值按全市场口径, 单日-100亿以上开始计入)
    d.margin_force_rank = 50.0 if d.d_margin >= -100 else min(100.0, 50 + (-d.d_margin - 100) / 5)
    raw["margin_force_rank"] = d.margin_force_rank
    q["公募仓位"] = "季频无日频源, 置中性(仅影响 P, 不影响 G)"

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
