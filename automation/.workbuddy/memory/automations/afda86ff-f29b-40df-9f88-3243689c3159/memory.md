# A股 ASFMM-A v2 每日收盘打分 + 云端写入

## 运行要点（固定流程）
- 目录：`C:\Users\Administrator\WorkBuddy\2026-11-11-10-42-19\stock-watch\automation`
- 命令：`python run_and_push.py --warmup`（必须带 --warmup，否则 EMA 无历史使 A/E' 失真）
- 取 `-----BEGIN-SQL-----` / `-----END-SQL-----` 之间的单条语句，用 cloudservice_db_exec_sql 以 applicationId=wbapp_BuC6ir54lMo3Eq21Bvfx98、mode=write 写入表 a_input_ext（主键 ymd，同日覆盖）
- 验证 SQL：SELECT ymd, big_order_net, big_order_net_rank, etf_sub_rank, limit_up_cnt, broken_rate, max_board FROM a_input_ext ORDER BY ymd DESC LIMIT 2

## 已知数据源问题（长期存在，非本次失败）
- 两融(沪) 数据源 ak.stock_margin_sse 陈旧（最新仍为 20230922），按设计 d_margin/margin_pct_rank 写 NULL，小程序降级中性
- 宽基ETF 份额接口不可用 → etf_sub_rank/etf_net_subscribe 写 NULL
- north_net 返回 NaN → 置 0，north_net_rank=50
- 公募仓位/解禁/减持/浮盈 无免费日频源，恒为中性

## 待跟进问题
- `datasource.py` 的成交额估算 `amount = volume * close * AMT_CALIB(0.39)` 量纲有误，输出约为真实两市成交额的 40 倍（2026-11-12 脚本给 707943.74 亿 / 真实 19320.82 亿；2026-11-13 脚本给 669427.93 亿 / 真实 16569.00 亿）。该值仅用于脚本内部历史分位（rank 不受比例影响），但写入云端 amt_yi 会误导展示。目前每次运行后需人工替换为真实值。
- 已确认可用的真实成交额口径（东方财富接口在本机被拒，走交易所官方）：`ak.stock_sse_deal_daily(date=YYYYMMDD)` 取「成交金额」股票列（亿）+ `ak.stock_szse_summary(date=YYYYMMDD)` 取「股票」成交金额 /1e8。11-12 校验：8804.39+10534.14=19338.53 ≈ 已知真实 19320.82，口径可靠。建议把该口径写入 datasource.py 后去掉人工修补。

## 执行记录
- 2026-11-13 12:27 运行成功。写入 ymd=2026-11-12（新浪指数日线未更新当日，属预期）。M=95.7 但质量闸门 🚫（两融陈旧+ETF 缺失），仅可看象限/告警。象限 Q1 加速主升，操作「持多但不加仓」。政策栈为空。
- 2026-11-14 19:58 运行成功（周六，写入最新交易日 ymd=2026-11-13）。指数 3634.35 / -0.59%，两市成交额 16569.00 亿（已人工修正 amt_yi）。M=-5.2、闸门 🚫；象限 Q3 缩量耗尽、双杀背离、操作「空仓/等政策或地量」。情绪转弱（炸板率 49.4%、A 连负 2 期、破 20 日线）。政策栈空。云端写入 + 读回验证均正常。
