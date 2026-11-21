<div align="center">

<img src="logo.png" alt="每日畅听会员领取" width="100" height="100" />

# 每日畅听会员领取

**EchoMusic 原生极简风每日畅听会员自动续期与打卡账本 —— 4 步进度可视化、当月打卡日历网格、原生 `Dialog` 账本与吸顶下划线 `Tabs`、播放栏响应式天数胶囊、自动领取即时调度与 SQLite 本地流水**

[![release](https://img.shields.io/github/v/release/xhd2005/echo-music-daily-vip-claim?style=flat-square&color=31cfa1&label=release)](https://github.com/xhd2005/echo-music-daily-vip-claim/releases)
[![license](https://img.shields.io/badge/license-GPL--3.0-blue?style=flat-square)](https://github.com/xhd2005/echo-music-daily-vip-claim/blob/main/LICENSE)
[![stars](https://img.shields.io/github/stars/xhd2005/echo-music-daily-vip-claim?style=flat-square&color=31cfa1)](https://github.com/xhd2005/echo-music-daily-vip-claim/stargazers)
[![EchoMusic](https://img.shields.io/badge/EchoMusic-%E2%89%A52.2.7--beta.9%20%7C%20v2.3.x-31cfa1?style=flat-square&logo=electron&logoColor=fff)](https://github.com/hoowhoami/EchoMusic)

</div>

> [EchoMusic](https://github.com/hoowhoami/EchoMusic) 插件：每日领取 1 天畅听会员（含特权升级与可选概念版任务打卡），并查看当月打卡日历与 SQLite 本地流水账本。
> 不占侧边栏 —— 入口覆盖个人中心 `.profile-details` 下方原生卡片、顶部标题栏、底部播放栏响应式胶囊及独立打卡主页。

## ✨ 功能特性

- **🎁 4 步可视化全能打卡**：清晰展示「`基础畅听 VIP` → `特权升级` → `广告打卡` → `听歌打卡`」实时状态，支持在设置中按需开关概念版子任务；今日已领后主按钮自然降级为 `今日已领 · 补同步`，失败真实反馈不误报
- **🪟 100% EchoMusic 原生极简界面**：全面采用宿主原生 `Dialog`、`DetailPageSliverHeader`（随主题色自动变色封面）、吸顶下划线 `Tabs`、`Popconfirm` 与 `RollingNumber`，彻底消除硬编码深色表面，明暗主题一致通透
- **📅 独立打卡主页与当月日历**：双 Tab 结构（`今日与月历` / `领取流水`），提供紧凑当月打卡日历网格、7 天连胜轨道、账号流水筛选（全部 / 成功 / 失败）与 `Popconfirm` 保护的当前账号清理
- **🏷️ 标题栏 & 播放栏统一交互**：标题栏与底部播放栏胶囊均采用单次注册 + 响应式 `badge` 驱动，点击统一打开原生 `Dialog` 账本（杜绝误触静默打卡），关闭播放栏开关立即卸载不残留
- **⏱️ 自动领取即时调度**：开启/关闭「启动后自动领取」即时启停定时检查（启动 5 秒、系统唤醒、每小时），无需重启客户端
- **📖 SQLite 本地流水账本 & 状态桥**：纯本地记录 `claim_ledger` 支持多账号独立统计与历史自动回填，并暴露 `globalThis.__echoMusicDailyVip`（`getStatus()` / `openLedger()` / `claimNow()`）供跨插件协同
- **🛡️ 智能风控与零侵入同步**：自动感知安全风控并适配宿主 `ctx.kugouVerification.request` 验证重试，利用 `serverIntercept` 无感刷新 VIP 到期状态

## 📦 安装

需要 EchoMusic **>= 2.2.7-beta.9**（推荐 **v2.3.x** 以获得完整原生组件与主题封面体验）。

1. EchoMusic → 设置 → 插件管理 → 插件市场 → 右上角「插件源」
2. 添加聚合源：`https://github.com/xhd2005/echo-music-plugins`
3. 在市场列表中找到「每日畅听会员领取」→ 安装

## 🔧 更新日志

- **v2.5.2**（2026-11-21）：
  - **彻底修复「听歌打卡」报 `net::ERR_EMPTY_RESPONSE`**：重构听歌打卡为四通道官方上报链——优先按宿主规范（数字 `mixsongid` + `start -> end` 完整事件对）调用 `reportListeningEvent`，依次回退至官方播放历史同步 `uploadPlayHistory` 与听歌等级时长上报 `reportListenTime`，并静默兼容旧版 `/youth/listen/song` 而不被其 `ERR_EMPTY_RESPONSE` 阻塞。
- **v2.5.1**（2026-11-21）：
  - **修复「特权升级」与「听歌打卡」失效及原因不透明**：
    - `特权升级` 精准识别已升级 / 已享高阶特权返回码（`297001` / `297002` 及语义文案）并正确标记为「今日已升级」，真实失败时保留并展示服务端返回原因。
    - `广告打卡` 支持 `GET /youth/vip` ➔ `POST /youth/vip` 回退并严格校验业务状态码；`听歌打卡` 自动读取当前播放曲目 `mixSongId` 并支持 `GET /youth/listen/song` ➔ `POST /youth/listen/song` ➔ 宿主原生 `ctx.kugou.user.reportListeningEvent` + `uploadPlayHistory` 三级回退。
    - 4 步进度卡在单步失败时直接显示具体失败原因并提供独立 **`重试`** 按钮，无需重跑已成功步骤。
- **v2.5.0**（2026-11-21）：
  - **P0 缺陷修复**：补齐 `updateBadges` 关闭播放栏胶囊时的 `unregisterPlayerbar` 卸载分支，改为单次注册 + 响应式 `badge` 驱动；封装 `syncAutoClaimScheduler` 让「启动后自动领取」开关即时生效无需重启；统一标题栏与底栏点击均打开原生 `Dialog` 账本（消除误触静默打卡）；`maybeAutoClaim`/`claimNow` 返回结构化 `{ ok, alreadyClaimed, steps, error }` 彻底修复打卡失败假阳性。
  - **第一方原生极简视觉重构**：移除全部硬编码深色色值与 `--surface-card-base`，全面改用 EchoMusic 原生主题变量与原生 `Dialog` / `Button` / `Tabs` / `Popconfirm` / `RollingNumber`；升级独立页 `ClaimPage`（`DetailPageSliverHeader` 主题变色封面 + 吸顶下划线 `Tabs` + 4 步进度 + 当月打卡日历网格 + 筛选流水）；个人中心卡片对齐 `Profile.vue` 无框轻底色与柔和胶囊标签；新增「启用概念版附加打卡任务」设置开关并暴露 `globalThis.__echoMusicDailyVip` 跨插件状态桥。
- **v2.4.0**（2026-11-08）：全面适配 EchoMusic `v2.3.2` / `v2.3.3-beta.1`；适配重构后的个人中心 `.profile-details` DOM 锚点；修复手动点击「领取 1 天」时调用 `startClaimTask` 的任务句柄异常；对齐宿主 `ctx.kugouVerification.request(challenge)` 验证码桥接签名；修复多账号切换时 SQLite 账本独立回填与刷新。
- **v2.3.0**（2026-10-18）：7 天连胜里程碑轨道、多账号实时会话切换、底栏 Playerbar 集成，全量纯矢量 SVG。
- **v2.2.0**（2026-10-10）：新增底栏 Playerbar 快捷胶囊、多账号切换无缝感知与账本隔离。
- **v2.1.1**（2026-09-22）：账本弹窗视觉优化、修复 SQLite 迁移与任务中心自动清理机制。
- **v2.0.0**（2026-09-22）：接入任务中心（Task Center）、启用 `serverIntercept`、上线 SQLite 打卡流水账本。

## 📄 许可证

[GPL-3.0](LICENSE) · Copyright © 2026 xhd2005
