// 每日畅听会员领取插件
// 通过 ctx.kugou 复用宿主登录态调用酷狗 API（插件不接触用户令牌），
// 领取 1 天畅听会员（含升级），并展示当月领取记录与实时到期/领取统计。
//
// 入口分布（v1.2）：
// - 个人中心「会员状态」下方嵌入领取卡片（MutationObserver 自愈注入）
// - 插件设置项（设置 → 插件管理 → 本插件）：自动领取开关 + 快速领取卡片
// - 独立页面（无侧边栏入口，可通过命令/快捷键打开）：/main/plugin/daily-vip-claim/claim
//
// 自动领取：启动 5 秒后、系统休眠唤醒、运行中每小时各检查一次；
// 用当月记录预判「今日已领」，命中则静默跳过，避免重复领取请求与 131001 噪音。

// ---- 模块级辅助函数（与宿主内置实现逐一对齐） ----

const pad = (n) => String(n).padStart(2, '0');

// 构造 YYYY-MM-DD 格式日期（receive_day 要求的格式，必须用本地时间，避免 UTC 偏移）
const formatClaimDate = (date = new Date()) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

// 数字（秒）时间戳 → 本地 YYYY-MM-DD
const formatSecondsDate = (value) => {
  const date = new Date(Number(value) * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

// 酷狗 API 已知错误码 → 友好提示映射
const VIP_ERROR_HINTS = {
  131001: '今日已领取，明天再来',
  20018: '登录已过期，请重新登录',
  // 后续发现新错误码在此追加
};

// 从 API 错误中提取可读消息：
// - 优先读酷狗标准字段 error_msg，回退到 msg（网络异常路径）
// - 已知错误码映射为友好提示，未知错误码不裸露数字
const getApiErrorMessage = (error, fallback) => {
  const body = error?.response?.body;
  const msg = body?.error_msg ?? body?.msg;
  if (typeof msg === 'string' && msg.trim()) return msg.trim();
  const code = body?.error_code;
  if (code != null && Number(code) !== 0) {
    const hint = VIP_ERROR_HINTS[Number(code)];
    if (hint) return hint;
  }
  return `${fallback}，请稍后重试`;
};

const isClaim131001 = (error) =>
  Number(error?.response?.body?.error_code) === 131001;

// ---- SQLite 本地打卡流水账本 ----

const userVipState = {
  userId: '',
  tvipEndTime: null,
  isVip: false,
  lastUpdated: 0,
};


// 查询概念版 Young VIP 联合信息（KuGouMusicApi /v2/batch_union_vipinfo 接口）
const fetchConceptUnionVipInfo = async (ctx, userId) => {
  if (!userId) return null;
  try {
    const res = await sendInternalApiRequest(ctx, {
      method: "POST",
      url: "/v2/batch_union_vipinfo",
      data: {
        useridlist: [Number(userId)],
        busi_type: "concept",
        get_type: "2",
      },
    });
    const busiVip = res?.body?.data?.busi_vip;
    if (busiVip && typeof busiVip === "object") {
      const userVipArr = busiVip[userId] || busiVip[Number(userId)];
      if (Array.isArray(userVipArr)) {
        const tvip = userVipArr.find(
          (v) => v && (v.product_type === "tvip" || v.busi_type === "concept") && v.is_vip === 1,
        );
        if (tvip && tvip.vip_end_time) {
          return tvip.vip_end_time;
        }
      }
    }
  } catch (err) {
    // 降级非阻断
  }
  return null;
};

const readUserId = (ctx) => {
  try {
    const store = ctx.pinia && ctx.pinia._s && ctx.pinia._s.get('user');
    const id = store?.info?.userid || store?.info?.userId || store?.userid || store?.userId;
    if (id) {
      userVipState.userId = String(id);
      return String(id);
    }
  } catch {}
  return userVipState.userId || '';
};

// ---- SQLite 本地打卡流水账本 ----

const LEDGER_DB_NAME = 'vip_claim_ledger';
let ledgerDb = null;

const initLedgerDb = async (ctx) => {
  if (!ctx.sqlite || typeof ctx.sqlite.open !== 'function') return null;
  try {
    const res = await ctx.sqlite.open({
      name: LEDGER_DB_NAME,
      migrations: [
        {
          version: 1,
          sql: [
            `CREATE TABLE IF NOT EXISTS claim_ledger (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              user_id TEXT NOT NULL DEFAULT '',
              claim_date TEXT NOT NULL,
              claimed_at INTEGER NOT NULL,
              expiry_text TEXT NOT NULL DEFAULT '',
              upgrade_status INTEGER NOT NULL DEFAULT 0,
              concept_task_status INTEGER NOT NULL DEFAULT 0,
              duration_ms INTEGER NOT NULL DEFAULT 0,
              status TEXT NOT NULL DEFAULT 'success',
              message TEXT NOT NULL DEFAULT ''
            );`,
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_ledger_day ON claim_ledger(user_id, claim_date);`,
            `CREATE INDEX IF NOT EXISTS idx_claim_ledger_time ON claim_ledger(claimed_at);`,
          ],
        },
        {
          version: 2,
          sql: [
            `SELECT 1;`,
          ],
        },
      ],
    });
    if (res && res.ok) {
      ledgerDb = res;
      console.info('[daily-vip-claim] SQLite 本地账本加载就绪');
      // 冷启动历史记录同步：若账本为空，自动从当月已领记录回填
      void backfillLedgerFromMonthRecords(ctx, readUserId(ctx));
      return ledgerDb;
    } else {
      console.warn('[daily-vip-claim] 打开 SQLite 本地账本未成功:', res?.error);
    }
  } catch (err) {
    console.warn('[daily-vip-claim] 打开 SQLite 本地账本异常:', err);
  }
  return null;
};

// 冷启动历史记录自动回填（若本地账本为空，从酷狗当月已打卡接口同步）
const backfillLedgerFromMonthRecords = async (ctx, userId = '') => {
  if (!ledgerDb) return;
  try {
    const countRes = await ledgerDb.get('SELECT COUNT(*) AS total FROM claim_ledger');
    const existingCount = Number(countRes?.row?.total || 0);
    if (existingCount > 0) return;

    const records = await getMonthRecordsCached(ctx).catch(() => []);
    if (!Array.isArray(records) || records.length === 0) return;

    const uid = String(userId || readUserId(ctx) || '');
    for (const rec of records) {
      if (!rec || !rec.date) continue;
      const claimedAt = new Date(`${rec.date} 12:00:00`).getTime() || Date.now();
      await ledgerDb.run(
        `INSERT OR IGNORE INTO claim_ledger
          (user_id, claim_date, claimed_at, expiry_text, upgrade_status, concept_task_status, duration_ms, status, message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uid,
          rec.date,
          claimedAt,
          '',
          1,
          0,
          80,
          'success',
          rec.label || '当月已领记录',
        ],
      );
    }
    console.info(`[daily-vip-claim] 已自动同步 ${records.length} 条当月打卡历史到本地账本`);
  } catch (err) {
    console.warn('[daily-vip-claim] 自动同步当月历史打卡记录异常:', err);
  }
};

const recordClaimLedger = async ({
  userId = '',
  claimDate,
  claimedAt = Date.now(),
  expiryText = '',
  upgradeStatus = 0,
  conceptTaskStatus = 0,
  durationMs = 0,
  status = 'success',
  message = '',
}) => {
  if (!ledgerDb) return;
  try {
    await ledgerDb.run(
      `INSERT OR REPLACE INTO claim_ledger
        (user_id, claim_date, claimed_at, expiry_text, upgrade_status, concept_task_status, duration_ms, status, message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        String(userId || ''),
        claimDate,
        claimedAt,
        String(expiryText || ''),
        upgradeStatus ? 1 : 0,
        conceptTaskStatus ? 1 : 0,
        durationMs,
        status,
        String(message || ''),
      ],
    );
  } catch (err) {
    console.warn('[daily-vip-claim] 写入 SQLite 账本失败:', err);
  }
};

const getLedgerStats = async (userId = '') => {
  if (!ledgerDb) return { totalSuccess: 0, savedMoney: 0, recentLogs: [] };
  try {
    const uid = String(userId || '').trim();
    const whereClause = uid ? 'WHERE (user_id = ? OR user_id = "")' : '';
    const params = uid ? [uid] : [];
    const totalRes = await ledgerDb.get(
      `SELECT COUNT(*) AS total FROM claim_ledger ${
        uid ? 'WHERE status = "success" AND (user_id = ? OR user_id = "")' : 'WHERE status = "success"'
      }`,
      params,
    );
    const totalSuccess = Number(totalRes?.row?.total || 0);
    // 酷狗畅听 VIP 市价折合约 0.5 元/天
    const savedMoney = Math.round(totalSuccess * 0.5 * 10) / 10;
    const logsRes = await ledgerDb.all(
      `SELECT * FROM claim_ledger ${whereClause} ORDER BY claimed_at DESC LIMIT 50`,
      params,
    );
    return {
      totalSuccess,
      savedMoney,
      recentLogs: logsRes?.rows || [],
    };
  } catch (err) {
    console.warn('[daily-vip-claim] 查询账本流水失败:', err);
    return { totalSuccess: 0, savedMoney: 0, recentLogs: [] };
  }
};

// 任务中心 Handle（支持在宿主任务中心查看状态与手动重试）
// ---- 单飞锁：领取 + 升级共享同一 in-flight Promise，防止三处入口/自动任务并发重复请求 ----

let claimInFlight = null;

// 辅助发送主程序内部 API 请求（携带当前登录凭证）
const sendInternalApiRequest = async (ctx, { method = 'POST', url, data = {}, params = {} }) => {
  if (!ctx.electron?.api?.request) return null;
  let token = '';
  let userid = '';
  try {
    const kv = await ctx.electron.storage.getKv('pinia:user');
    token = kv?.info?.token || '';
    userid = kv?.info?.userid || '';
  } catch {}
  if (!token && ctx.pinia) {
    try {
      const store = ctx.pinia._s?.get('user');
      token = store?.info?.token || '';
      userid = store?.info?.userid || '';
    } catch {}
  }
  const headers = {};
  if (token) {
    headers['Authorization'] = `token=${token}${userid ? `;userid=${userid}` : ''}`;
    headers['Cookie'] = `token=${token}${userid ? `;userid=${userid}` : ''}`;
  }
  return await ctx.electron.api.request({
    method,
    url,
    data,
    params,
    headers,
  });
};

// 全能版任务：上报概念版广告打卡与听歌任务
const runConceptEditionTasks = async (ctx) => {
  let adSuccess = false;
  let listenSuccess = false;

  // 1. 概念版模拟广告打卡（获取 30s 广告奖励与成长值加成）
  try {
    const adRes = await sendInternalApiRequest(ctx, {
      method: 'POST',
      url: '/youth/vip',
    });
    if (adRes?.status === 200 || adRes?.body?.status === 1 || adRes?.body?.code === 0) {
      adSuccess = true;
    }
  } catch (e) {
    console.warn('[daily-vip-claim] 概念版广告打卡异常:', e);
  }

  // 2. 概念版听歌任务打卡上报
  try {
    const listenRes = await sendInternalApiRequest(ctx, {
      method: 'POST',
      url: '/youth/listen/song',
      data: { mixsongid: 666075191 },
    });
    if (listenRes?.status === 200 || listenRes?.body?.status === 1 || listenRes?.body?.code === 0) {
      listenSuccess = true;
    }
  } catch (e) {
    console.warn('[daily-vip-claim] 概念版听歌打卡异常:', e);
  }

  return adSuccess || listenSuccess;
};

const claimOnce = (ctx, progressCallback) => {
  if (claimInFlight) return claimInFlight;
  claimInFlight = (async () => {
    const t0 = Date.now();
    const today = formatClaimDate();
    let upgradeSuccess = false;
    let conceptTaskSuccess = false;
    let claimError = null;

    progressCallback?.('正在领取基础畅听会员...');
    try {
      await ctx.kugou.user.claimDayVip(today);
    } catch (err) {
      claimError = err;
      const errCode = Number(err?.response?.body?.error_code || err?.response?.body?.errcode);
      if (
        (errCode === 10008 || errCode === 10009 || errCode === 10010 || errCode === 20028) &&
        ctx.kugouVerification &&
        typeof ctx.kugouVerification.requestVerification === 'function'
      ) {
        try {
          ctx.toast?.info?.('检测到安全验证，正在调起验证...');
          await ctx.kugouVerification.requestVerification({
            scene: 'claim_vip',
            message: '领取每日畅听会员需进行安全验证',
          });
          await ctx.kugou.user.claimDayVip(today);
          claimError = null;
        } catch (verifyErr) {
          console.warn('[daily-vip-claim] 验证码验证失败:', verifyErr);
        }
      }
      if (claimError && !isClaim131001(claimError)) {
        const durationMs = Date.now() - t0;
        await recordClaimLedger({
          userId: userVipState.userId,
          claimDate: today,
          claimedAt: Date.now(),
          durationMs,
          status: 'failed',
          message: getApiErrorMessage(claimError, '领取失败'),
        });
        throw claimError;
      }
    }

    progressCallback?.('正在升级概念特权...');
    try {
      await ctx.kugou.user.upgradeDayVip();
      upgradeSuccess = true;
    } catch (upgradeError) {
      console.warn('[daily-vip-claim] 升级失败（非阻断）:', upgradeError);
    }

    progressCallback?.('正在同步概念版听歌打卡...');
    try {
      conceptTaskSuccess = await runConceptEditionTasks(ctx);
    } catch (conceptError) {
      console.warn('[daily-vip-claim] 概念打卡异常（非阻断）:', conceptError);
    }

    const durationMs = Date.now() - t0;
    const isAlreadyClaimed = Boolean(claimError && isClaim131001(claimError));
    const expiryText = formatExpiryText(readTvipEndTime(ctx));

    const messageParts = [];
    if (isAlreadyClaimed) {
      messageParts.push('今日已领畅听VIP');
    } else {
      messageParts.push(upgradeSuccess ? '畅听VIP领取并升级特权成功' : '畅听VIP领取成功');
    }
    if (conceptTaskSuccess) {
      messageParts.push('概念版任务已打卡');
    }

    await recordClaimLedger({
      userId: userVipState.userId,
      claimDate: today,
      claimedAt: Date.now(),
      expiryText,
      upgradeStatus: upgradeSuccess ? 1 : 0,
      conceptTaskStatus: conceptTaskSuccess ? 1 : 0,
      durationMs,
      status: 'success',
      message: messageParts.join('，'),
    });

    return {
      today,
      isAlreadyClaimed,
      upgradeSuccess,
      conceptTaskSuccess,
      durationMs,
    };
  })().finally(() => {
    claimInFlight = null;
  });
  return claimInFlight;
};

// ---- 当月记录（带 5 分钟缓存，卡片三处挂载与自动领取预判复用） ----

const MONTH_RECORD_TTL = 5 * 60 * 1000;
let monthRecordCache = { at: 0, value: [] };

const getMonthRecordsCached = async (ctx) => {
  if (Date.now() - monthRecordCache.at < MONTH_RECORD_TTL) {
    return monthRecordCache.value;
  }
  const res = await ctx.kugou.user.getVipMonthRecord();
  const records = normalizeVipRecords(res);
  monthRecordCache = { at: Date.now(), value: records };
  return records;
};

const isTodayClaimed = (records) => {
  const today = formatClaimDate();
  return (records ?? []).some((r) => r && r.date === today);
};

// 计算连续打卡天数（从今天或昨天往前推）
const calculateStreakDays = (records) => {
  if (!Array.isArray(records) || records.length === 0) return 0;
  const dates = new Set(records.map((r) => r && r.date).filter(Boolean));
  let streak = 0;
  const check = new Date();
  const todayStr = formatClaimDate(check);
  if (!dates.has(todayStr)) {
    check.setDate(check.getDate() - 1);
  }
  while (true) {
    const dStr = formatClaimDate(check);
    if (dates.has(dStr)) {
      streak += 1;
      check.setDate(check.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
};

// 防御式解析当月领取记录（响应结构随酷狗上游可能变化）
const normalizeVipRecords = (res) => {
  const body = (res ?? {});
  const data = body.data;
  const dataRecord =
    data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  const rawList =
    (Array.isArray(data) ? data : null) ||
    (Array.isArray(dataRecord?.records) ? dataRecord.records : null) ||
    (Array.isArray(dataRecord?.list) ? dataRecord.list : null) ||
    (Array.isArray(body.records) ? body.records : null) ||
    (Array.isArray(body.list) ? body.list : null);
  if (!Array.isArray(rawList)) return [];
  return rawList
    .map((item) => {
      const record =
        item && typeof item === 'object' ? item : null;
      if (!record) return null;
      const rawDate =
        record.receive_day ??
        record.receive_date ??
        record.day ??
        record.date ??
        record.create_time ??
        record.record_time ??
        '';
      let date = '';
      if (typeof rawDate === 'number') date = formatSecondsDate(rawDate);
      else if (typeof rawDate === 'string') date = rawDate.trim() || '';
      if (!date) return null;
      return { date, label: '已领取 1 天畅听会员' };
    })
    .filter((item) => item !== null);
};

// ---- VIP 到期读取（与 Profile 同源：读宿主 Pinia user store 的 busi_vip） ----

const readTvipEndTime = (ctx) => {
  try {
    const store = ctx.pinia && ctx.pinia._s && ctx.pinia._s.get('user');
    const busiVip =
      (store && store.info && store.info.extendsInfo && store.info.extendsInfo.vip && store.info.extendsInfo.vip.busi_vip) || [];
    const tvip = busiVip.find(
      (v) => v && v.product_type === 'tvip' && v.is_vip === 1,
    );
    return tvip ? tvip.vip_end_time : null;
  } catch {
    return null;
  }
};

// 到期时间 → 友好文案（天粒度）
const formatExpiryText = (value) => {
  if (!value) return '--';
  try {
    const time = typeof value === 'number' && value < 1e11 ? value * 1000 : Number(value) || value;
    const end = new Date(time);
    if (Number.isNaN(end.getTime())) return '--';
    const diffDays = Math.ceil((end.getTime() - Date.now()) / 86400000);
    if (diffDays <= 0) return '已过期';
    return `剩余 ${diffDays} 天`;
  } catch {
    return '--';
  }
};

// 免请求的登录预检：读宿主持久化的用户 store（KV key: pinia:user）。
// 返回 null 表示未知（读取失败）→ 直接尝试领取，靠错误映射兜底。
const isLoggedInCached = async (ctx) => {
  try {
    const kv = await ctx.electron.storage.getKv('pinia:user');
    return Boolean(
      kv && (kv.isLoggedIn === true || (kv.info && kv.info.token)),
    );
  } catch {
    return null;
  }
};

// best-effort 刷新宿主用户 store，让个人中心 VIP 徽章即时更新。
// ctx.pinia 是宿主共享的 Pinia 实例；_s 为 Pinia 内部活跃 store 映射，
// 防御式访问，失败无影响（个人中心挂载时自己会重新拉取）。
const refreshUserInfoBestEffort = (ctx) => {
  try {
    const store = ctx.pinia && ctx.pinia._s && ctx.pinia._s.get('user');
    if (store && typeof store.fetchUserInfo === 'function') {
      void Promise.resolve(store.fetchUserInfo()).catch(() => {});
    }
  } catch {
    // 非阻塞，忽略
  }
};

// 用 iconify 数据对象直接渲染内联 SVG（宿主全局 Icon 组件只在宿主渲染树
// 内可解析；自建迷你 app 中不可用，统一走此路径，两种上下文都安全）
const iconSvg = (h, iconData, { size = 18, className = '' } = {}) =>
  h('svg', {
    xmlns: 'http://www.w3.org/2000/svg',
    width: size,
    height: size,
    viewBox: `0 0 ${iconData?.width || 24} ${iconData?.height || 24}`,
    class: className,
    'aria-hidden': 'true',
    innerHTML: iconData?.body ?? '',
  });

// ---- 任务中心调度管理（生命周期守护器：动态创建、快速自动销毁、避免常驻残留） ----

let taskHandle = null;

const startClaimTask = (ctx, patch = {}) => {
  if (!ctx.tasks || typeof ctx.tasks.register !== 'function') return null;
  if (taskHandle) {
    try {
      taskHandle.dismiss();
    } catch {}
    taskHandle = null;
  }
  try {
    taskHandle = ctx.tasks.register({
      id: 'daily-vip-claim-task',
      name: '每日畅听会员全套打卡',
      icon: ctx.icons?.iconGift || {
        width: 24,
        height: 24,
        body: '<path fill="currentColor" d="M20 12v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-9H2V7a1 1 0 0 1 1-1h4.17a3 3 0 0 1 5.66-1.41A3 3 0 0 1 16.83 6H21a1 1 0 0 1 1 1v5h-2zm-2 2H6v6h12v-6zm2-6H4v2h16V8z"/>',
      },
      status: 'running',
      retention: {
        completed: { mode: 'auto', delayMs: 3500 },
        error: { mode: 'auto', delayMs: 5000 },
        aborted: { mode: 'auto', delayMs: 3000 },
      },
      progress: patch.progress || { label: '正在执行打卡...' },
      actions: [
        {
          id: 'dismiss_now',
          label: '完成',
          variant: 'ghost',
          onClick: () => {
            try {
              taskHandle?.dismiss();
            } catch {}
          },
        },
      ],
      ...patch,
    });
  } catch (err) {
    console.warn('[daily-vip-claim] 注册任务中心失败:', err);
  }
  return taskHandle;
};


// ---- 标题栏与底栏双快捷入口管理 (支持 beta.9 playerbar API) ----

let unregisterTitlebar = null;
let unregisterPlayerbar = null;
let playerbarBadgeText = "";
let playerbarTooltipText = "畅听VIP · 每日自动续期与到期流水 (点击查看账本)";
let playerbarClaimedToday = false;

const updateBadges = async (ctx) => {
  try {
    const ok = await isLoggedInCached(ctx);
    let title = "畅听VIP";
    let tooltip = "畅听VIP · 每日自动续期与到期流水 (点击查看账本)";
    let pBadge = "";
    let isClaimed = false;

    if (ok === false) {
      title = "畅听VIP · 未登录";
      pBadge = "未登录";
      tooltip = "未登录酷狗账号，点击打开流水账本或去登录";
    } else {
      const uid = readUserId(ctx);
      let endTime = readTvipEndTime(ctx);
      if (!endTime && uid) {
        endTime = await fetchConceptUnionVipInfo(ctx, uid);
        if (endTime) userVipState.tvipEndTime = endTime;
      }
      const expiryText = formatExpiryText(endTime);
      const [records, ledger] = await Promise.all([
        getMonthRecordsCached(ctx).catch(() => []),
        getLedgerStats(uid),
      ]);
      const streak = calculateStreakDays(records);
      const claimedToday = isTodayClaimed(records);
      isClaimed = claimedToday;
      const totalDays = ledger.totalSuccess || 0;
      const saved = ledger.savedMoney || 0;

      if (expiryText === "已过期") {
        title = "畅听VIP · 已过期";
        pBadge = "已过期";
      } else if (expiryText !== "--") {
        title = claimedToday ? `✓ 畅听VIP · ${expiryText}` : `畅听VIP · ${expiryText}`;
        pBadge = claimedToday ? `✓ ${expiryText}` : expiryText;
      }

      tooltip = `畅听VIP · 到期: ${expiryText} · 连续打卡: ${streak}天 · 累计打卡: ${totalDays}天 (省¥${saved}) · 点击查看账本`;
    }

    playerbarBadgeText = pBadge;
    playerbarTooltipText = tooltip;
    playerbarClaimedToday = isClaimed;

    // 1. 标题栏直达徽章
    if (ctx.ui?.titlebar && typeof ctx.ui.titlebar.register === "function") {
      try {
        if (unregisterTitlebar) unregisterTitlebar();
      } catch {}
      unregisterTitlebar = ctx.ui.titlebar.register({
        id: "daily-vip-badge",
        title,
        icon: ctx.icons?.iconGift || {
          width: 24,
          height: 24,
          body: "<path fill=\"currentColor\" d=\"M20 12v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-9H2V7a1 1 0 0 1 1-1h4.17a3 3 0 0 1 5.66-1.41A3 3 0 0 1 16.83 6H21a1 1 0 0 1 1 1v5h-2zm-2 2H6v6h12v-6zm2-6H4v2h16V8z\"/>",
        },
        tooltip,
        defaultPlacement: "toolbar",
        order: 25,
        onClick: () => {
          void ledgerModalState.open?.();
        },
      });
    }

    // 2. 底栏 Playerbar 快捷胶囊 (EchoMusic beta.9 新增 API)
    if (ctx.ui?.playerbar && typeof ctx.ui.playerbar.register === "function") {
      const showInPlayerbar = Boolean(await ctx.storage.get("playerbarBadge") ?? true);
      if (showInPlayerbar) {
        try {
          if (unregisterPlayerbar) unregisterPlayerbar();
        } catch {}
        unregisterPlayerbar = ctx.ui.playerbar.register({
          id: "daily-vip-claim-playerbar",
          title: "畅听VIP",
          icon: ctx.icons?.iconGift || {
            width: 24,
            height: 24,
            body: "<path fill=\"currentColor\" d=\"M20 12v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-9H2V7a1 1 0 0 1 1-1h4.17a3 3 0 0 1 5.66-1.41A3 3 0 0 1 16.83 6H21a1 1 0 0 1 1 1v5h-2zm-2 2H6v6h12v-6zm2-6H4v2h16V8z\"/>",
          },
          tooltip,
          badge: () => playerbarBadgeText || null,
          badgeTitle: "畅听VIP",
          badgeDefaultVisible: true,
          defaultPlacement: "right",
          order: 950,
          onClick: async () => {
            if (!playerbarClaimedToday) {
              await maybeAutoClaim(ctx, true);
            } else {
              void ledgerModalState.open?.();
            }
          },
        });
      }
    }
  } catch (err) {
    console.warn("[daily-vip-claim] 刷新徽章状态异常:", err);
  }
};

const updateTitlebarBadge = updateBadges;

// ---- 领取卡片共享状态/动作 ----
// onAfterClaim：领取成功后回调（卡片用它刷新到期/统计状态）
const createClaimState = (ctx, onAfterClaim) => {
  const { ref } = ctx.vue;

  const isClaiming = ref(false);
  const isLoadingRecords = ref(false);
  const showRecords = ref(false);
  const records = ref([]);

  const loadRecords = async () => {
    if (isLoadingRecords.value) return;
    isLoadingRecords.value = true;
    try {
      records.value = await getMonthRecordsCached(ctx);
      showRecords.value = true;
      if (records.value.length === 0) {
        ctx.toast.info('本月暂无领取记录');
      }
    } catch (error) {
      console.warn('[daily-vip-claim] 加载领取记录失败:', error);
      ctx.toast.danger(getApiErrorMessage(error, '加载领取记录失败'));
    } finally {
      isLoadingRecords.value = false;
    }
  };

  const toggleRecords = async () => {
    if (showRecords.value) {
      showRecords.value = false;
      return;
    }
    await loadRecords();
  };

  const handleClaim = async () => {
    if (isClaiming.value) return;
    const ok = await isLoggedInCached(ctx);
    if (ok === false) {
      ctx.toast.info('请先登录后再领取每日畅听会员');
      return;
    }
    isClaiming.value = true;
    const runTask = ensureTaskRun(ctx, 'running', { progress: { label: '正在执行打卡...' } });
    try {
      await claimOnce(ctx, (stepLabel) => {
        runTask?.update?.({ progress: { label: stepLabel } });
      });
      ctx.toast.show('已成功领取 1 天畅听会员并完成打卡', 'success', 4000, {
        label: '查看记录',
        handler: () => loadRecords(),
      });
      refreshUserInfoBestEffort(ctx);
      runTask?.finish?.('completed', { progress: { label: '今日全套VIP续期与打卡已完成' } });
      void updateTitlebarBadge(ctx);
      if (onAfterClaim) onAfterClaim();
      if (showRecords.value) await loadRecords();
    } catch (error) {
      console.warn('[daily-vip-claim] 领取失败:', error);
      const errMsg = getApiErrorMessage(error, '领取每日畅听会员失败');
      ctx.toast.danger(errMsg);
      runTask?.finish?.('error', { error: errMsg });
      void updateTitlebarBadge(ctx);
    } finally {
      isClaiming.value = false;
    }
  };

  return {
    isClaiming,
    isLoadingRecords,
    showRecords,
    records,
    loadRecords,
    toggleRecords,
    handleClaim,
  };
};

// ---- 自动打卡（幂等）：启动 5s / 系统唤醒 / 每小时 各检查一次 ----
const maybeAutoClaim = async (ctx, manual = false) => {
  const ok = await isLoggedInCached(ctx);
  if (ok === false) {
    console.info('[daily-vip-claim] 自动打卡跳过：未登录');
    void updateTitlebarBadge(ctx);
    if (manual) ctx.toast?.info?.('请先登录后再进行打卡');
    return;
  }
  // 预判今日已领（非手动强制执行时）
  if (!manual) {
    try {
      const records = await getMonthRecordsCached(ctx);
      if (isTodayClaimed(records)) {
        console.info('[daily-vip-claim] 自动打卡跳过：今日已领取');
        void updateTitlebarBadge(ctx);
        return;
      }
    } catch (error) {
      console.warn('[daily-vip-claim] 预检领取记录失败，尝试直接打卡:', error);
    }
  }
  const runTask = startClaimTask(ctx, { progress: { label: '正在执行每日全套打卡...' } });
  for (let attempt = 0; attempt <= 1; attempt += 1) {
    try {
      await claimOnce(ctx, (stepLabel) => {
        runTask?.update?.({ progress: { label: stepLabel } });
      });
      ctx.toast.success('已成功完成每日畅听VIP与任务打卡！');
      refreshUserInfoBestEffort(ctx);
      runTask?.finish?.('completed', { progress: { label: '今日全套VIP续期与打卡已完成' } });
      void updateTitlebarBadge(ctx);
      return;
    } catch (error) {
      if (isClaim131001(error)) {
        console.info('[daily-vip-claim] 自动打卡提示：今日已领取');
        runTask?.finish?.('completed', { progress: { label: '今日已领取，明天再来' } });
        void updateTitlebarBadge(ctx);
        if (manual) ctx.toast?.info?.('今日已领取，明天再来');
        return;
      }
      if (attempt === 1 || manual) {
        console.warn('[daily-vip-claim] 打卡失败:', error);
        const errMsg = getApiErrorMessage(error, '每日畅听VIP打卡失败');
        ctx.toast.danger(errMsg);
        runTask?.finish?.('error', { error: errMsg });
        void updateTitlebarBadge(ctx);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
};

// ---- 样式（插件 CSS 全局生效，严格 .dvp- 前缀，仅用宿主 CSS 变量） ----

const CSS = `
.dvp-root {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.dvp-page {
  display: flex;
  flex-direction: column;
  padding: 0 32px 32px;
}

.dvp-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 20px 0 24px;
}

.dvp-header-icon {
  color: var(--color-primary, #00cc65);
  flex-shrink: 0;
}

.dvp-title {
  margin: 0;
  font-size: 20px;
  font-weight: 800;
  letter-spacing: -0.01em;
  color: var(--text-main, #ffffff);
}

/* 嵌入式领取卡片 (与 Profile.vue 会员卡同层级风格) */
.dvp-card {
  border: 1px solid var(--border-light, #444446);
  border-radius: 16px;
  background: var(--surface-card-base, #343436);
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  box-shadow: var(--shadow-card, none);
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}

.dvp-card-inline {
  border: 1px solid var(--border-light, #444446);
  border-radius: 16px;
  background: var(--surface-card-base, #343436);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 10px;
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}

.dvp-card-inline:hover, .dvp-card:hover {
  border-color: color-mix(in srgb, var(--color-primary, #00cc65) 30%, var(--border-light, #444446));
}

.dvp-claim-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.dvp-claim-copy {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.dvp-claim-icon {
  width: 38px;
  height: 38px;
  border-radius: 10px;
  background: color-mix(in srgb, var(--color-primary, #00cc65) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-primary, #00cc65) 24%, transparent);
  color: var(--color-primary, #00cc65);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.dvp-claim-icon-sm {
  width: 32px;
  height: 32px;
  border-radius: 8px;
}

.dvp-claim-title {
  margin: 0;
  font-size: 14px;
  font-weight: 750;
  color: var(--text-main, #ffffff);
}

.dvp-status {
  font-size: 12px;
  color: var(--text-secondary, #bcbcbc);
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.dvp-muted {
  margin: 0;
  font-size: 11.5px;
  color: var(--text-secondary, #bcbcbc);
}

/* 记录抽屉 */
.dvp-records-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 8px;
  border-top: 1px solid var(--border-light, #444446);
  font-size: 11.5px;
}

.dvp-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: none;
  border: none;
  color: var(--text-secondary, #bcbcbc);
  font-size: 11.5px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  transition: all 0.15s;
}

.dvp-toggle:hover:not(:disabled) {
  color: var(--text-main, #ffffff);
  background: var(--bg-elevated, rgba(255, 255, 255, 0.06));
}

.dvp-records-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 160px;
  overflow-y: auto;
  padding-right: 4px;
}

.dvp-records-list::-webkit-scrollbar {
  width: 4px;
}

.dvp-records-list::-webkit-scrollbar-thumb {
  background: var(--border-light, #444446);
  border-radius: 999px;
}

.dvp-record {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border-radius: 8px;
  background: var(--bg-elevated, rgba(255, 255, 255, 0.03));
  border: 1px solid var(--border-light, #444446);
  font-size: 11.5px;
}

.dvp-record-date {
  color: var(--text-main, #ffffff);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.dvp-record-label {
  color: var(--color-primary, #00cc65);
  font-weight: 700;
}

.dvp-records-empty {
  font-size: 11.5px;
  color: var(--text-secondary, #bcbcbc);
  text-align: center;
  padding: 16px 8px;
}

/* 账本全景弹窗 (100% 对齐 EchoMusic 原生 Dialog.vue 标准) */
.dvp-modal-mask {
  position: fixed;
  inset: 0;
  background: var(--surface-overlay-bg, rgba(0, 0, 0, 0.45));
  backdrop-filter: blur(8px);
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.dvp-modal {
  width: 520px;
  max-width: 94vw;
  max-height: 86vh;
  background: var(--bg-dialog, #29292b);
  border: 1px solid var(--border-light, #444446);
  border-radius: 16px;
  box-shadow: var(--shadow-dialog, 0 24px 60px rgba(0, 0, 0, 0.42));
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: var(--text-main, #ffffff);
  animation: dvp-modal-scale-in 0.18s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes dvp-modal-scale-in {
  from { opacity: 0; transform: scale(0.96); }
  to { opacity: 1; transform: scale(1); }
}

.dvp-modal-header {
  padding: 16px 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--border-light, #444446);
  background: var(--bg-dialog, #29292b);
  flex-shrink: 0;
}

.dvp-modal-title-box {
  display: flex;
  align-items: center;
  gap: 10px;
}

.dvp-modal-icon-wrap {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--color-primary, #00cc65) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--color-primary, #00cc65) 24%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-primary, #00cc65);
}

.dvp-modal-titles {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.dvp-modal-title {
  font-size: 15px;
  font-weight: 750;
  color: var(--text-main, #ffffff);
  line-height: 1.25;
}

.dvp-modal-subtitle {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-secondary, #bcbcbc);
}

.dvp-modal-close {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--text-secondary, #bcbcbc);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease;
}

.dvp-modal-close:hover {
  background: var(--bg-elevated, rgba(255, 255, 255, 0.08));
  color: var(--text-main, #ffffff);
}

.dvp-modal-body {
  padding: 18px 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.dvp-modal-body::-webkit-scrollbar {
  width: 5px;
}

.dvp-modal-body::-webkit-scrollbar-thumb {
  background: var(--border-light, #444446);
  border-radius: 999px;
}

/* 顶部三大统计卡片 (完全契合 EchoMusic 卡片规范) */
.dvp-stats-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}

.dvp-stat-card {
  border: 1px solid var(--border-light, #444446);
  border-radius: 12px;
  padding: 12px 14px;
  background: var(--surface-card-base, #343436);
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 2px;
  transition: all 0.18s ease;
}

.dvp-stat-card:hover {
  border-color: color-mix(in srgb, var(--color-primary, #00cc65) 30%, var(--border-light, #444446));
}

.dvp-stat-top {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-weight: 650;
  color: var(--text-secondary, #bcbcbc);
}

.dvp-stat-value {
  font-size: 22px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}

.stat-claim .dvp-stat-value { color: var(--color-primary, #00cc65); }
.stat-streak .dvp-stat-value { color: #f59e0b; }
.stat-save .dvp-stat-value { color: #fbbf24; }

.dvp-stat-sub {
  font-size: 10px;
  font-weight: 500;
  color: var(--text-secondary, #bcbcbc);
  opacity: 0.8;
}

/* 状态胶囊条 */
.dvp-status-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 12px;
  border-radius: 10px;
  background: var(--bg-elevated, #29292b);
  border: 1px solid var(--border-light, #444446);
  font-size: 12px;
}

.dvp-status-left {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 700;
  color: var(--text-main, #ffffff);
}

.dvp-status-user {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 6px;
  background: var(--surface-card-base, #343436);
  color: var(--text-secondary, #bcbcbc);
  border: 1px solid var(--border-light, #444446);
}

/* 流水标题栏 */
.dvp-ledger-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  font-weight: 750;
  color: var(--text-main, #ffffff);
  margin-top: 2px;
}

.dvp-btn-refresh {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 6px;
  background: var(--surface-card-base, #343436);
  border: 1px solid var(--border-light, #444446);
  color: var(--text-secondary, #bcbcbc);
  font-size: 11px;
  font-weight: 650;
  cursor: pointer;
  transition: all 0.15s ease;
}

.dvp-btn-refresh:hover:not(:disabled) {
  border-color: var(--color-primary, #00cc65);
  color: var(--color-primary, #00cc65);
}

/* 流水明细列表 */
.dvp-ledger-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 220px;
  overflow-y: auto;
  padding-right: 2px;
}

.dvp-ledger-list::-webkit-scrollbar {
  width: 4px;
}

.dvp-ledger-list::-webkit-scrollbar-thumb {
  background: var(--border-light, #444446);
  border-radius: 999px;
}

.dvp-ledger-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--surface-card-base, #343436);
  border-radius: 9px;
  border: 1px solid var(--border-light, #444446);
  transition: background 0.12s ease;
}

.dvp-ledger-item:hover {
  background: var(--bg-elevated, #29292b);
}

.dvp-ledger-item-left {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.dvp-ledger-date {
  font-size: 12px;
  font-weight: 700;
  color: var(--text-main, #ffffff);
  font-variant-numeric: tabular-nums;
}

.dvp-ledger-time {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-secondary, #bcbcbc);
}

.dvp-ledger-item-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.dvp-badge-ms {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-secondary, #bcbcbc);
  font-variant-numeric: tabular-nums;
}

.dvp-badge-concept {
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 4px;
  background: color-mix(in srgb, #0ea5e9 14%, transparent);
  color: #0ea5e9;
  border: 1px solid color-mix(in srgb, #0ea5e9 24%, transparent);
}

.dvp-badge-success {
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--color-primary, #00cc65) 14%, transparent);
  color: var(--color-primary, #00cc65);
  border: 1px solid color-mix(in srgb, var(--color-primary, #00cc65) 24%, transparent);
}

.dvp-badge-failed {
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 4px;
  background: color-mix(in srgb, #ef4444 14%, transparent);
  color: #ef4444;
  border: 1px solid color-mix(in srgb, #ef4444 24%, transparent);
}

/* 底部操作区 (标准 EchoMusic 弹窗按钮组) */
.dvp-modal-footer {
  padding: 14px 20px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  border-top: 1px solid var(--border-light, #444446);
  background: var(--bg-dialog, #29292b);
  flex-shrink: 0;
}

.dvp-btn-ghost {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border-light, #444446);
  background: transparent;
  color: var(--text-secondary, #bcbcbc);
  border-radius: 8px;
  padding: 6px 14px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}

.dvp-btn-ghost:hover {
  background: var(--bg-elevated, rgba(255, 255, 255, 0.08));
  color: var(--text-main, #ffffff);
}

.dvp-btn-claim-all {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border: none;
  background: var(--color-primary, #00cc65);
  color: var(--color-on-primary, #000000);
  border-radius: 8px;
  padding: 6px 16px;
  font-size: 12px;
  font-weight: 750;
  cursor: pointer;
  transition: all 0.15s ease;
  box-shadow: 0 2px 6px color-mix(in srgb, var(--color-primary, #00cc65) 25%, transparent);
}

.dvp-btn-claim-all:hover:not(:disabled) {
  filter: brightness(1.08);
  transform: translateY(-1px);
}

.dvp-btn-claim-all:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.dvp-logged-out {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  border: 1px solid var(--border-light, #444446);
  border-radius: 16px;
  background: var(--surface-card-base, #343436);
  padding: 48px 24px;
  color: var(--text-secondary, #bcbcbc);
}

.dvp-logged-out p {
  margin: 0;
  font-size: 13px;
  font-weight: 650;
}

/* 插件设置面板 */
.dvp-settings {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.dvp-setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--surface-card-base, #343436);
  border: 1px solid var(--border-light, #444446);
}

.dvp-setting-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.dvp-setting-label {
  font-size: 13px;
  font-weight: 750;
  color: var(--text-main, #ffffff);
}

.dvp-setting-hint {
  font-size: 11.5px;
  font-weight: 500;
  color: var(--text-secondary, #bcbcbc);
}

.dvp-spin {
  animation: dvp-spin 0.9s linear infinite;
  transform-origin: center;
  transform-box: fill-box;
}

@keyframes dvp-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
`;

// ---- 共享组件 ----

// ---- 全局账本弹窗控制器 ----
const ledgerModalState = {
  open: null,
  close: null,
};

const createLedgerModal = (ctx, Button) => {
  const { h, defineComponent, ref } = ctx.vue;

  return defineComponent({
    name: 'daily-vip-ledger-modal',
    setup() {
      const visible = ref(false);
      const loading = ref(false);
      const stats = ref({ totalSuccess: 0, savedMoney: 0, recentLogs: [] });
      const streakDays = ref(0);
      const vipExpiry = ref('--');

      const refresh = async () => {
        loading.value = true;
        try {
          const uid = readUserId(ctx);
          vipExpiry.value = formatExpiryText(readTvipEndTime(ctx));
          const [s, recs] = await Promise.all([
            getLedgerStats(uid),
            getMonthRecordsCached(ctx).catch(() => []),
          ]);
          stats.value = s;
          streakDays.value = calculateStreakDays(recs);
          // 冷启动自动回填：若账本记录为空，从当月已领记录一键恢复
          if (stats.value.totalSuccess === 0 && recs && recs.length > 0) {
            await backfillLedgerFromMonthRecords(ctx, uid);
            stats.value = await getLedgerStats(uid);
          }
        } catch (err) {
          console.warn('[daily-vip-claim] 刷新账本失败:', err);
        } finally {
          loading.value = false;
        }
      };

      ledgerModalState.open = async () => {
        visible.value = true;
        await refresh();
      };
      ledgerModalState.close = () => {
        visible.value = false;
      };

      const handleClaimFromModal = async () => {
        loading.value = true;
        try {
          await maybeAutoClaim(ctx, true);
          refreshUserInfoBestEffort(ctx);
          await refresh();
        } catch (err) {
          ctx.toast.danger(getApiErrorMessage(err, '打卡失败'));
        } finally {
          loading.value = false;
        }
      };

      return () => {
        if (!visible.value) return null;
        return h('div', { class: 'dvp-modal-mask', onClick: () => { visible.value = false; } }, [
          h(
            'div',
            { class: 'dvp-modal', onClick: (e) => e.stopPropagation() },
            [
              // Header
              h('div', { class: 'dvp-modal-header' }, [
                h('div', { class: 'dvp-modal-title-box' }, [
                  h('div', { class: 'dvp-modal-icon-wrap' }, [
                    iconSvg(h, ctx.icons.iconGift, { size: 20 }),
                  ]),
                  h('div', { class: 'dvp-modal-titles' }, [
                    h('div', { class: 'dvp-modal-title' }, '畅听VIP · 专属打卡流水账本'),
                    h('div', { class: 'dvp-modal-subtitle' }, '每日白嫖自动续期 · SQLite 本地只读隐私账本'),
                  ]),
                ]),
                h(
                  'button',
                  { class: 'dvp-modal-close', title: '关闭', onClick: () => { visible.value = false; } },
                  '✕',
                ),
              ]),
              // Body
              h('div', { class: 'dvp-modal-body' }, [
                // 3 个三色美化统计大卡片
                h('div', { class: 'dvp-stats-grid' }, [
                  h('div', { class: 'dvp-stat-card stat-claim' }, [
                    h('div', { class: 'dvp-stat-top' }, [
                      h('span', null, '🎁'),
                      h('span', null, '累计打卡'),
                    ]),
                    h('div', { class: 'dvp-stat-value' }, `${stats.value.totalSuccess} 天`),
                    h('div', { class: 'dvp-stat-sub' }, '已累计免费续期'),
                  ]),
                  h('div', { class: 'dvp-stat-card stat-streak' }, [
                    h('div', { class: 'dvp-stat-top' }, [
                      h('span', null, '🔥'),
                      h('span', null, '连续签到'),
                    ]),
                    h('div', { class: 'dvp-stat-value' }, `${streakDays.value} 天`),
                    h('div', { class: 'dvp-stat-sub' }, '保持打卡不中断'),
                  ]),
                  h('div', { class: 'dvp-stat-card stat-save' }, [
                    h('div', { class: 'dvp-stat-top' }, [
                      h('span', null, '💰'),
                      h('span', null, '累计节省约'),
                    ]),
                    h('div', { class: 'dvp-stat-value' }, `¥${stats.value.savedMoney}`),
                    h('div', { class: 'dvp-stat-sub' }, '折合会员费估算'),
                  ]),
                ]),
                // 状态胶囊条
                h('div', { class: 'dvp-status-strip' }, [
                  h('div', { class: 'dvp-status-left' }, [
                    h('span', null, '👑'),
                    h('span', null, `畅听 VIP · ${vipExpiry.value}`),
                  ]),
                  h('div', { class: 'dvp-status-user' }, `用户: ${readUserId(ctx) || '当前账号'}`),
                ]),
                // 最近流水标题 + 刷新
                h('div', { class: 'dvp-ledger-title' }, [
                  h('span', null, '打卡明细流水 (SQLite 本地账本)'),
                  h(
                    'button',
                    {
                      class: 'dvp-btn-refresh',
                      disabled: loading.value,
                      onClick: refresh,
                    },
                    [
                      iconSvg(h, ctx.icons.iconRefreshCw, {
                        size: 12,
                        className: loading.value ? 'dvp-spin' : '',
                      }),
                      '刷新',
                    ],
                  ),
                ]),
                // 流水明细列表
                h('div', { class: 'dvp-ledger-list' }, [
                  stats.value.recentLogs.length === 0
                    ? h('div', { class: 'dvp-records-empty' }, [
                        iconSvg(h, ctx.icons.iconGift, { size: 28, className: 'dvp-muted' }),
                        h('p', { style: 'margin: 6px 0 0;' }, '暂无打卡流水记录，点击下方按钮立即打卡记账'),
                      ])
                    : stats.value.recentLogs.map((log) =>
                        h('div', { class: 'dvp-ledger-item', key: log.id || log.claimed_at }, [
                          h('div', { class: 'dvp-ledger-item-left' }, [
                            h('div', { class: 'dvp-ledger-date' }, log.claim_date || ''),
                            h(
                              'div',
                              { class: 'dvp-ledger-time' },
                              `${new Date(Number(log.claimed_at)).toLocaleTimeString('zh-CN', { hour12: false })} · ${log.message || '已领取'}`,
                            ),
                          ]),
                          h('div', { class: 'dvp-ledger-item-right' }, [
                            log.duration_ms ? h('span', { class: 'dvp-badge-ms' }, `${log.duration_ms}ms`) : null,
                            log.concept_task_status
                              ? h('span', { class: 'dvp-badge-concept' }, '概念已打卡')
                              : null,
                            h(
                              'span',
                              {
                                class: log.status === 'success' ? 'dvp-badge-success' : 'dvp-badge-failed',
                              },
                              log.upgrade_status ? '已升级' : (log.status === 'success' ? '畅听已领' : '打卡失败'),
                            ),
                          ]),
                        ]),
                      ),
                ]),
              ]),
              // Footer
              h('div', { class: 'dvp-modal-footer' }, [
                h(
                  'button',
                  {
                    class: 'dvp-btn-ghost',
                    onClick: () => { visible.value = false; },
                  },
                  '关闭',
                ),
                h(
                  'button',
                  {
                    class: 'dvp-btn-claim-all',
                    disabled: loading.value,
                    onClick: handleClaimFromModal,
                  },
                  [
                    iconSvg(h, ctx.icons.iconSparkles || ctx.icons.iconGift, { size: 14 }),
                    loading.value ? '打卡处理中...' : '立即全套打卡',
                  ],
                ),
              ]),
            ],
          ),
        ]);
      };
    },
  });
};

// 领取卡片（variant: 'card' 独立卡片样式 | 'inline' 贴会员状态卡样式）
// 不依赖宿主全局 Icon（自建迷你 app 中不可解析），统一用内联 SVG。
const createClaimCard = (ctx, Button) => {
  const { h, defineComponent, ref, onMounted } = ctx.vue;

  const renderRecords = (state) => [
    h('div', { class: 'dvp-records-head' }, [
      h('span', { class: 'dvp-muted' }, '当月领取记录'),
      h(
        'button',
        {
          class: 'dvp-toggle',
          disabled: state.isLoadingRecords.value,
          onClick: state.toggleRecords,
        },
        [
          iconSvg(h, ctx.icons.iconRefreshCw, {
            size: 12,
            className: state.isLoadingRecords.value ? 'dvp-spin' : '',
          }),
          state.showRecords.value ? '收起' : '查看',
        ],
      ),
    ]),
    state.showRecords.value
      ? h('div', { class: 'dvp-records-list' }, [
          state.records.value.length === 0
            ? h('div', { class: 'dvp-records-empty' }, '本月暂无领取记录')
            : state.records.value.map((record, index) =>
                h(
                  'div',
                  { class: 'dvp-record', key: `${record.date}-${index}` },
                  [
                    h('span', { class: 'dvp-record-date' }, record.date),
                    h('span', { class: 'dvp-record-label' }, record.label),
                  ],
                ),
              ),
        ])
      : null,
  ];

  return defineComponent({
    name: 'daily-vip-claim-card',
    props: {
      variant: { type: String, default: 'card' },
    },
    setup(props) {
      const loggedIn = ref(null); // null = 检查中/未知，true/false = 已确认
      const vipExpiry = ref('--');
      const monthCount = ref(null);
      const claimedToday = ref(false);
      const streakDays = ref(0);
      const savedMoney = ref(0);

      const refreshStatus = async () => {
        vipExpiry.value = formatExpiryText(readTvipEndTime(ctx));
        try {
          const [records, ledger] = await Promise.all([
            getMonthRecordsCached(ctx),
            getLedgerStats(userVipState.userId),
          ]);
          monthCount.value = records.length;
          claimedToday.value = isTodayClaimed(records);
          streakDays.value = calculateStreakDays(records);
          savedMoney.value = ledger.savedMoney || 0;
        } catch (error) {
          console.warn('[daily-vip-claim] 读取领取统计失败:', error);
          monthCount.value = null;
        }
      };

      const state = createClaimState(ctx, () => {
        // 领取成功后延迟刷新状态（等宿主 store 拉新 VIP 到期时间）
        setTimeout(refreshStatus, 1000);
      });

      onMounted(async () => {
        loggedIn.value = await isLoggedInCached(ctx);
        if (loggedIn.value !== false) await refreshStatus();
      });

      const statusParts = () => {
        const parts = [`畅听 VIP · ${vipExpiry.value}`];
        if (monthCount.value != null) parts.push(`本月已领 ${monthCount.value} 天`);
        if (streakDays.value > 0) parts.push(`连续打卡 ${streakDays.value} 天`);
        if (savedMoney.value > 0) parts.push(`累计省约 ¥${savedMoney.value}`);
        if (claimedToday.value) parts.push('今日已领取');
        return parts.join(' · ');
      };

      return () =>
        h(
          'div',
          { class: props.variant === 'inline' ? 'dvp-card-inline' : 'dvp-card' },
          [
            h('div', { class: 'dvp-claim-row' }, [
              h('div', { class: 'dvp-claim-copy' }, [
                h('div', { class: 'dvp-claim-icon dvp-claim-icon-sm' }, [
                  iconSvg(h, ctx.icons.iconGift, { size: 16 }),
                ]),
                h('div', null, [
                  h('h4', { class: 'dvp-claim-title' }, '每日畅听会员'),
                  h(
                    'p',
                    { class: 'dvp-muted' },
                    loggedIn.value === false
                      ? '登录后可领取'
                      : '每日可领取 1 天畅听会员',
                  ),
                ]),
              ]),
              loggedIn.value === false
                ? h(
                    Button,
                    {
                      variant: 'outline',
                      size: 'xs',
                      onClick: () => ctx.router.push('/login'),
                    },
                    { default: () => '去登录' },
                  )
                : h('div', { style: 'display: flex; gap: 6px; align-items: center;' }, [
                    h(
                      Button,
                      {
                        variant: 'ghost',
                        size: 'xs',
                        onClick: () => { void ledgerModalState.open?.(); },
                      },
                      { default: () => '账本' },
                    ),
                    h(
                      Button,
                      {
                        variant: 'outline',
                        size: 'xs',
                        loading: state.isClaiming.value,
                        onClick: state.handleClaim,
                      },
                      { default: () => (state.isClaiming.value ? '领取中' : '领取 1 天') },
                    ),
                  ]),
            ]),
            loggedIn.value !== false ? h('div', { class: 'dvp-status' }, statusParts()) : null,
            ...renderRecords(state),
          ],
        );
    },
  });
};

// ---- 个人中心注入（自愈式） ----
// 宿主 Vue 重渲染会抹掉不在 vnode 列表里的 DOM（注入容器），
// ctx.ui.mount 的 disposer 由运行时自动注册、无法单独收回，
// 因此这里自建迷你 app + MutationObserver 检测容器丢失后重挂，
// 保证卡片长期稳定存在于「会员状态」下方。

const injectProfileClaim = (ctx, ClaimCard) => {
  const MOUNT_ID = 'daily-vip-claim-profile';

  let current = null; // { dispose }
  let observer = null;
  let timer = null;

  const disposeCurrent = () => {
    if (!current) return;
    try {
      current.dispose();
    } catch (error) {
      console.warn('[daily-vip-claim] 清理注入组件失败:', error);
    }
    current = null;
  };

  const isAnchor = (el) => {
    // 会员状态容器：.profile-page 内、直接父级为 md:col-span-2、
    // 含 rounded-2xl 会员卡子元素，且当前可见
    if (!el.isConnected || el.offsetParent === null) return false;
    if (!el.classList.contains('space-y-2')) return false;
    if (!el.closest('.profile-page')) return false;
    const parent = el.parentElement;
    if (!parent || !parent.classList.contains('md:col-span-2')) return false;
    return el.querySelector(':scope > div.rounded-2xl') != null;
  };

  const mountInto = (anchor) => {
    if (current) return;
    const container = document.createElement('div');
    container.className = 'echo-plugin-mount dvp-profile-mount';
    container.setAttribute('data-plugin-id', 'daily-vip-claim');
    container.setAttribute('data-plugin-mount', MOUNT_ID);
    anchor.appendChild(container);

    const app = ctx.vue.createApp(ClaimCard, { variant: 'inline' });
    if (ctx.pinia) app.use(ctx.pinia);
    app.config.errorHandler = (error, _instance, info) => {
      console.warn('[daily-vip-claim] 注入组件渲染错误:', info, error);
    };
    app.mount(container);

    current = {
      dispose: () => {
        try {
          app.unmount();
        } catch (error) {
          console.warn('[daily-vip-claim] 卸载注入组件失败:', error);
        }
        if (container.isConnected) container.remove();
      },
    };
  };

  const scan = () => {
    const mounted = document.querySelector(
      `[data-plugin-mount="${MOUNT_ID}"]`,
    );
    if (mounted && mounted.isConnected) return;
    // 容器被宿主重渲染抹掉 → 释放旧实例，等新 anchor 出现再挂
    disposeCurrent();
    const anchors = document.querySelectorAll('div.space-y-2');
    for (const anchor of anchors) {
      if (isAnchor(anchor)) {
        mountInto(anchor);
        return;
      }
    }
  };

  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      scan();
    }, 80);
  };

  observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });
  schedule();

  return () => {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    disposeCurrent();
  };
};

// ---- 插件入口 ----

let disposeAll = null;

export function activate(ctx) {
  const {
    h,
    defineComponent,
    defineAsyncComponent,
    ref,
    onMounted,
    resolveComponent,
  } = ctx.vue;

  ctx.css.inject(CSS, { id: 'page' });

  const Button = defineAsyncComponent(ctx.ui.components.Button);
  const PageScrollContainer = defineAsyncComponent(ctx.ui.components.PageScrollContainer);
  const Switch = defineAsyncComponent(ctx.ui.components.Switch);

  const ClaimCard = createClaimCard(ctx, Button);

  // 1. 独立页面（无侧边栏入口，命令/快捷键可达）
  const ClaimPage = defineComponent({
    name: 'daily-vip-claim-page',
    setup() {
      // 宿主全局注册的 Icon 组件（仅可在宿主渲染树的 setup 内解析）
      const Icon = resolveComponent('Icon');
      const loggedIn = ref(null);

      onMounted(async () => {
        loggedIn.value = await isLoggedInCached(ctx);
      });

      const goLogin = () => ctx.router.push('/login');

      return () =>
        h('div', { class: 'dvp-root' }, [
          h(PageScrollContainer, null, {
            default: () =>
              h('div', { class: 'dvp-page' }, [
                h('div', { class: 'dvp-header' }, [
                  h(Icon, {
                    icon: ctx.icons.iconGift,
                    width: 26,
                    height: 26,
                    class: 'dvp-header-icon',
                  }),
                  h('h1', { class: 'dvp-title' }, '每日畅听会员'),
                ]),
                loggedIn.value === false
                  ? h('div', { class: 'dvp-logged-out' }, [
                      h(Icon, {
                        icon: ctx.icons.iconUser,
                        width: 56,
                        height: 56,
                      }),
                      h('p', null, '请先登录后领取每日畅听会员'),
                      h(Button, {
                        variant: 'primary',
                        size: 'sm',
                        onClick: goLogin,
                      }, { default: () => '去登录' }),
                    ])
                  : h(ClaimCard, { variant: 'card' }),
              ]),
          }),
        ]);
    },
  });

  ctx.ui.addPage({
    id: 'claim',
    title: '每日畅听会员领取',
    icon: 'tabler:gift',
    component: ClaimPage,
    order: 10,
  });

  ctx.commands.register(
    'daily-vip-claim:open',
    () => ctx.router.push('/main/plugin/daily-vip-claim/claim'),
    { title: '每日畅听会员领取' },
  );

  // 2. 个人中心「会员状态」下方嵌入领取卡片
  const disposeProfile = injectProfileClaim(ctx, ClaimCard);

  // 3. 插件设置项：自动领取开关 + 快速领取卡片
  const SettingsPanel = defineComponent({
    name: "daily-vip-claim-settings",
    setup() {
      const autoClaim = ref(false);
      const playerbarBadge = ref(true);
      const loaded = ref(false);

      onMounted(async () => {
        try {
          autoClaim.value = Boolean(await ctx.storage.get("autoClaim"));
          playerbarBadge.value = Boolean(await ctx.storage.get("playerbarBadge") ?? true);
        } catch (error) {
          console.warn("[daily-vip-claim] 读取设置失败:", error);
        }
        loaded.value = true;
      });

      const setAutoClaim = (value) => {
        autoClaim.value = Boolean(value);
        void ctx.storage.set("autoClaim", autoClaim.value).catch(() => {});
      };

      const setPlayerbarBadge = async (value) => {
        playerbarBadge.value = Boolean(value);
        await ctx.storage.set("playerbarBadge", playerbarBadge.value).catch(() => {});
        void updateBadges(ctx);
      };

      return () =>
        h("div", { class: "dvp-settings" }, [
          h("div", { class: "dvp-setting-row" }, [
            h("div", { class: "dvp-setting-copy" }, [
              h("div", { class: "dvp-setting-label" }, "启动后自动领取"),
              h(
                "div",
                { class: "dvp-setting-hint" },
                "启动 / 休眠唤醒 / 每小时检查一次；今日已领取时静默跳过，失败自动重试一次",
              ),
            ]),
            h(Switch, {
              modelValue: autoClaim.value,
              "onUpdate:modelValue": setAutoClaim,
              disabled: !loaded.value,
            }),
          ]),
          h("div", { class: "dvp-setting-row" }, [
            h("div", { class: "dvp-setting-copy" }, [
              h("div", { class: "dvp-setting-label" }, "播放栏快捷 VIP 胶囊 (Playerbar)"),
              h(
                "div",
                { class: "dvp-setting-hint" },
                "在底部播放栏右侧常驻显示 VIP 到期天数胶囊与快捷打卡入口 (支持 beta.9+)",
              ),
            ]),
            h(Switch, {
              modelValue: playerbarBadge.value,
              "onUpdate:modelValue": setPlayerbarBadge,
              disabled: !loaded.value,
            }),
          ]),
          h(ClaimCard, { variant: "card" }),
        ]);
    },
  });

  ctx.ui.settings.define({
    id: 'daily-vip-claim',
    title: '每日畅听会员领取',
    description: '自动领取开关与快速领取入口',
    component: SettingsPanel,
  });

  // 4. 任务中心按需由打卡调用启动，不再注入常驻 pending 任务

  // 5. 初始化 SQLite 本地流水账本与弹窗
  void initLedgerDb(ctx);
  const LedgerModal = createLedgerModal(ctx, Button);
  let unmountModal = null;
  if (ctx.ui && typeof ctx.ui.teleport === 'function') {
    try {
      unmountModal = ctx.ui.teleport(LedgerModal);
    } catch (teleportErr) {
      console.warn('[daily-vip-claim] 挂载账本弹窗失败:', teleportErr);
    }
  }

  // 6. 标题栏与底栏常驻会员直达胶囊（动态天数显示）
  void updateBadges(ctx);

  // 6.1 监听多账号切换（支持 EchoMusic beta.9 多账号切换与会话生命周期）
  let sessionDisposer = null;
  try {
    const userStore = ctx.pinia?._s?.get("user");
    if (userStore && typeof userStore.$subscribe === "function") {
      let lastUid = String(userStore.info?.userid ?? userStore.info?.userId ?? "");
      let lastRev = Number(userStore.accountRevision || 0);
      let lastLoggedIn = Boolean(userStore.isLoggedIn);

      sessionDisposer = userStore.$subscribe(() => {
        const curUid = String(userStore.info?.userid ?? userStore.info?.userId ?? "");
        const curRev = Number(userStore.accountRevision || 0);
        const curLoggedIn = Boolean(userStore.isLoggedIn);
        if (curUid !== lastUid || curRev !== lastRev || curLoggedIn !== lastLoggedIn) {
          lastUid = curUid;
          lastRev = curRev;
          lastLoggedIn = curLoggedIn;
          userVipState.userId = curUid;
          userVipState.tvipEndTime = null;
          userVipState.isVip = false;
          monthRecordCache.at = 0;
          console.info("[daily-vip-claim] 感知到账号会话切换:", curUid || "未登录");
          void refreshUserInfoBestEffort(ctx);
          void updateBadges(ctx);
        }
      });
    }
  } catch (err) {
    console.warn("[daily-vip-claim] 注册账号会话监听失败:", err);
  }

  // 7. 服务请求拦截：无缝感知用户 VIP 与登录态更新
  let unintercept = null;
  if (
    ctx.server &&
    typeof ctx.server.intercept === 'function' &&
    ctx.descriptor?.manifest?.capabilities?.serverIntercept
  ) {
    try {
      unintercept = ctx.server.intercept(
        async (request, next) => {
          const res = await next();
          try {
            const url = String(request?.url || '');
            if (
              url.includes('/user/vip') ||
              url.includes('/user/detail') ||
              url.includes('/user/profile') ||
              url.includes('/youth')
            ) {
              monthRecordCache.at = 0; // 失效当月记录缓存
              const body = res?.body;
              const data = body?.data || body;
              if (data && typeof data === 'object') {
                if (data.userid || data.userId) {
                  userVipState.userId = String(data.userid || data.userId);
                }
                const vipData = data.vip || (data.extendsInfo && data.extendsInfo.vip);
                if (vipData && Array.isArray(vipData.busi_vip)) {
                  const tvip = vipData.busi_vip.find(
                    (v) => v && v.product_type === 'tvip' && v.is_vip === 1,
                  );
                  if (tvip && tvip.vip_end_time) {
                    userVipState.tvipEndTime = tvip.vip_end_time;
                    userVipState.isVip = true;
                  }
                }
              }
              void updateTitlebarBadge(ctx);
            }
          } catch (e) {
            console.warn('[daily-vip-claim] 拦截器状态解析异常:', e);
          }
          return res;
        },
        { priority: 10, name: 'daily-vip-sync' },
      );
    } catch (interceptErr) {
      console.warn('[daily-vip-claim] 注册请求拦截器失败:', interceptErr);
    }
  }

  // 8. 自动领取（启动 5s 后、系统唤醒、每小时各检查一次）
  let disposed = false;
  let autoTimer = null;
  let autoInterval = null;
  let resumeDisposer = null;

  void (async () => {
    let autoEnabled = false;
    try {
      autoEnabled = Boolean(await ctx.storage.get('autoClaim'));
    } catch {
      // 读取失败视为未开启
    }
    if (!autoEnabled) return;

    autoTimer = setTimeout(() => {
      if (!disposed) void maybeAutoClaim(ctx);
    }, 5000);
    autoInterval = setInterval(() => {
      if (!disposed) void maybeAutoClaim(ctx);
    }, 60 * 60 * 1000);
    try {
      resumeDisposer = ctx.electron?.power?.onResume(() => {
        if (!disposed) void maybeAutoClaim(ctx);
      });
    } catch (error) {
      console.warn('[daily-vip-claim] 注册唤醒监听失败:', error);
    }
  })();

  disposeAll = () => {
    if (disposed) return;
    disposed = true;
    if (unregisterTitlebar) {
      try {
        unregisterTitlebar();
      } catch {}
      unregisterTitlebar = null;
    }
    if (unregisterPlayerbar) {
      try {
        unregisterPlayerbar();
      } catch {}
      unregisterPlayerbar = null;
    }
    if (sessionDisposer) {
      try {
        sessionDisposer();
      } catch {}
      sessionDisposer = null;
    }
    if (unmountModal) {
      try {
        unmountModal();
      } catch {}
      unmountModal = null;
    }
    if (unintercept) {
      try {
        unintercept();
      } catch {}
      unintercept = null;
    }
    if (taskHandle) {
      try {
        taskHandle.dismiss();
      } catch {}
      taskHandle = null;
    }
    if (autoTimer) {
      clearTimeout(autoTimer);
      autoTimer = null;
    }
    if (autoInterval) {
      clearInterval(autoInterval);
      autoInterval = null;
    }
    if (resumeDisposer) {
      try {
        resumeDisposer();
      } catch {
        // 忽略
      }
      resumeDisposer = null;
    }
    disposeProfile();
  };
}

export function deactivate() {
  if (disposeAll) {
    try {
      disposeAll();
    } catch (error) {
      console.warn('[daily-vip-claim] 清理失败:', error);
    }
    disposeAll = null;
  }
}
