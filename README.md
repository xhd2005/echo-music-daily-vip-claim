<div align="center">

<img src="logo.png" alt="每日畅听会员领取" width="100" height="100" />

# 每日畅听会员领取

**每天一键领取 1 天畅听会员 —— 个人中心直达，支持自动领取与当月记录**

[![release](https://img.shields.io/github/v/release/xhd2005/echo-music-daily-vip-claim?style=flat-square&color=31cfa1&label=release)](https://github.com/xhd2005/echo-music-daily-vip-claim/releases)
[![license](https://img.shields.io/badge/license-GPL--3.0-blue?style=flat-square)](https://github.com/xhd2005/echo-music-daily-vip-claim/blob/main/LICENSE)
[![stars](https://img.shields.io/github/stars/xhd2005/echo-music-daily-vip-claim?style=flat-square&color=31cfa1)](https://github.com/xhd2005/echo-music-daily-vip-claim/stargazers)
[![EchoMusic](https://img.shields.io/badge/EchoMusic-%E2%89%A52.2.7--beta.9-31cfa1?style=flat-square&logo=electron&logoColor=fff)](https://github.com/hoowhoami/EchoMusic)

</div>

> [EchoMusic](https://github.com/hoowhoami/EchoMusic) 插件：每日领取 1 天畅听会员（含升级），并查看当月领取记录。
> 不占侧边栏 —— 入口在个人中心「会员状态」下方，设置项支持自定义自动领取。

## ✨ 功能特性

- **🎁 每日领取**：一键领取 1 天畅听会员，领取后自动升级为畅听权益（升级失败不影响领取结果）
- **🧩 个人中心嵌入**：领取卡片直接出现在 个人中心 → 会员状态 下方，与会员卡同区操作
- **⚡ 实时状态**：卡片实时展示「畅听到期 X · 本月已领 N 天 · 今日已领取」
- **📅 当月记录**：查看 / 收起当月领取记录列表；领取成功 toast 带「查看记录」动作一键展开
- **🤖 自动领取**：设置 → 插件管理 → 本插件 中可开启「启动后自动领取」（启动 5 秒 / 系统休眠唤醒 / 每小时各检查一次；今日已领取时静默跳过，失败自动重试一次）
- **🔒 并发防护**：多入口同时点领取 / 自动任务并发时，仅触发一次领取请求（单飞锁去重）
- **👤 登录感知**：未登录时显示去登录引导，领取前自动预检登录态
- **💬 友好提示**：重复领取提示「今日已领取，明天再来」、登录过期提示「请重新登录」，网络 / 上游异常不裸露原始错误码
- **🔄 状态同步**：领取成功后即时刷新个人中心的会员徽章

## 📦 安装

**方式一：Release 安装包（推荐）**

1. 从 [Releases](https://github.com/xhd2005/echo-music-daily-vip-claim/releases) 下载 `daily-vip-claim-v*.zip`
2. 打开 EchoMusic → 设置 → 插件管理，把 zip 拖入本地安装区
3. 在插件列表中找到本插件并打开启用开关

**方式二：插件源（推荐，可同步两个插件）**

1. EchoMusic → 设置 → 插件管理 → 插件市场 → 右上角「插件源」
2. 添加聚合源：`https://github.com/xhd2005/echo-music-plugins`（同时收录本插件与「听歌统计」）
3. 在市场列表中找到「每日畅听会员领取」→ 安装

**方式三：插件源导入（本仓库）**

1. EchoMusic → 设置 → 插件管理 → 插件市场 → 右上角「插件源」
2. 添加地址：`https://github.com/xhd2005/echo-music-daily-vip-claim`
3. 在市场列表中找到「每日畅听会员领取」→ 安装

> 插件源通过仓库根目录的 [`echo-plugins.json`](echo-plugins.json) 索引解析插件；拉取失败时可在 EchoMusic 设置中配置 GitHub 代理（如 `https://gh-proxy.com/`）。

**方式四：源码安装**

把仓库根目录（`manifest.json` 所在目录）整体复制为：

- 打包版（Release 安装的 EchoMusic）：`%APPDATA%\EchoMusic\plugins\daily-vip-claim\`
- 开发版（源码运行的 EchoMusic）：`%APPDATA%\echo-music\plugins\daily-vip-claim\`

> 目录名必须等于 `manifest.json` 中的 `id`（`daily-vip-claim`）。

## 🚀 使用

| 入口 | 位置 |
| --- | --- |
| **个人中心领取** | 个人中心（已登录）→「会员状态」卡片下方直接点「领取」 |
| **设置项** | 设置 → 插件管理 → 每日畅听会员领取 → 打开插件设置（自动领取开关 + 快速领取） |
| **命令** | `daily-vip-claim:open`，可在快捷键设置中绑定 |
| **页面路由** | `/main/plugin/daily-vip-claim/claim` |

每天只能领取一次；领取日期以本机日期为准（`YYYY-MM-DD`）。

## 🛠️ 技术栈

![JavaScript](https://img.shields.io/badge/JavaScript-ESM-F7DF1E?style=flat-square&logo=javascript&logoColor=000)
![Vue](https://img.shields.io/badge/Vue-3.x-4FC08D?style=flat-square&logo=vuedotjs&logoColor=fff)
![Electron](https://img.shields.io/badge/Electron-runtime-47848F?style=flat-square&logo=electron&logoColor=fff)
![kugou API](https://img.shields.io/badge/kugou_API-host_proxy-31cfa1?style=flat-square)

## 🔧 技术说明

- **能力声明**：`capabilities.kugouApi` —— 通过宿主 `ctx.kugou` 代理调用酷狗接口，登录态 / 设备态由宿主自动注入，**插件不接触用户令牌**
- **接口**：`GET /youth/day/vip`（领取）、`GET /youth/day/vip/upgrade`（升级）、`GET /youth/month/vip/record`（记录）
- **个人中心卡片为自愈式注入**：宿主导航 / 刷新会重建页面 DOM，插件用 MutationObserver 检测卡片丢失后自动在「会员状态」下方恢复挂载
- **到期时间与个人中心同源**：直接读宿主 Pinia user store 的 `busi_vip`，无需额外接口
- **自动领取幂等**：用当月记录预判「今日已领」，命中则不打领取请求，避免重复请求与 131001 噪音；多入口并发由单飞锁去重
- **无构建步骤**：纯 ESM（`activate` / `deactivate` 入口）+ 渲染函数 + 宿主组件，改完文件 → 插件管理 → 刷新插件 即可生效
- **样式隔离**：插件 CSS 全局生效，严格以 `.dvp-` 前缀隔离，仅使用宿主 CSS 变量适配主题

## 📁 仓库结构

```text
echo-music-daily-vip-claim/
├── manifest.json     # 插件清单（id / 名称 / 能力声明 kugouApi）
├── index.js          # 插件入口（activate / deactivate，渲染函数，无需构建）
├── logo.png          # 插件图标
├── echo-plugins.json # 插件源索引（插件市场「插件源」导入本仓库时解析）
├── README.md         # 本文件
└── LICENSE           # GPL-3.0
```

## ❓ 常见问题

- **提示「今日已领取，明天再来」**：酷狗每日限领一次（错误码 131001），次日再来即可
- **提示「请先登录后再领取每日畅听会员」**：请先登录酷狗账号
- **记录为空**：本月暂无领取记录；记录仅覆盖当月
- **领取成功后个人中心徽章未变**：等待数秒或重新进入个人中心即可刷新
- **自动领取没有生效**：确认已在插件设置中开启「启动后自动领取」；自动领取在应用启动 5 秒后、系统休眠唤醒、运行中每小时各检查一次，未登录或今日已领取时自动跳过
- **提示「登录已过期，请重新登录」**：酷狗登录态失效（错误码 20018），请重新登录酷狗账号

## 版本要求

- EchoMusic >= 2.2.7-beta.9

## ⚠️ 免责声明

- 本插件为第三方社区作品，与酷狗音乐、EchoMusic 官方无关
- 领取功能仅调用酷狗公开接口，未修改、未破解、未绕过任何客户端限制；每日限领规则仍由酷狗服务端强制执行
- 本插件不收集、不上传任何用户数据；登录凭据由 EchoMusic 宿主保管，插件代码不接触令牌
- 请确认你的使用行为符合酷狗音乐相关服务条款；因使用本插件产生的任何账号问题或其他后果，由使用者自行承担

## 📄 许可证

[GPL-3.0](LICENSE) · Copyright © 2026 xhd2005
