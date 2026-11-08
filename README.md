<div align="center">

<img src="logo.png" alt="每日畅听会员领取" width="100" height="100" />

# 每日畅听会员领取

**每天一键领取 1 天畅听会员与全套打卡 —— 官方任务中心调度、SQLite 本地流水账本、标题栏/底栏动态天数胶囊、全能版概念打卡与零侵入服务拦截**

[![release](https://img.shields.io/github/v/release/xhd2005/echo-music-daily-vip-claim?style=flat-square&color=31cfa1&label=release)](https://github.com/xhd2005/echo-music-daily-vip-claim/releases)
[![license](https://img.shields.io/badge/license-GPL--3.0-blue?style=flat-square)](https://github.com/xhd2005/echo-music-daily-vip-claim/blob/main/LICENSE)
[![stars](https://img.shields.io/github/stars/xhd2005/echo-music-daily-vip-claim?style=flat-square&color=31cfa1)](https://github.com/xhd2005/echo-music-daily-vip-claim/stargazers)
[![EchoMusic](https://img.shields.io/badge/EchoMusic-%E2%89%A52.2.7--beta.9%20%7C%20v2.3.3-31cfa1?style=flat-square&logo=electron&logoColor=fff)](https://github.com/hoowhoami/EchoMusic)

</div>

> [EchoMusic](https://github.com/hoowhoami/EchoMusic) 插件：每日领取 1 天畅听会员（含升级与概念版任务打卡），并查看当月领取记录与 SQLite 本地流水账本。
> 不占侧边栏 —— 入口在个人中心「账号概况 / 会员状态」下方、顶部标题栏与底部播放栏，设置项支持自定义自动领取。

## ✨ 功能特性

- **🎁 全能版打卡流程**：一键执行「1 天基础畅听 VIP 领取 + 概念特权升级 + 概念版模拟广告打卡 + 概念版听歌任务打卡」，多维度获取会员权益与成长值
- **🏷️ 标题栏 & 底栏动态天数胶囊**：主界面顶部标题栏与底部播放栏常驻动态天数胶囊（如 `畅听VIP · 28天` / `已领 · 28天`），点击一键唤出流水账本
- **📖 SQLite 本地流水账本**：纯本地记录打卡明细表 `claim_ledger`，支持多账号独立统计与历史记录自动回填，展示「7 天连胜里程碑轨道」、「连续打卡天数」与「累计省钱金额（约 ¥0.5/天）」
- **📋 官方任务中心世代管理**：深度接入 EchoMusic 任务中心（`ctx.tasks`），支持后台运行进度细分追踪与完成后自动消隐
- **🛡️ 零侵入服务请求拦截**：利用 `capabilities.serverIntercept` 拦截主程序发往酷狗的 `/user/` 与 `/youth/` 请求，静默感知用户登录态与会员到期时间变更
- **🤖 智能风控感知**：自动感知滑动验证码与安全风控状态（适配宿主 `ctx.kugouVerification.request`），验证通过后自动重试领取
- **🧩 个人中心自愈式嵌入**：完美适配 EchoMusic `v2.3.2` / `v2.3.3-beta.1` 新版个人中心 `.profile-details` 布局（同时向下兼容旧版布局），切换账号实时刷新状态

## 📦 安装

需要 EchoMusic **>= 2.2.7-beta.9**（完全适配最新 **v2.3.2 / v2.3.3-beta.1**）。

1. EchoMusic → 设置 → 插件管理 → 插件市场 → 右上角「插件源」
2. 添加聚合源：`https://github.com/xhd2005/echo-music-plugins`
3. 在市场列表中找到「每日畅听会员领取」→ 安装

## 🔧 更新日志

- **v2.4.0**（2026-11-08）：全面适配 EchoMusic `v2.3.2` / `v2.3.3-beta.1`；适配重构后的个人中心 `.profile-details` DOM 锚点（挂载于「账号概况/会员状态」下方并兼容旧版布局）；修复手动点击「领取 1 天」时调用 `startClaimTask` 的任务句柄异常；对齐宿主 `ctx.kugouVerification.request(challenge)` 验证码桥接签名；修复多账号切换时 SQLite `claim_ledger` 历史记录按 `user_id` 独立回填与卡片实时刷新。
- **v2.3.0**（2026-10-18）：黑曜石高级感重塑：7天连胜里程碑轨道、触觉微动效打卡变形按钮、多账号无缝实时会话切换、底栏 Playerbar 快捷集成，全量剔除 Emoji 换用纯矢量 SVG。
- **v2.2.0**（2026-10-10）：适配 EchoMusic beta.9 新版特性：新增底栏 Playerbar 快捷打卡胶囊、多账号切换无缝实时感知与账本数据隔离。
- **v2.1.1**（2026-09-22）：账本弹窗视觉全面美化、修复 SQLite 迁移与任务中心自动清理机制。
- **v2.0.0**（2026-09-22）：接入任务中心（Task Center）、启用 `serverIntercept`、上线 SQLite 打卡流水账本。

## 📄 许可证

[GPL-3.0](LICENSE) · Copyright © 2026 xhd2005
