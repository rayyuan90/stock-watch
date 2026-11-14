# -*- coding: utf-8 -*-
"""当日政策叠加（人工判断维护；政策无法自动抓取，这是 v2 的设计而非偷懒）。

格式（三选一，可混用）：
  {"ptype": "RRR_CUT", "age": 1}                       # 从政策库取默认方向/通道/力度/半衰期
  {"ptype": "RRR_CUT", "age": 1, "strength": 2}        # 覆盖力度
  {"direction": -1, "channel": "E", "strength": 2, "decay": 8, "age": 0, "note": "自定义"}

政策库可用 ptype（详见 asfmm_a_model_v2.py POLICY_LIBRARY）：
  流动性红利(+1)：RRR_CUT 降准 / RATE_CUT 降息 / SFISF 互换便利 / STRUCTURAL_EASE 结构性工具
                  NATIONAL_TEAM 国家队增持 / TRADING_COST_CUT 降印花税 / IPO_PAUSE IPO放缓
                  STOCK_PLEDGE_RELIEF 纾困 / LONG_FUND_GUIDE 中长资金指引
  监管打压(-1)：SPECULATION_CRACKDOWN 打击炒作 / QUANT_TIGHTEN 量化收紧
                SMALL_CAP_CRACKDOWN 整顿小市值 / MARGIN_TIGHTEN 两融收紧
                CLEARING_CRACKDOWN 减持整治 / SECTOR_COOLING 行业降温
  age = 政策已生效天数（0 = 当天宣布当天算）。
"""
POLICY_TODAY = [
    # 示例（不用时保持空列表）：
    # {"ptype": "RRR_CUT", "age": 1},
    # {"ptype": "SPECULATION_CRACKDOWN", "age": 0},
]
