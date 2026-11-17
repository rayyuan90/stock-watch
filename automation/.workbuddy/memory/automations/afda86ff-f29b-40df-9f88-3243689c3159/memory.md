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

## 已修复（2026-11-17）
- `datasource.py` 指数段已改：新浪日线缺当日 K 线时用 `stock_zh_index_daily_tx` 补当日 OHLC（腾讯 amount 列实为"手"，需 ×100 换算成股再乘 AMT_CALIB，否则分位/成交额全错）。
  **原因**：新浪日线收盘后常滞后数小时，而涨停/大单/解禁用当日快照 → 曾出现「ymd=昨日、慢变量已是今日」错位行。
- `amt_yi` 已改用交易所官方口径：`stock_sse_deal_daily(date=YYYYMMDD)` 的「成交金额-股票」列(亿元) + `stock_szse_summary` 的「股票」成交金额/1e8。11-17 校验 6912.50+7680.07=14592.57 亿。**不再需要每次人工修补成交额。**
- 旧待跟进问题（量纲 40 倍、腾讯 amount 当元用）已随上述改动关闭。

## 待跟进问题
- 表中 2026-11-16 缺行（当日无运行），11-13 直接跳到 11-17。若小程序做"较上一交易日"环比，需注意缺口。
- 若程序在 15:00~17:00 之间跑，腾讯也已更新当日则可自洽；若两者都未更新则仍会写上一交易日行，需在汇报中注明。

## 执行记录
- 2026-11-13 12:27 运行成功。写入 ymd=2026-11-12（新浪指数日线未更新当日，属预期）。M=95.7 但质量闸门 🚫（两融陈旧+ETF 缺失），仅可看象限/告警。象限 Q1 加速主升，操作「持多但不加仓」。政策栈为空。
- 2026-11-14 19:58 运行成功（周六，写入最新交易日 ymd=2026-11-13）。指数 3634.35 / -0.59%，两市成交额 16569.00 亿（已人工修正 amt_yi）。M=-5.2、闸门 🚫；象限 Q3 缩量耗尽、双杀背离、操作「空仓/等政策或地量」。情绪转弱（炸板率 49.4%、A 连负 2 期、破 20 日线）。政策栈空。云端写入 + 读回验证均正常。
- 2026-11-17 16:40 运行成功。新浪日线停在 11-16 但慢变量已是 11-17 → 先补 index/成交额口径后重跑，最终自洽写入 ymd=2026-11-17（指数 3584.58 / -0.50%，成交额 14592.57 亿）。M=15.7、闸门 🚫；Q3 缩量耗尽 + 双杀背离，操作「空仓/等政策或地量」。情绪：涨停 37 / 炸板率 47.9% / 最高 5 板。卖压：未来5日解禁 290.04 亿、近20日净减持 1.52 亿、20日乖离 -1.92%、G=49.1。云端 upsert + 读回校验一致。政策栈空。
