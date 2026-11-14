# -*- coding: utf-8 -*-
"""每日收盘打分入口 + 云端写入 SQL 生成
用法: python3 run_and_push.py [--warmup]
  --warmup  建议始终带上：用指数历史回放预热 EMA，否则 A/E' 失真（v1 遗留坑）

输出三段：
  1) 数据质量报告（缺失字段已降级中性并标红）
  2) 模型打分摘要（P/R/BIG/A/E/G/M/象限/次日三场景/质量闸门）
  3) 一条单语句 SQL（INSERT ... ON CONFLICT (ymd) DO UPDATE），供写入云表 a_input_ext
     小程序端开机读取该表，把两融/大单/ETF/上涨占比等慢变量合并进实时模型输入
"""
import sys
import os
import json
import math
import warnings

warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from datasource import fetch_latest, print_quality          # noqa: E402
from asfmm_a_model_v2 import ASFMM_A, warmup_history        # noqa: E402
from policy_today import POLICY_TODAY                       # noqa: E402


def _num(v, nd=4):
    """SQL 数字字面量；None/NaN -> NULL"""
    if v is None:
        return "NULL"
    try:
        f = float(v)
    except (TypeError, ValueError):
        return "NULL"
    if math.isnan(f) or math.isinf(f):
        return "NULL"
    return str(round(f, nd))


def _degraded(quality, key):
    """该字段在数据质量报告里是否被降级（陈旧/置中性/失败）-> 降级字段云端写 NULL,
    小程序端读到 NULL 才会正确标记「未回填」而不是误当真实值"""
    v = str(quality.get(key, ""))
    return ("FAIL" in v) or ("置中性" in v) or ("陈旧" in v)


def build_upsert_sql(ymd, d, raw, policy=None):
    q_json = json.dumps(d.data_quality, ensure_ascii=False).replace("'", "''")
    p_json = json.dumps(policy or [], ensure_ascii=False).replace("'", "''")
    margin_ok = not _degraded(d.data_quality, "两融(沪)")
    etf_ok = not _degraded(d.data_quality, "宽基ETF")
    cols = ("ymd, d_margin, margin_pct_rank, big_order_net, big_order_net_rank, "
            "north_net_rank, etf_sub_rank, etf_net_subscribe, limit_up_cnt, "
            "max_board, broken_rate, up_ratio_rank, amt_yi, quality, policy_json, updated_at")
    vals = (
        "'" + ymd + "', "
        + (_num(d.d_margin) if margin_ok else "NULL") + ", "
        + (_num(d.margin_pct_rank) if margin_ok else "NULL") + ", "
        + _num(d.big_order_net) + ", "
        + _num(d.big_order_net_rank) + ", "
        + _num(d.north_net_rank) + ", "
        + (_num(d.etf_sub_rank) if etf_ok else "NULL") + ", "
        + (_num(d.etf_net_subscribe) if etf_ok else "NULL") + ", "
        + _num(d.limit_up_cnt) + ", "
        + _num(d.max_board) + ", "
        + _num(d.broken_rate) + ", "
        + _num(d.up_ratio_rank) + ", "
        + _num(raw.get("amount_yi")) + ", "
        + "'" + q_json + "', "
        + "'" + p_json + "', now()"
    )
    updates = ", ".join([
        "d_margin=EXCLUDED.d_margin",
        "margin_pct_rank=EXCLUDED.margin_pct_rank",
        "big_order_net=EXCLUDED.big_order_net",
        "big_order_net_rank=EXCLUDED.big_order_net_rank",
        "north_net_rank=EXCLUDED.north_net_rank",
        "etf_sub_rank=EXCLUDED.etf_sub_rank",
        "etf_net_subscribe=EXCLUDED.etf_net_subscribe",
        "limit_up_cnt=EXCLUDED.limit_up_cnt",
        "max_board=EXCLUDED.max_board",
        "broken_rate=EXCLUDED.broken_rate",
        "up_ratio_rank=EXCLUDED.up_ratio_rank",
        "amt_yi=EXCLUDED.amt_yi",
        "quality=EXCLUDED.quality",
        "policy_json=EXCLUDED.policy_json",
        "updated_at=now()",
    ])
    return ("INSERT INTO a_input_ext (" + cols + ") VALUES (" + vals + ") "
            "ON CONFLICT (ymd) DO UPDATE SET " + updates + ";")


def main():
    fr = fetch_latest(policy_stack=POLICY_TODAY)
    print_quality(fr)

    ymd = fr.raw.get("index_date")
    if not ymd:
        print("  ❌ 指数日线抓取失败，无法确定交易日，跳过云端写入")
        return

    m = ASFMM_A()
    if "--warmup" in sys.argv:
        n = warmup_history(m, fr.input, ak_symbol="sh000001")
        print(f"  [预热完成] 已回放 {n} 个交易日\n")

    r = m.step(fr.input, verbose=True)
    print("  二维矩阵：", m.pr_matrix(r["P"], r["R_adj"]))
    print("  次日推演：")
    for s in m.next_day_scenarios(r, fr.input):
        print("    -", s)
    usable, critical = ASFMM_A.quality_gate(fr.input)
    print(f"\n  {'✅' if usable else '🚫'} 数据质量闸门: "
          + ("M 可用于方向判断" if usable
             else f"M={r['M']:.1f} 不可用于方向判断, 只能看象限+告警"))

    print("\n-----BEGIN-SQL-----")
    print(build_upsert_sql(ymd, fr.input, fr.raw, POLICY_TODAY))
    print("-----END-SQL-----")


if __name__ == "__main__":
    main()
