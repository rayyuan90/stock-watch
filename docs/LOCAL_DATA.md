# 本地数据备份说明（vault）

> 解决「每次更新小程序，复盘数据就没了」的问题。
> 实现文件：`utils/vault.js`；云端整包表：`vault_backup`。

## 一、为什么会丢（两个原因，都已修）

1. **本机 storage 被清**：小程序重新发布、清缓存、切换开发版/体验版，`wx.storage` 会归零。
   而 `kanpan:bgHist`（多空博弈复盘）、`kanpan:sigHist`（次日倾向复盘）、
   `kanpan:posHistory`（净空单历史）这些数据是**本机算出来/手工录入的，线上查不到**，
   一旦本地被清就再也算不回来。
2. **云端本来就一条都没写进去**：`bgame_pred`、`sig_hist` 这两张云表的真实主键是
   `(ymd, model)` / `(ymd)`，**表里没有 `id` 列**，但旧代码是
   `select('id')` → 报 42703（列不存在）→ 被 `.catch(function(){})` 静默吞掉。
   结果就是：本地清空 + 云端 0 行 = 数据彻底消失。
   现已改为按业务键判重/更新（`eq('ymd')`、`eq('ymd').eq('model')`），云端写入正常。

## 二、现在的三层保险

| 层 | 位置 | 作用 |
| --- | --- | --- |
| ① storage | `wx.storage`（`kanpan:*`） | 页面读写的唯一入口，最快 |
| ② 本机文件 | `wx.env.USER_DATA_PATH/vault/kanpan-vault.json` | **真正的本地文件**，不随代码包更新清空；每天另存一份 `kanpan-vault-YYYYMMDD.json`，保留 12 份 |
| ③ 云端 | `bgame_pred` / `sig_hist`（结构化）+ `vault_backup`（整包快照，id=1） | 换设备、换版本、文件系统不可用（如托管预览）时的兜底 |

写入时机：任何模块调用 `save()` 后，`vault.touch()` 防抖 1.5 秒写盘；
切后台（`app.onHide`）、设置页保存、手动备份时**立即**写盘。

启动顺序：`app.onLaunch` → `vault.boot()`
1. 读本机文件 → 回灌 storage（页面 onLoad 就能读到历史）；
2. 本机文件没有东西 → 600ms 后拉云端 `vault_backup` 整包 → 回灌；
3. 回灌完成后触发 `vault.onApplied` 回调，首页重读配置/净空单历史/复盘卡；
4. 8 秒后强制镜像一次，保证云端副本跟手。

## 三、哪些数据会被备份

以 `kanpan:` 为前缀的 storage 键**全部自动纳入**（新增键无需改 vault）：

| 键 | 内容 | 线上可查 |
| --- | --- | --- |
| `kanpan:bgHist` | 多空博弈模型预测 + 真实涨跌幅（复盘卡） | ❌ 本机算 |
| `kanpan:sigHist` | 次日倾向复盘（信号分 + 次日开盘跳空） | ❌ 本机算 |
| `kanpan:posHistory` | 净空单历史（手工录入 + 占比） | ❌ 本机算 |
| `kanpan:config` | 看盘配置（成本、份额、当日净空单） | ❌ 本机录入 |
| `kanpan:citPos` | 中金所前 20 席位解析结果缓存 | 半可重算 |
| `kanpan:watch` / `kanpan:watchMeta` | 自选列表与同步标记 | 云端另有 watchlist |

**不备份**：`barscache_*`（日K缓存，体积大且可重算）。

## 四、怎么用

设置页 →「本地数据备份」卡片：

- **立即备份**：立刻写本机文件 + 云端整包，并显示条数。
- **从备份恢复**：先读本机文件，没有就拉云端整包；提示「找回 N 项，补全 N 项」。
- **复制备份文本**：把整包 JSON 复制到剪贴板（换手机时用微信发给自己）。
- **从剪贴板恢复**：把之前复制的 JSON 粘回来。

合并规则（关键，保证不会互相覆盖）：
- 同一条记录（`ymd|model` / `date` / `sec` 对齐）按**字段级「有值优先」**合并，
  `null`/空 不会覆盖已有值；
- 所以「新算的预测」不会冲掉「旧的真实涨跌幅」，反之也不会；
- 回灌时按各模块的条数上限截断（bgHist 180、sigHist 120、posHistory 60、watch 20）。

## 五、开发约定

1. 任何只在本机存在的数据，storage 键必须以 `kanpan:` 开头，就自动纳入备份；
2. 写 storage 后调用 `require('../vault').touch(原因)`（列表类）、
   或在关键节点用 `vault.flush(原因)` 立即落盘；
3. 云表的判重/更新**只能用业务主键**，先确认表有没有 `id` 列：
   `bgame_pred(ymd,model)`、`sig_hist(ymd)`、`a_input_ext(ymd)`、`cffex_pos(ymd,product)`
   都没有 `id`；`portfolio` / `futures_daily` / `watchlist` 有 `id`。
4. 云写入的 `.catch` 不要完全静默，至少 `console.warn`：这次的问题就是被空 catch 掩盖的。
