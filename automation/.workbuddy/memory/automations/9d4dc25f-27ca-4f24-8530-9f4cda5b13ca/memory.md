# 自动化执行记忆 · 港股底部提醒低频输入刷新

任务：刷新「算力看盘」小程序首页「港股底部提醒」低频输入数据，写入云端表 hk_bottom_input (id=1)。

## 固定信息
- 工作目录：C:\Users\Administrator\WorkBuddy\2026-11-11-10-42-19\stock-watch\automation
- 脚本：hkbottom_refresh.py，必须用 "C:\Program Files\Python310\python"（裸 python=3.13 缺依赖）
- 云端应用：applicationId = wbapp_BuC6ir54lMo3Eq21Bvfx98，表 hk_bottom_input，主键 id=1（全量 upsert 覆盖）
- 脚本产出 SQL 写入 _hkb_refresh.sql（Read 工具按长行会截断，用 python json.dumps 取完整串），夹在 -----BEGIN-SQL-----/-----END-SQL----- 之间
- 事件判断靠本地 _hkb_state.json（脚本自动维护，勿手删/改写）
- 无免费接口的研报细项（估值分位/外资持仓/资本开支单季/ETF折价/美债）来自 _manual_seed.json 快照，需人工更新

## 执行历史
### 2026-11-19 11:50 (首次有记录的执行)
- 触发事件：无（数据未变化），routine_refresh 日常刷新
- 财报：2026年三季报，报告日 2026-09-30，营收同比 9.18%，经营现金流约1567亿，投资现金流约-1224亿，PE 12.39 / PB 2.4
- 南向：截至 2026-11-18，11月净流入 93.6亿，上月 -279.5亿，YTD 4164.7亿（同比约87%），连续净流入2天
- 云端写入成功；read 验证：as_of=2026-11-19, report_quarter=2026 Q3, fin_report=2026年三季报, south_ytd=4164.7
- 备注：_hkb_refresh.b64 是旧文件（解码长度14888），勿用；以 _hkb_refresh.sql 为准

### 2026-11-19 17:52 (日常刷新)
- 触发事件：无（数据未变化），routine_refresh
- 财报：2026年三季报，报告日 2026-09-30，营收同比 9.18%，净利率 29.99%，经营现金流 1567亿，投资现金流 -1224亿，PE 11.58 / PB 2.24（较上午 12.39/2.4 随行情变动）
- 南向：截至 2026-11-19，11月净流入 133.2亿，上月 -279.5亿，YTD 4204.3亿（同比约87%），连续净流入3天
- 云端写入成功；read 验证：as_of=2026-11-19, report_quarter=2026 Q3, fin_report=2026年三季报, south_ytd=4204.3, trigger_reason=routine_refresh
- 写入方式：SQL 含大量引号，改用 sqlBase64 传参成功；_hkb_refresh.sql 纯 SQL 无 BEGIN/END 标记，长度 2518
