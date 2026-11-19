# 正式版 request 合法域名配置说明（第三方代管模式）

> 适用：算力看盘发布正式版后，扫码打开所有行情显示 `--` / 离线快照，
> 报错 `request:fail url not in domain list`，而体验版正常。
> 本文整理自 WorkBuddy 官方文档（2026-11-19 查证）与微信小程序规则。

## 一、先弄清归属：小程序本来就是你的

WorkBuddy 官方文档原文：

> 「WorkBuddy 会以微信**第三方服务商身份**接入你授权的小程序账号，协助完成代码上传、提交审核和版本发布。**小程序账号始终归你所有**。」

也就是说，这不是"WorkBuddy 的小程序"，是你的小程序授权给了 WorkBuddy 代发。
问题不在于归属，而在于：**第三方代管模式下，「开发设置 → 服务器域名」由第三方平台代为配置**，你在公众平台后台会看到"已被第三方平台代管"，看不到也改不了服务器域名和版本记录。

## 二、为什么体验版正常、正式版全挂

- 体验版 / 开发版：微信默认允许"不校验合法域名"（开发者工具里也勾了 `urlCheck: false`），所以哪怕一个域名没配，行情照样能拉通。
- 正式版：**强制校验 request 合法域名**，一个都不能少。没配的域名全部被 `url not in domain list` 拦掉，只能退回离线快照。

所以体验版能跑不代表配置好了，恰恰是把问题掩盖了。

## 三、官方有没有自助配置入口？——没有

查证结果（2026-11-19）：

- WorkBuddy 官方文档「小程序开发与发布」全篇，发布前「小程序设置」只列三项：**小程序备案、用户隐私保护指引、UGC 信息安全声明**，没有"服务器域名 / request 合法域名"这一项。
- WorkBuddy 官方帮助文档全站（含 workbuddymini 分站）没有配置 request 合法域名的说明。
- 分享面板里只有：绑定 / 发布 / 更新 / 解绑 / 小程序设置，没有域名配置入口。

**结论：只能联系 WorkBuddy 官方，请他们以第三方平台身份代为添加。**

## 四、推荐做法：联系 WorkBuddy 官方代加

### 渠道 1：应用内「意见反馈」（官方推荐的报问题方式）

1. 点击 WorkBuddy 左下角**头像** → **意见反馈**；
   （或：头像 → 设置 → 左侧导航底部「获取帮助」→ 右侧「填写反馈」）
2. 粘贴下方「诉求模板」；
3. 上传首页报错截图，**勾选上传日志**（官方明确说这样有助于定位）；
4. 点「提交反馈」。
   若想先自动排查，可在反馈窗口里点「智能诊断」。

### 渠道 2：技术支持邮箱

发邮件到 **workbuddy@tencent.com**（官方文档列出的技术支持邮箱）。

### 可直接复制的诉求模板

```
主题：第三方代管小程序正式版需添加 request 合法域名（算力看盘）

您好，我的小程序通过 WorkBuddy 以第三方服务商身份代管发布，
正式版上线后所有行情接口被微信拦截，报错 request:fail url not in domain list，
体验版因跳过域名校验而正常。这些域名属于公开行情接口，
麻烦协助在第三方平台侧添加到 request 合法域名，谢谢。

小程序名称：算力看盘
小程序 AppID：wx1d07e68793e3a38c
问题版本：正式版

需要添加的 request 合法域名（共 9 个，https 协议）：
https://push2.eastmoney.com
https://push2his.eastmoney.com
https://push2ex.eastmoney.com
https://qt.gtimg.cn
https://web.ifzq.gtimg.cn
https://searchapi.eastmoney.com
https://datacenter-web.eastmoney.com
https://hq.sinajs.cn
https://mp-api.app.workbuddy.host

域名用途：
- push2 / push2his / push2ex.eastmoney.com：实时行情、K线、涨停炸板数据
- qt.gtimg.cn / web.ifzq.gtimg.cn：腾讯行情备用源（东财限流时降级）
- searchapi.eastmoney.com：自选标的搜索
- datacenter-web.eastmoney.com：南向资金、港股财报（港股底部研判）
- hq.sinajs.cn：全球市场日经期货 / VIX 期货
- mp-api.app.workbuddy.host：WorkBuddy 云服务（快照与持仓）

已附首页报错截图与日志。域名加好后会重新提交正式版发布使其生效。
```

## 五、备选：解除代管，自己配域名

如果你更想完全自己掌控（对应"变成自家"），可以解除 WorkBuddy 的第三方授权。官方给出的解绑步骤：

1. 登录[微信公众平台](https://mp.weixin.qq.com/)；
2. 进入「管理 → 账号设置 → 第三方设置 → 第三方平台授权管理」；
3. 找到已授权的平台，点右侧「解除授权」；
4. 返回 WorkBuddy，重新扫码授权（若是换绑回 WorkBuddy）。

解除授权后，自己可在公众平台「开发管理 → 开发设置 → 服务器域名 → request 合法域名」里添加上面 9 个域名。

**代价（重要）**：解除后 WorkBuddy 就不能再替你上传代码和提交审核了，后续发版要用微信开发者工具手工操作。这是一条"重"路线，除非确实需要自主掌控，否则建议优先走第四节联系官方代加。

## 六、域名加好之后的必要动作

域名配置本身不会自动同步到已上线版本，必须：

1. 回到 WorkBuddy 的分享面板，点「更新」；
2. 重新提交正式版审核（每周审核次数以面板显示为准）；
3. 审核通过并发布后，正式版才会用上新的域名白名单。

## 七、其他官方联系渠道

- 技术支持邮箱：workbuddy@tencent.com
- 应用内意见反馈：左下角头像 → 意见反馈
- 售前咨询 / 用户交流：官方文档「联系我们」页提供企业微信二维码、腾讯频道、官方公众号
  官方联系页：https://www.workbuddy.cn/docs/workbuddy/Contact
- 小程序官方发布文档：
  https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/App-Publishing/Mini-Program
