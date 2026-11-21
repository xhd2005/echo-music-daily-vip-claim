// 每日畅听会员领取插件 (v2.5.0)
// 通过 ctx.kugou 复用宿主登录态调用酷狗 API（插件不接触用户令牌），
// 领取 1 天畅听会员（含特权升级与可选概念版打卡），提供 EchoMusic 原生极简 UI：
// - 独立主页（SliverHeader + 吸顶下划线 Tabs「今日与月历」/「领取流水」+ 当月打卡日历网格 + Popconfirm 清理）
// - 宿主原生 Dialog 畅听账本（标题栏 / 播放栏统一点击入口，展示 4 步进度与 7 天连胜轨道）
// - 个人中心 .profile-details 原生轻底色嵌入卡片
// - 插件设置项（自动领取即时启停调度、播放栏胶囊即时卸载、概念版子任务开关）
// - globalThis.__echoMusicDailyVip 跨插件轻量状态桥

// ---- 模块级辅助函数 ----

const pad = (n) => String(n).padStart(2, '0');

// 构造 YYYY-MM-DD 格式日期（本地时间，避免 UTC 偏移）
const formatClaimDate = (date = new Date()) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

// 数字（秒）时间戳 → 本地 YYYY-MM-DD
const formatSecondsDate = (value) => {
  const date = new Date(Number(value) * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const formatTimeOfDay = (timestamp) => {
  const date = new Date(Number(timestamp));
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

// 酷狗 API 已知错误码 → 友好提示映射
const VIP_ERROR_HINTS = {
  131001: '今日已领取，明天再来',
  20018: '登录已过期，请重新登录',
};

const getApiErrorMessage = (error, fallback) => {
  const body = error?.response?.body;
  const msg = body?.error_msg ?? body?.msg;
  if (typeof msg === 'string' && msg.trim()) return msg.trim();
  const code = body?.error_code ?? body?.errcode;
  if (code != null && Number(code) !== 0) {
    const hint = VIP_ERROR_HINTS[Number(code)];
    if (hint) return hint;
  }
  const ownMsg = error instanceof Error ? error.message.trim() : '';
  if (ownMsg && !ownMsg.startsWith('API Error:')) return ownMsg;
  return `${fallback}，请稍后重试`;
};

const isClaim131001 = (error) =>
  Number(error?.response?.body?.error_code ?? error?.response?.body?.errcode) === 131001;

// 构建当月打卡日历网格（周一为每周第一天）
const buildMonthCalendar = (claimedDatesSet, failedDatesSet, baseDate = new Date()) => {
  const year = baseDate.getFullYear();
  const month = baseDate.getMonth();
  const todayDay = baseDate.getDate();
  const todayStr = formatClaimDate(baseDate);
  const firstDay = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const startOffset = (firstDay.getDay() + 6) % 7; // Mon=0 .. Sun=6

  const cells = [];
  for (let i = 0; i < startOffset; i += 1) {
    cells.push({ empty: true, key: `pad-${i}` });
  }
  let claimedInMonth = 0;
  for (let day = 1; day <= daysInMonth; day += 1) {
    const dateStr = `${year}-${pad(month + 1)}-${pad(day)}`;
    const isClaimed = claimedDatesSet.has(dateStr);
    const isFailed = !isClaimed && failedDatesSet.has(dateStr);
    if (isClaimed) claimedInMonth += 1;
    cells.push({
      empty: false,
      key: dateStr,
      day,
      dateStr,
      isToday: dateStr === todayStr,
      isClaimed,
      isFailed,
      isFuture: day > todayDay,
    });
  }
  return {
    year,
    month: month + 1,
    monthLabel: `${year}年${pad(month + 1)}月`,
    claimedInMonth,
    daysInMonth,
    cells,
  };
};

// ---- 状态模型 ----

const createDefaultSteps = (enableConceptTasks = true) => ({
  baseVip: 'idle',
  upgrade: 'idle',
  conceptAd: enableConceptTasks ? 'idle' : 'skipped',
  conceptListen: enableConceptTasks ? 'idle' : 'skipped',
});

const userVipState = {
  userId: '',
  tvipEndTime: null,
  isVip: false,
  lastUpdated: 0,
};

const createInitialRuntimeData = () => ({
  loggedIn: null,
  userId: '',
  vipExpiry: '--',
  claimedToday: false,
  monthCount: null,
  monthRecords: [],
  streakDays: 0,
  totalSuccess: 0,
  savedMoney: 0,
  recentLogs: [],
  isClaiming: false,
  isRefreshing: false,
  lastError: '',
  autoClaim: false,
  playerbarBadge: true,
  enableConceptTasks: true,
  stepsDate: formatClaimDate(),
  steps: createDefaultSteps(true),
  playerbarBadgeText: '',
  tooltipText: '畅听VIP · 点击查看每日打卡账本',
  updatedAt: 0,
});

// 活跃响应式状态（在 activate 时通过 ctx.vue.reactive 包装，确保跨组件与 playerbar badge 自动响应）
let runtime = createInitialRuntimeData();

const ensureStepsForToday = () => {
  const today = formatClaimDate();
  if (runtime.stepsDate !== today) {
    runtime.stepsDate = today;
    const fresh = createDefaultSteps(runtime.enableConceptTasks);
    runtime.steps.baseVip = fresh.baseVip;
    runtime.steps.upgrade = fresh.upgrade;
    runtime.steps.conceptAd = fresh.conceptAd;
    runtime.steps.conceptListen = fresh.conceptListen;
    runtime.lastError = '';
  }
};

const setStepStatus = (key, value) => {
  ensureStepsForToday();
  if (runtime.steps && Object.prototype.hasOwnProperty.call(runtime.steps, key)) {
    runtime.steps[key] = value;
  }
};

const snapshotSteps = () => ({
  baseVip: runtime.steps.baseVip,
  upgrade: runtime.steps.upgrade,
  conceptAd: runtime.steps.conceptAd,
  conceptListen: runtime.steps.conceptListen,
});

const syncConceptStepIdleState = (enabled) => {
  ensureStepsForToday();
  if (!enabled) {
    if (runtime.steps.conceptAd === 'idle') runtime.steps.conceptAd = 'skipped';
    if (runtime.steps.conceptListen === 'idle') runtime.steps.conceptListen = 'skipped';
  } else {
    if (runtime.steps.conceptAd === 'skipped') runtime.steps.conceptAd = 'idle';
    if (runtime.steps.conceptListen === 'skipped') runtime.steps.conceptListen = 'idle';
  }
};

// 读取账号 ID
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

const readEnableConceptTasks = async (ctx) => {
  try {
    const stored = await ctx.storage?.get?.('enableConceptTasks');
    const enabled = stored === null || stored === undefined ? true : Boolean(stored);
    runtime.enableConceptTasks = enabled;
    return enabled;
  } catch {
    return runtime.enableConceptTasks;
  }
};

// ---- SQLite 本地打卡流水账本 ----

const LEDGER_DB_NAME = 'vip_claim_ledger';
let ledgerDb = null;
const manuallyClearedUids = new Set();

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
          sql: [`SELECT 1;`],
        },
      ],
    });
    if (res && res.ok) {
      ledgerDb = res;
      console.info('[daily-vip-claim] SQLite 本地账本加载就绪');
      void backfillLedgerFromMonthRecords(ctx, readUserId(ctx));
      return ledgerDb;
    }
    console.warn('[daily-vip-claim] 打开 SQLite 本地账本未成功:', res?.error);
  } catch (err) {
    console.warn('[daily-vip-claim] 打开 SQLite 本地账本异常:', err);
  }
  return null;
};

const backfillLedgerFromMonthRecords = async (ctx, userId = '') => {
  if (!ledgerDb) return;
  try {
    const uid = String(userId || readUserId(ctx) || '').trim();
    if (manuallyClearedUids.has(uid)) return;
    const countRes = uid
      ? await ledgerDb.get('SELECT COUNT(*) AS total FROM claim_ledger WHERE user_id = ?', [uid])
      : await ledgerDb.get('SELECT COUNT(*) AS total FROM claim_ledger');
    const existingCount = Number(countRes?.row?.total || 0);
    if (existingCount > 0) return;

    const records = await getMonthRecordsCached(ctx).catch(() => []);
    if (!Array.isArray(records) || records.length === 0) return;

    for (const rec of records) {
      if (!rec || !rec.date) continue;
      const claimedAt = new Date(`${rec.date} 12:00:00`).getTime() || Date.now();
      await ledgerDb.run(
        `INSERT OR IGNORE INTO claim_ledger
          (user_id, claim_date, claimed_at, expiry_text, upgrade_status, concept_task_status, duration_ms, status, message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uid, rec.date, claimedAt, '', 1, 0, 80, 'success', rec.label || '当月已领记录'],
      );
    }
    console.info(`[daily-vip-claim] 已自动同步账号 ${uid || '默认'} 的 ${records.length} 条当月打卡历史到本地账本`);
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
    const uid = String(userId || '').trim();
    manuallyClearedUids.delete(uid);
    await ledgerDb.run(
      `INSERT OR REPLACE INTO claim_ledger
        (user_id, claim_date, claimed_at, expiry_text, upgrade_status, concept_task_status, duration_ms, status, message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uid,
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
      `SELECT * FROM claim_ledger ${whereClause} ORDER BY claimed_at DESC LIMIT 100`,
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

const clearLedgerForUser = async (userId = '') => {
  if (!ledgerDb) return { ok: false, error: '本地账本未初始化' };
  try {
    const uid = String(userId || '').trim();
    manuallyClearedUids.add(uid);
    if (uid) {
      await ledgerDb.run('DELETE FROM claim_ledger WHERE user_id = ? OR user_id = ""', [uid]);
    } else {
      await ledgerDb.run('DELETE FROM claim_ledger');
    }
    return { ok: true, error: null };
  } catch (err) {
    console.warn('[daily-vip-claim] 清空账本流水失败:', err);
    return { ok: false, error: err instanceof Error ? err.message : '清空失败' };
  }
};

// ---- 内部 API 与概念版任务 ----

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

// 查询概念版 Young VIP 联合信息（/v2/batch_union_vipinfo）
const fetchConceptUnionVipInfo = async (ctx, userId) => {
  if (!userId) return null;
  try {
    const res = await sendInternalApiRequest(ctx, {
      method: 'POST',
      url: '/v2/batch_union_vipinfo',
      data: {
        useridlist: [Number(userId)],
        busi_type: 'concept',
        get_type: '2',
      },
    });
    const busiVip = res?.body?.data?.busi_vip;
    if (busiVip && typeof busiVip === 'object') {
      const userVipArr = busiVip[userId] || busiVip[Number(userId)];
      if (Array.isArray(userVipArr)) {
        const tvip = userVipArr.find(
          (v) => v && (v.product_type === 'tvip' || v.busi_type === 'concept') && v.is_vip === 1,
        );
        if (tvip && tvip.vip_end_time) {
          return tvip.vip_end_time;
        }
      }
    }
  } catch {
    // 降级非阻断
  }
  return null;
};

// 全能版任务：分别上报概念版广告打卡与听歌任务
const runConceptEditionTasks = async (ctx, onStepUpdate) => {
  let adSuccess = false;
  let listenSuccess = false;

  // 1. 概念版广告打卡
  onStepUpdate?.('conceptAd', 'running', '正在执行概念版广告打卡...');
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
  onStepUpdate?.('conceptAd', adSuccess ? 'success' : 'failed');

  // 2. 概念版听歌打卡
  onStepUpdate?.('conceptListen', 'running', '正在执行概念版听歌打卡...');
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
  onStepUpdate?.('conceptListen', listenSuccess ? 'success' : 'failed');

  return {
    adSuccess,
    listenSuccess,
    ok: adSuccess || listenSuccess,
  };
};

// 从风控错误体中提取酷狗验证码 challenge（适配宿主 ctx.kugouVerification.request 签名）
const extractVerificationChallenge = (err) => {
  const body = err?.response?.body;
  const data = body?.data && typeof body.data === 'object' ? body.data : body;
  const ssaCode = String(
    data?.ssaCode ?? data?.ssa_code ?? body?.ssaCode ?? body?.ssa_code ?? '',
  ).trim();
  const eventId = String(
    data?.eventId ?? data?.event_id ?? body?.eventId ?? body?.event_id ?? '',
  ).trim();
  if (ssaCode && eventId) return { ssaCode, eventId };
  if (ssaCode) return ssaCode;
  if (eventId) return eventId;
  return { ssaCode: 'claim_vip', eventId: 'claim_vip' };
};

// ---- 单飞锁：领取 + 升级 + 概念版任务共享同一 in-flight Promise ----

let claimInFlight = null;

const claimOnce = (ctx, progressCallback, options = {}) => {
  if (claimInFlight) return claimInFlight;
  claimInFlight = (async () => {
    const t0 = Date.now();
    const today = formatClaimDate();
    const uid = readUserId(ctx);
    const enableConceptTasks =
      typeof options.enableConceptTasks === 'boolean'
        ? options.enableConceptTasks
        : await readEnableConceptTasks(ctx);

    ensureStepsForToday();
    setStepStatus('baseVip', 'running');
    setStepStatus('upgrade', 'idle');
    setStepStatus('conceptAd', enableConceptTasks ? 'idle' : 'skipped');
    setStepStatus('conceptListen', enableConceptTasks ? 'idle' : 'skipped');

    let upgradeSuccess = false;
    let adSuccess = false;
    let listenSuccess = false;
    let conceptTaskSuccess = false;
    let claimError = null;

    progressCallback?.('步骤 1/4：正在领取基础畅听会员...');
    try {
      await ctx.kugou.user.claimDayVip(today);
      setStepStatus('baseVip', 'success');
    } catch (err) {
      claimError = err;
      const errCode = Number(err?.response?.body?.error_code || err?.response?.body?.errcode);
      const verifyFn =
        typeof ctx.kugouVerification?.request === 'function'
          ? (challenge) => ctx.kugouVerification.request(challenge)
          : typeof ctx.kugouVerification?.requestVerification === 'function'
            ? () =>
                ctx.kugouVerification.requestVerification({
                  scene: 'claim_vip',
                  message: '领取每日畅听会员需进行安全验证',
                })
            : null;
      if (
        (errCode === 10008 || errCode === 10009 || errCode === 10010 || errCode === 20028) &&
        verifyFn
      ) {
        try {
          ctx.toast?.info?.('检测到安全验证，正在调起验证...');
          await verifyFn(extractVerificationChallenge(err));
          await ctx.kugou.user.claimDayVip(today);
          claimError = null;
          setStepStatus('baseVip', 'success');
        } catch (verifyErr) {
          console.warn('[daily-vip-claim] 验证码验证失败:', verifyErr);
        }
      }
      if (claimError && isClaim131001(claimError)) {
        setStepStatus('baseVip', 'already');
      } else if (claimError) {
        const durationMs = Date.now() - t0;
        const errMsg = getApiErrorMessage(claimError, '领取失败');
        setStepStatus('baseVip', 'failed');
        setStepStatus('upgrade', 'skipped');
        setStepStatus('conceptAd', 'skipped');
        setStepStatus('conceptListen', 'skipped');
        await recordClaimLedger({
          userId: uid,
          claimDate: today,
          claimedAt: Date.now(),
          durationMs,
          status: 'failed',
          message: errMsg,
        });
        claimError._steps = snapshotSteps();
        claimError._durationMs = durationMs;
        throw claimError;
      }
    }

    progressCallback?.('步骤 2/4：正在升级概念特权...');
    setStepStatus('upgrade', 'running');
    try {
      await ctx.kugou.user.upgradeDayVip();
      upgradeSuccess = true;
      setStepStatus('upgrade', 'success');
    } catch (upgradeError) {
      setStepStatus('upgrade', 'failed');
      console.warn('[daily-vip-claim] 升级失败（非阻断）:', upgradeError);
    }

    if (enableConceptTasks) {
      try {
        const conceptRes = await runConceptEditionTasks(ctx, (stepKey, state, label) => {
          setStepStatus(stepKey, state);
          if (label) progressCallback?.(label);
        });
        adSuccess = conceptRes.adSuccess;
        listenSuccess = conceptRes.listenSuccess;
        conceptTaskSuccess = conceptRes.ok;
      } catch (conceptError) {
        setStepStatus('conceptAd', 'failed');
        setStepStatus('conceptListen', 'failed');
        console.warn('[daily-vip-claim] 概念打卡异常（非阻断）:', conceptError);
      }
    } else {
      setStepStatus('conceptAd', 'skipped');
      setStepStatus('conceptListen', 'skipped');
    }

    const durationMs = Date.now() - t0;
    const alreadyClaimed = Boolean(claimError && isClaim131001(claimError));
    const expiryText = formatExpiryText(readTvipEndTime(ctx));

    const messageParts = [];
    if (alreadyClaimed) {
      messageParts.push(upgradeSuccess ? '今日已领，特权已补同步' : '今日已领畅听VIP');
    } else {
      messageParts.push(upgradeSuccess ? '畅听VIP领取并升级特权成功' : '畅听VIP领取成功');
    }
    if (enableConceptTasks) {
      if (adSuccess && listenSuccess) messageParts.push('广告与听歌任务已打卡');
      else if (adSuccess) messageParts.push('广告任务已打卡');
      else if (listenSuccess) messageParts.push('听歌任务已打卡');
    }

    // 失效当月缓存以便后续立即反映今日已领
    monthRecordCache.at = 0;

    await recordClaimLedger({
      userId: uid,
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
      ok: true,
      today,
      alreadyClaimed,
      upgradeSuccess,
      adSuccess,
      listenSuccess,
      conceptTaskSuccess,
      steps: snapshotSteps(),
      durationMs,
      error: null,
    };
  })().finally(() => {
    claimInFlight = null;
  });
  return claimInFlight;
};

// ---- 当月记录（带 5 分钟缓存） ----

const MONTH_RECORD_TTL = 5 * 60 * 1000;
let monthRecordCache = { at: 0, value: [] };

const getMonthRecordsCached = async (ctx, forceRefresh = false) => {
  if (!forceRefresh && Date.now() - monthRecordCache.at < MONTH_RECORD_TTL) {
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
const calculateStreakDays = (records, ledgerRows = []) => {
  const dates = new Set();
  if (Array.isArray(records)) {
    for (const r of records) {
      if (r && r.date) dates.add(r.date);
    }
  }
  if (Array.isArray(ledgerRows)) {
    for (const row of ledgerRows) {
      if (row && row.status === 'success' && row.claim_date) dates.add(row.claim_date);
    }
  }
  if (dates.size === 0) return 0;
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

const normalizeVipRecords = (res) => {
  const body = res ?? {};
  const data = body.data;
  const dataRecord = data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  const rawList =
    (Array.isArray(data) ? data : null) ||
    (Array.isArray(dataRecord?.records) ? dataRecord.records : null) ||
    (Array.isArray(dataRecord?.list) ? dataRecord.list : null) ||
    (Array.isArray(body.records) ? body.records : null) ||
    (Array.isArray(body.list) ? body.list : null);
  if (!Array.isArray(rawList)) return [];
  return rawList
    .map((item) => {
      const record = item && typeof item === 'object' ? item : null;
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

// ---- VIP 到期读取 ----

const readTvipEndTime = (ctx) => {
  try {
    const store = ctx.pinia && ctx.pinia._s && ctx.pinia._s.get('user');
    const busiVip =
      (store &&
        store.info &&
        store.info.extendsInfo &&
        store.info.extendsInfo.vip &&
        store.info.extendsInfo.vip.busi_vip) ||
      [];
    const tvip = busiVip.find((v) => v && v.product_type === 'tvip' && v.is_vip === 1);
    return tvip ? tvip.vip_end_time : userVipState.tvipEndTime;
  } catch {
    return userVipState.tvipEndTime || null;
  }
};

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

const isLoggedInCached = async (ctx) => {
  try {
    const kv = await ctx.electron.storage.getKv('pinia:user');
    return Boolean(kv && (kv.isLoggedIn === true || (kv.info && kv.info.token)));
  } catch {
    try {
      const store = ctx.pinia?._s?.get('user');
      if (store && typeof store.isLoggedIn === 'boolean') return store.isLoggedIn;
    } catch {}
    return null;
  }
};

const refreshUserInfoBestEffort = (ctx) => {
  try {
    const store = ctx.pinia && ctx.pinia._s && ctx.pinia._s.get('user');
    if (store && typeof store.fetchUserInfo === 'function') {
      void Promise.resolve(store.fetchUserInfo()).catch(() => {});
    }
  } catch {
    // 非阻塞
  }
};

// ---- 纯矢量内联图标（两种渲染上下文均安全） ----

const ICONS = {
  gift: {
    width: 24,
    height: 24,
    body: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M3 12h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8zm-1-4a1 1 0 0 1 1-1h18a1 1 0 0 1 1 1v4H2V8zm10-5a2.5 2.5 0 0 0-2.5 2.5V7h5v-1.5A2.5 2.5 0 0 0 12 3zm0 4V3m-4 4h8m-4 5v10"/>',
  },
  flame: {
    width: 24,
    height: 24,
    body: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 2c.5 3 2.5 5 4.5 7.5 2 2.5 2.5 5.5 1.5 8.5-1.5 4-5.5 6-9 4.5-3.5-1.5-5-5-3.5-9 1-2.5 3-4.5 4-7 .5 2 1.5 3 2.5 3.5 0-2.5 0-5 0-7.5z"/>',
  },
  coin: {
    width: 24,
    height: 24,
    body: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M14.5 9h-4a1.5 1.5 0 0 0 0 3h3a1.5 1.5 0 0 1 0 3h-4m2.5-8v10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  },
  crown: {
    width: 24,
    height: 24,
    body: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 19h16M5 16l2-9 5 4 5-4 2 9H5z"/>',
  },
  sparkles: {
    width: 24,
    height: 24,
    body: '<path fill="currentColor" d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3zM19 16l1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3zM5 16l.8 2.2L8 19l-2.2.8L5 22l-.8-2.2L2 19l2.2-.8L5 16z"/>',
  },
  check: {
    width: 24,
    height: 24,
    body: '<path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="M5 12l5 5L20 7"/>',
  },
  close: {
    width: 24,
    height: 24,
    body: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M18 6L6 18M6 6l12 12"/>',
  },
  minus: {
    width: 24,
    height: 24,
    body: '<path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M6 12h12"/>',
  },
  loader: {
    width: 24,
    height: 24,
    body: '<path fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83"/>',
  },
  refresh: {
    width: 24,
    height: 24,
    body: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/>',
  },
  calendar: {
    width: 24,
    height: 24,
    body: '<rect x="3" y="4" width="18" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M16 2v4M8 2v4M3 10h18"/>',
  },
  trash: {
    width: 24,
    height: 24,
    body: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6h12z"/>',
  },
  external: {
    width: 24,
    height: 24,
    body: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M15 3h6v6M10 14L21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  },
  alert: {
    width: 24,
    height: 24,
    body: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 8v5m0 3h.01"/>',
  },
  user: {
    width: 24,
    height: 24,
    body: '<circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M5 20a7 7 0 0 1 14 0"/>',
  },
  book: {
    width: 24,
    height: 24,
    body: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2V5zm0 13a2 2 0 0 1 2-2h13"/>',
  },
};

const iconSvg = (h, iconData, { size = 16, className = '' } = {}) =>
  h('svg', {
    xmlns: 'http://www.w3.org/2000/svg',
    width: size,
    height: size,
    viewBox: `0 0 ${iconData?.width || 24} ${iconData?.height || 24}`,
    class: className,
    'aria-hidden': 'true',
    innerHTML: iconData?.body ?? '',
  });

const buildFallbackCoverUrl = () => {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160">' +
    '<rect width="160" height="160" rx="18" fill="rgba(128,128,128,0.16)"/>' +
    '<g transform="translate(44 44) scale(3)" fill="none" stroke="rgba(128,128,128,0.85)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M3 12h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8zm-1-4a1 1 0 0 1 1-1h18a1 1 0 0 1 1 1v4H2V8zm10-5a2.5 2.5 0 0 0-2.5 2.5V7h5v-1.5A2.5 2.5 0 0 0 12 3zm0 4V3m-4 4h8m-4 5v10"/>' +
    '</g></svg>';
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
};

// ---- 任务中心管理 ----

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
      icon: ctx.icons?.iconGift || ICONS.gift,
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

// ---- 全局账本弹窗控制器 ----

const ledgerModalState = {
  open: null,
  close: null,
};

// ---- 标题栏与底栏双快捷入口管理（单次注册 + 响应式 badge + 正确卸载） ----

let unregisterTitlebar = null;
let unregisterPlayerbar = null;

const syncTodayStepsFromLedger = (recentLogs, claimedToday) => {
  ensureStepsForToday();
  const today = formatClaimDate();
  const todayRow = (recentLogs || []).find((row) => row && row.claim_date === today);
  if (todayRow && todayRow.status === 'success') {
    if (runtime.steps.baseVip === 'idle') runtime.steps.baseVip = 'already';
    if (runtime.steps.upgrade === 'idle' && todayRow.upgrade_status) {
      runtime.steps.upgrade = 'success';
    }
    if (runtime.enableConceptTasks && todayRow.concept_task_status) {
      if (runtime.steps.conceptAd === 'idle') runtime.steps.conceptAd = 'success';
      if (runtime.steps.conceptListen === 'idle') runtime.steps.conceptListen = 'success';
    }
  } else if (claimedToday && runtime.steps.baseVip === 'idle') {
    runtime.steps.baseVip = 'already';
  }
  syncConceptStepIdleState(runtime.enableConceptTasks);
};

const updateBadges = async (ctx, options = {}) => {
  runtime.isRefreshing = true;
  try {
    ensureStepsForToday();

    // 先同步设置开关，确保关闭播放栏胶囊时立即卸载
    const [storedPlayerbar, storedConcept] = await Promise.all([
      ctx.storage?.get?.('playerbarBadge').catch(() => null),
      ctx.storage?.get?.('enableConceptTasks').catch(() => null),
    ]);
    const showInPlayerbar =
      storedPlayerbar === null || storedPlayerbar === undefined ? true : Boolean(storedPlayerbar);
    const enableConcept =
      storedConcept === null || storedConcept === undefined ? true : Boolean(storedConcept);
    runtime.playerbarBadge = showInPlayerbar;
    runtime.enableConceptTasks = enableConcept;
    syncConceptStepIdleState(enableConcept);

    const ok = await isLoggedInCached(ctx);
    runtime.loggedIn = ok;

    let pBadge = '';
    let tooltip = '畅听VIP · 点击查看每日打卡账本';

    if (ok === false) {
      runtime.userId = '';
      runtime.vipExpiry = '--';
      runtime.claimedToday = false;
      runtime.monthCount = 0;
      runtime.monthRecords = [];
      runtime.streakDays = 0;
      pBadge = '未登录';
      tooltip = '未登录酷狗账号 · 点击打开畅听账本';
    } else {
      const uid = readUserId(ctx);
      runtime.userId = uid;
      let endTime = readTvipEndTime(ctx);
      if (!endTime && uid) {
        endTime = await fetchConceptUnionVipInfo(ctx, uid);
        if (endTime) userVipState.tvipEndTime = endTime;
      }
      const expiryText = formatExpiryText(endTime);
      const [records, ledger] = await Promise.all([
        getMonthRecordsCached(ctx, Boolean(options.force)).catch(() => []),
        getLedgerStats(uid),
      ]);
      const todayStr = formatClaimDate();
      const ledgerClaimedToday = (ledger.recentLogs || []).some(
        (row) => row && row.claim_date === todayStr && row.status === 'success',
      );
      const claimedToday = isTodayClaimed(records) || ledgerClaimedToday;
      const streak = calculateStreakDays(records, ledger.recentLogs);
      const totalDays = ledger.totalSuccess || 0;
      const saved = ledger.savedMoney || 0;

      runtime.vipExpiry = expiryText;
      runtime.monthRecords = records;
      runtime.monthCount = records.length;
      runtime.claimedToday = claimedToday;
      runtime.streakDays = streak;
      runtime.totalSuccess = totalDays;
      runtime.savedMoney = saved;
      runtime.recentLogs = ledger.recentLogs || [];
      syncTodayStepsFromLedger(ledger.recentLogs, claimedToday);

      if (expiryText === '已过期') {
        pBadge = '已过期';
      } else if (expiryText !== '--') {
        pBadge = claimedToday ? `已领 · ${expiryText}` : expiryText;
      } else {
        pBadge = claimedToday ? '今日已领' : '待领取';
      }

      tooltip = `畅听VIP · ${expiryText} · 连续 ${streak} 天 · 累计 ${totalDays} 天（省约 ¥${saved}）· 点击查看账本`;
    }

    runtime.playerbarBadgeText = pBadge;
    runtime.tooltipText = tooltip;
    runtime.updatedAt = Date.now();

    // 1. 标题栏直达入口：单次注册，不反复销毁重建；统一打开原生账本 Dialog
    if (ctx.ui?.titlebar && typeof ctx.ui.titlebar.register === 'function' && !unregisterTitlebar) {
      unregisterTitlebar = ctx.ui.titlebar.register({
        id: 'daily-vip-badge',
        title: '畅听VIP',
        icon: ctx.icons?.iconGift || ICONS.gift,
        tooltip: '畅听VIP · 点击查看每日打卡账本',
        defaultPlacement: 'toolbar',
        order: 25,
        onClick: () => {
          void ledgerModalState.open?.();
        },
      });
    }

    // 2. 播放栏 Playerbar 快捷胶囊：按开关状态单次注册或立即卸载，通过响应式 badge 驱动文案
    if (ctx.ui?.playerbar && typeof ctx.ui.playerbar.register === 'function') {
      if (showInPlayerbar) {
        if (!unregisterPlayerbar) {
          unregisterPlayerbar = ctx.ui.playerbar.register({
            id: 'daily-vip-claim-playerbar',
            title: '畅听VIP',
            icon: ctx.icons?.iconGift || ICONS.gift,
            tooltip: '畅听VIP · 点击查看每日打卡账本',
            badge: () => runtime.playerbarBadgeText || null,
            badgeTitle: '畅听VIP',
            badgeDefaultVisible: true,
            defaultPlacement: 'right',
            order: 950,
            onClick: () => {
              void ledgerModalState.open?.();
            },
          });
        }
      } else if (unregisterPlayerbar) {
        try {
          unregisterPlayerbar();
        } catch {}
        unregisterPlayerbar = null;
      }
    }
  } catch (err) {
    console.warn('[daily-vip-claim] 刷新徽章状态异常:', err);
  } finally {
    runtime.isRefreshing = false;
  }
};

// ---- 打卡执行入口（返回结构化结果，彻底消除假阳性） ----

const maybeAutoClaim = async (ctx, manual = false) => {
  ensureStepsForToday();
  const ok = await isLoggedInCached(ctx);
  if (ok === false) {
    console.info('[daily-vip-claim] 打卡跳过：未登录');
    runtime.loggedIn = false;
    runtime.lastError = '请先登录后再进行打卡';
    void updateBadges(ctx);
    if (manual) ctx.toast?.info?.('请先登录后再进行打卡');
    return {
      ok: false,
      alreadyClaimed: false,
      steps: snapshotSteps(),
      error: '请先登录后再进行打卡',
    };
  }

  // 非手动触发时预判今日已领，命中则静默跳过
  if (!manual) {
    try {
      const records = await getMonthRecordsCached(ctx);
      if (isTodayClaimed(records)) {
        console.info('[daily-vip-claim] 自动打卡跳过：今日已领取');
        runtime.claimedToday = true;
        runtime.lastError = '';
        if (runtime.steps.baseVip === 'idle') setStepStatus('baseVip', 'already');
        void updateBadges(ctx);
        return {
          ok: true,
          alreadyClaimed: true,
          skipped: true,
          steps: snapshotSteps(),
          error: null,
        };
      }
    } catch (error) {
      console.warn('[daily-vip-claim] 预检领取记录失败，尝试直接打卡:', error);
    }
  }

  runtime.isClaiming = true;
  runtime.lastError = '';
  const runTask = startClaimTask(ctx, { progress: { label: '正在执行每日畅听打卡...' } });

  try {
    for (let attempt = 0; attempt <= 1; attempt += 1) {
      try {
        const result = await claimOnce(ctx, (stepLabel) => {
          runTask?.update?.({ progress: { label: stepLabel } });
        });
        runtime.claimedToday = true;
        runtime.lastError = '';
        if (result.alreadyClaimed) {
          if (manual) ctx.toast?.info?.('今日畅听会员已领，已完成特权与任务补同步');
          runTask?.finish?.('completed', { progress: { label: '今日已领 · 补同步完成' } });
        } else {
          ctx.toast?.success?.('已成功领取 1 天畅听会员并完成打卡');
          runTask?.finish?.('completed', { progress: { label: '今日全套 VIP 续期与打卡已完成' } });
        }
        refreshUserInfoBestEffort(ctx);
        await updateBadges(ctx, { force: true });
        return {
          ok: true,
          alreadyClaimed: Boolean(result.alreadyClaimed),
          steps: result.steps,
          durationMs: result.durationMs,
          error: null,
        };
      } catch (error) {
        if (isClaim131001(error)) {
          runtime.claimedToday = true;
          runtime.lastError = '';
          setStepStatus('baseVip', 'already');
          runTask?.finish?.('completed', { progress: { label: '今日已领取，明天再来' } });
          await updateBadges(ctx, { force: true });
          if (manual) ctx.toast?.info?.('今日已领取，明天再来');
          return {
            ok: true,
            alreadyClaimed: true,
            steps: snapshotSteps(),
            error: null,
          };
        }
        if (attempt === 1 || manual) {
          console.warn('[daily-vip-claim] 打卡失败:', error);
          const errMsg = getApiErrorMessage(error, '每日畅听 VIP 打卡失败');
          runtime.lastError = errMsg;
          ctx.toast?.danger?.(errMsg);
          runTask?.finish?.('error', { error: errMsg });
          await updateBadges(ctx);
          return {
            ok: false,
            alreadyClaimed: false,
            steps: error?._steps || snapshotSteps(),
            error: errMsg,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
    return {
      ok: false,
      alreadyClaimed: false,
      steps: snapshotSteps(),
      error: '打卡未完成，请稍后重试',
    };
  } finally {
    runtime.isClaiming = false;
  }
};

const claimNow = (ctx) => maybeAutoClaim(ctx, true);

// ---- EchoMusic 第一方原生极简样式（零硬编码深色色值、零未编译 Tailwind 类） ----

const CSS = `
.dvp-root {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  color: var(--color-text-main);
}

.dvp-scroll {
  flex: 1;
  min-height: 0;
}

.dvp-page-shell {
  min-height: 100%;
  background: var(--bg-main);
}

/* SliverHeader 详情与操作 */
.dvp-header-details {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--color-text-secondary);
}

.dvp-header-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.dvp-header-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.dvp-btn-content {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

/* 吸顶下划线 Tabs 栏（仅允许 1px var(--border-subtle) 底线） */
.dvp-sticky-header {
  position: sticky;
  z-index: 110;
  background: var(--bg-main);
}

.dvp-sticky-inner {
  padding: 0 24px;
}

.dvp-sticky-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  height: 52px;
  border-bottom: 1px solid var(--border-subtle);
}

.dvp-tabs-list {
  display: flex;
  align-items: center;
  gap: 28px;
  height: 48px;
  background: transparent;
  border: none;
}

.dvp-tab-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.dvp-tab-count {
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-secondary);
  font-variant-numeric: tabular-nums;
}

.dvp-sticky-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.dvp-sticky-meta {
  font-size: 12px;
  color: var(--color-text-secondary);
  font-variant-numeric: tabular-nums;
}

/* 页面内容容器（左右统一 24px 对齐 SliverHeader） */
.dvp-tab-body {
  padding: 20px 24px 36px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 原生轻底色分区（border: none，遵循 surfaces.css） */
.dvp-panel {
  border: none;
  border-radius: var(--radius-card);
  background: var(--content-panel-bg);
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.dvp-panel-compact {
  padding: 14px 16px;
  gap: 10px;
}

.dvp-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.dvp-panel-title {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  color: var(--color-text-main);
  display: inline-flex;
  align-items: center;
  gap: 7px;
}

.dvp-panel-subtitle {
  font-size: 12px;
  color: var(--color-text-secondary);
}

/* 柔和状态标签（无硬边框） */
.dvp-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: var(--radius-control);
  background: var(--control-muted-bg);
  color: var(--color-text-secondary);
  font-size: 11.5px;
  font-weight: 600;
  line-height: 1.5;
  white-space: nowrap;
}

.dvp-pill-primary {
  background: var(--control-active-bg);
  color: var(--color-primary-text);
}

.dvp-pill-success {
  background: color-mix(in srgb, var(--state-success) 13%, transparent);
  color: var(--state-success);
}

.dvp-pill-warning {
  background: color-mix(in srgb, var(--state-warning) 14%, transparent);
  color: var(--state-warning);
}

.dvp-pill-danger {
  background: color-mix(in srgb, var(--state-danger) 13%, transparent);
  color: var(--state-danger);
}

/* 4 步打卡进度条 */
.dvp-steps-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

.dvp-steps-grid-compact {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

@media (max-width: 720px) {
  .dvp-steps-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.dvp-step-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--radius-item);
  background: var(--control-muted-bg);
  min-width: 0;
  transition: background-color 0.16s ease;
}

.dvp-step-item.is-done {
  background: color-mix(in srgb, var(--state-success) 11%, transparent);
}

.dvp-step-item.is-running {
  background: var(--control-active-bg);
}

.dvp-step-item.is-failed {
  background: color-mix(in srgb, var(--state-danger) 11%, transparent);
}

.dvp-step-item.is-skipped {
  opacity: 0.65;
}

.dvp-step-dot {
  width: 24px;
  height: 24px;
  border-radius: 999px;
  background: var(--control-hover-bg);
  color: var(--color-text-secondary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.dvp-step-item.is-done .dvp-step-dot {
  background: var(--state-success);
  color: var(--color-on-primary);
}

.dvp-step-item.is-running .dvp-step-dot {
  background: var(--color-primary);
  color: var(--color-on-primary);
}

.dvp-step-item.is-failed .dvp-step-dot {
  background: var(--state-danger);
  color: var(--color-on-primary);
}

.dvp-step-copy {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.dvp-step-name {
  font-size: 12.5px;
  font-weight: 650;
  color: var(--color-text-main);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dvp-step-state {
  font-size: 11px;
  color: var(--color-text-secondary);
}

.dvp-step-item.is-done .dvp-step-state {
  color: var(--state-success);
}

.dvp-step-item.is-running .dvp-step-state {
  color: var(--color-primary-text);
}

.dvp-step-item.is-failed .dvp-step-state {
  color: var(--state-danger);
}

/* 错误提示横幅 */
.dvp-error-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: var(--radius-item);
  background: color-mix(in srgb, var(--state-danger) 11%, transparent);
  color: var(--state-danger);
  font-size: 12px;
  font-weight: 600;
}

/* KPI 指标网格 */
.dvp-kpi-grid-4 {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

.dvp-kpi-grid-3 {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

@media (max-width: 720px) {
  .dvp-kpi-grid-4 {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.dvp-kpi-card {
  border: none;
  border-radius: var(--radius-card);
  background: var(--content-panel-bg);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.dvp-kpi-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.dvp-kpi-value {
  font-size: 20px;
  font-weight: 700;
  line-height: 1.25;
  color: var(--color-text-main);
  font-variant-numeric: tabular-nums;
}

.dvp-kpi-value.is-accent {
  color: var(--color-primary-text);
}

.dvp-kpi-value.is-warning {
  color: var(--state-warning);
}

.dvp-kpi-value.is-danger {
  color: var(--state-danger);
}

.dvp-kpi-sub {
  font-size: 11px;
  color: var(--color-text-secondary);
}

/* 双栏主区：月历 + 7 天连胜轨道 */
.dvp-overview-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}

@media (max-width: 820px) {
  .dvp-overview-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

/* 紧凑当月打卡日历网格 */
.dvp-cal-weekdays {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 4px;
  text-align: center;
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.dvp-cal-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 6px;
}

.dvp-cal-cell {
  position: relative;
  height: 36px;
  border-radius: var(--radius-item);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--color-text-main);
  background: transparent;
  transition: background-color 0.14s ease;
}

.dvp-cal-cell.is-empty {
  pointer-events: none;
}

.dvp-cal-cell.is-future {
  color: var(--color-text-secondary);
  opacity: 0.45;
}

.dvp-cal-cell.is-claimed {
  background: var(--control-active-bg);
  color: var(--color-primary-text);
}

.dvp-cal-cell.is-failed {
  background: color-mix(in srgb, var(--state-danger) 12%, transparent);
  color: var(--state-danger);
}

.dvp-cal-cell.is-today {
  box-shadow: inset 0 0 0 1.5px var(--color-primary);
}

.dvp-cal-dot {
  width: 4px;
  height: 4px;
  border-radius: 999px;
  background: currentColor;
}

.dvp-cal-legend {
  display: flex;
  align-items: center;
  gap: 14px;
  font-size: 11px;
  color: var(--color-text-secondary);
}

.dvp-cal-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.dvp-legend-swatch {
  width: 10px;
  height: 10px;
  border-radius: var(--radius-detail);
  background: var(--control-muted-bg);
}

.dvp-legend-swatch.is-claimed {
  background: var(--color-primary);
}

.dvp-legend-swatch.is-today {
  background: transparent;
  box-shadow: inset 0 0 0 1.5px var(--color-primary);
}

.dvp-legend-swatch.is-failed {
  background: var(--state-danger);
}

/* 7 天连胜轨道 */
.dvp-streak-nodes {
  display: flex;
  align-items: center;
  justify-content: space-between;
  position: relative;
  padding: 6px 4px 2px;
}

.dvp-streak-nodes::before {
  content: "";
  position: absolute;
  top: 17px;
  left: 16px;
  right: 16px;
  height: 2px;
  background: var(--control-track-bg);
  z-index: 1;
}

.dvp-streak-node {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  position: relative;
  z-index: 2;
}

.dvp-node-dot {
  width: 24px;
  height: 24px;
  border-radius: 999px;
  background: var(--bg-main);
  box-shadow: inset 0 0 0 1.5px var(--border-subtle);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  color: var(--color-text-secondary);
  font-variant-numeric: tabular-nums;
}

.dvp-streak-node.is-done .dvp-node-dot {
  background: var(--color-primary);
  box-shadow: none;
  color: var(--color-on-primary);
}

.dvp-streak-node.is-active .dvp-node-dot {
  box-shadow: inset 0 0 0 1.5px var(--color-primary);
  color: var(--color-primary-text);
}

.dvp-node-label {
  font-size: 10px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

/* 快捷信息列表（侧栏信息项） */
.dvp-kv-list {
  display: flex;
  flex-direction: column;
}

.dvp-kv-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 0;
  font-size: 12.5px;
}

.dvp-kv-row + .dvp-kv-row {
  border-top: 1px solid var(--border-subtle);
}

.dvp-kv-key {
  color: var(--color-text-secondary);
}

.dvp-kv-val {
  color: var(--color-text-main);
  font-weight: 600;
}

/* 流水筛选与无边框行 */
.dvp-filter-bar {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.dvp-filter-btn {
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: var(--radius-control);
  cursor: pointer;
  transition: background-color 0.14s ease, color 0.14s ease;
}

.dvp-filter-btn:hover {
  background: var(--row-hover-bg);
  color: var(--color-text-main);
}

.dvp-filter-btn.is-active {
  background: var(--control-active-bg);
  color: var(--color-primary-text);
}

.dvp-log-list {
  display: flex;
  flex-direction: column;
}

.dvp-log-list-scroll {
  max-height: 220px;
  overflow-y: auto;
}

.dvp-log-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-radius: var(--radius-item);
  background: transparent;
  transition: background-color 0.14s ease;
}

.dvp-log-row:hover {
  background: var(--row-hover-bg);
}

.dvp-log-left {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.dvp-log-date-line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.dvp-log-date {
  font-size: 13px;
  font-weight: 650;
  color: var(--color-text-main);
  font-variant-numeric: tabular-nums;
}

.dvp-log-time {
  font-size: 11.5px;
  color: var(--color-text-secondary);
  font-variant-numeric: tabular-nums;
}

.dvp-log-msg {
  font-size: 12px;
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dvp-log-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.dvp-log-ms {
  font-size: 11px;
  color: var(--color-text-secondary);
  font-variant-numeric: tabular-nums;
}

.dvp-empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 40px 20px;
  text-align: center;
  color: var(--color-text-secondary);
  font-size: 13px;
}

/* 原生 Dialog 账本宽度控制 */
.dialog-content.dvp-ledger-dialog {
  width: min(560px, 92vw);
  max-width: 92vw;
}

.dvp-dialog-stack {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.dvp-dialog-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 14px;
  border-radius: var(--radius-item);
  background: var(--content-panel-bg);
}

.dvp-dialog-summary-left {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 13px;
  font-weight: 650;
  color: var(--color-text-main);
}

/* 个人中心 / 设置页嵌入式原生卡片（严格对齐 Profile.vue .profile-details） */
.dvp-profile-card {
  border: none;
  border-radius: var(--radius-card);
  background: var(--content-panel-bg);
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  color: var(--color-text-main);
}

.dvp-profile-card.is-inline {
  padding: 14px 16px;
  margin-top: 10px;
}

.dvp-card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.dvp-card-lead {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.dvp-card-icon {
  width: 36px;
  height: 36px;
  border-radius: var(--radius-item);
  background: var(--control-active-bg);
  color: var(--color-primary-text);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.dvp-card-title {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  color: var(--color-text-main);
  line-height: 1.3;
}

.dvp-card-desc {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--color-text-secondary);
}

.dvp-card-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.dvp-pill-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.dvp-records-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 10px;
  border-top: 1px solid var(--border-subtle);
  font-size: 12px;
  color: var(--color-text-secondary);
}

.dvp-link-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 600;
  padding: 3px 8px;
  border-radius: var(--radius-control);
  cursor: pointer;
  transition: background-color 0.14s ease, color 0.14s ease;
}

.dvp-link-btn:hover:not(:disabled) {
  background: var(--row-hover-bg);
  color: var(--color-text-main);
}

.dvp-link-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.dvp-month-list {
  display: flex;
  flex-direction: column;
  max-height: 168px;
  overflow-y: auto;
}

.dvp-month-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 10px;
  border-radius: var(--radius-item);
  font-size: 12px;
}

.dvp-month-row:hover {
  background: var(--row-hover-bg);
}

.dvp-month-date {
  color: var(--color-text-main);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.dvp-month-label {
  color: var(--color-primary-text);
  font-weight: 600;
}

/* 设置面板原生分组 */
.dvp-settings-root {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.dvp-settings-group {
  border: none;
  border-radius: var(--radius-card);
  background: var(--content-panel-bg);
  overflow: hidden;
}

.dvp-setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 16px;
}

.dvp-setting-row + .dvp-setting-row {
  border-top: 1px solid var(--border-subtle);
}

.dvp-setting-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.dvp-setting-label {
  font-size: 13px;
  font-weight: 650;
  color: var(--color-text-main);
}

.dvp-setting-hint {
  font-size: 11.5px;
  color: var(--color-text-secondary);
  line-height: 1.45;
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

// ---- 共用视图渲染积木 ----

const STEP_META = [
  { key: 'baseVip', label: '基础畅听 VIP', order: 1 },
  { key: 'upgrade', label: '特权升级', order: 2 },
  { key: 'conceptAd', label: '广告打卡', order: 3, isConcept: true },
  { key: 'conceptListen', label: '听歌打卡', order: 4, isConcept: true },
];

const getStepCaption = (state, isConcept, enableConceptTasks) => {
  if (isConcept && !enableConceptTasks) return '已关闭';
  switch (state) {
    case 'running':
      return '执行中';
    case 'success':
      return '已完成';
    case 'already':
      return '今日已领';
    case 'failed':
      return '未成功';
    case 'skipped':
      return '已跳过';
    default:
      return '待执行';
  }
};

const renderStepStrip = (h, steps, enableConceptTasks, compact = false) =>
  h(
    'div',
    { class: compact ? 'dvp-steps-grid dvp-steps-grid-compact' : 'dvp-steps-grid' },
    STEP_META.map((item) => {
      const rawState = steps?.[item.key] || 'idle';
      const state = item.isConcept && !enableConceptTasks ? 'skipped' : rawState;
      const isDone = state === 'success' || state === 'already';
      const isRunning = state === 'running';
      const isFailed = state === 'failed';
      const isSkipped = state === 'skipped';

      let dotChild = String(item.order);
      if (isRunning) dotChild = iconSvg(h, ICONS.loader, { size: 12, className: 'dvp-spin' });
      else if (isDone) dotChild = iconSvg(h, ICONS.check, { size: 12 });
      else if (isFailed) dotChild = iconSvg(h, ICONS.close, { size: 12 });
      else if (isSkipped) dotChild = iconSvg(h, ICONS.minus, { size: 12 });

      return h(
        'div',
        {
          key: item.key,
          class: [
            'dvp-step-item',
            isDone ? 'is-done' : '',
            isRunning ? 'is-running' : '',
            isFailed ? 'is-failed' : '',
            isSkipped ? 'is-skipped' : '',
          ],
        },
        [
          h('span', { class: 'dvp-step-dot' }, dotChild),
          h('div', { class: 'dvp-step-copy' }, [
            h('span', { class: 'dvp-step-name' }, item.label),
            h('span', { class: 'dvp-step-state' }, getStepCaption(state, item.isConcept, enableConceptTasks)),
          ]),
        ],
      );
    }),
  );

const renderStreakRail = (h, streakDays) =>
  h('div', { class: 'dvp-streak-nodes' }, [
    ...[1, 2, 3, 4, 5, 6, 7].map((dayNum) => {
      const cur = Number(streakDays) || 0;
      const isDone = cur >= dayNum;
      const isActive = cur + 1 === dayNum;
      return h(
        'div',
        {
          key: dayNum,
          class: ['dvp-streak-node', isDone ? 'is-done' : isActive ? 'is-active' : ''],
          title: isDone ? `第 ${dayNum} 天已完成` : `连续打卡第 ${dayNum} 天`,
        },
        [
          h(
            'span',
            { class: 'dvp-node-dot' },
            isDone ? iconSvg(h, ICONS.check, { size: 11 }) : String(dayNum),
          ),
          h('span', { class: 'dvp-node-label' }, `D${dayNum}`),
        ],
      );
    }),
  ]);

const renderMetricNumber = (h, RollingNumber, value) => {
  if (RollingNumber) {
    return h(RollingNumber, { value: String(value) });
  }
  return String(value);
};

const renderLedgerRow = (h, log) => {
  const isSuccess = log.status === 'success';
  return h('div', { class: 'dvp-log-row', key: log.id || `${log.claim_date}-${log.claimed_at}` }, [
    h('div', { class: 'dvp-log-left' }, [
      h('div', { class: 'dvp-log-date-line' }, [
        h('span', { class: 'dvp-log-date' }, log.claim_date || '--'),
        h('span', { class: 'dvp-log-time' }, formatTimeOfDay(log.claimed_at)),
      ]),
      h('div', { class: 'dvp-log-msg' }, log.message || (isSuccess ? '已领取畅听会员' : '打卡未成功')),
    ]),
    h('div', { class: 'dvp-log-right' }, [
      log.duration_ms ? h('span', { class: 'dvp-log-ms' }, `${log.duration_ms}ms`) : null,
      log.concept_task_status
        ? h('span', { class: 'dvp-pill dvp-pill-primary' }, '概念任务')
        : null,
      h(
        'span',
        { class: ['dvp-pill', isSuccess ? 'dvp-pill-success' : 'dvp-pill-danger'] },
        !isSuccess ? '失败' : log.upgrade_status ? '已升级' : '已领取',
      ),
    ]),
  ]);
};

// ---- 宿主异步组件解析 ----

const resolveHostComponent = (ctx, name, fallback) => {
  const loader = ctx.ui?.components?.[name];
  if (typeof loader === 'function') {
    return ctx.vue.defineAsyncComponent(loader);
  }
  return fallback || null;
};

// ---- 原生 Dialog 畅听账本 ----

const createLedgerDialog = (ctx, comps) => {
  const { h, defineComponent, ref } = ctx.vue;
  const { Dialog, Button, RollingNumber } = comps;

  return defineComponent({
    name: 'daily-vip-ledger-dialog',
    setup() {
      const visible = ref(false);
      const claimResultTone = ref('idle'); // 'idle' | 'success' | 'error'
      let feedbackTimer = null;

      const refresh = async () => {
        await updateBadges(ctx, { force: true });
      };

      ledgerModalState.open = async () => {
        visible.value = true;
        claimResultTone.value = 'idle';
        await updateBadges(ctx);
      };

      ledgerModalState.close = () => {
        visible.value = false;
      };

      const handleOpenFullPage = () => {
        visible.value = false;
        ctx.router?.push?.('/main/plugin/daily-vip-claim/claim');
      };

      const handleClaimFromDialog = async () => {
        if (runtime.loggedIn === false) {
          visible.value = false;
          ctx.router?.push?.('/login');
          return;
        }
        if (feedbackTimer) {
          clearTimeout(feedbackTimer);
          feedbackTimer = null;
        }
        claimResultTone.value = 'idle';
        const res = await claimNow(ctx);
        if (res && res.ok) {
          claimResultTone.value = 'success';
          feedbackTimer = setTimeout(() => {
            claimResultTone.value = 'idle';
            feedbackTimer = null;
          }, 2600);
        } else {
          claimResultTone.value = 'error';
        }
      };

      const renderDialogBody = () => {
        const recent = (runtime.recentLogs || []).slice(0, 12);
        return h('div', { class: 'dvp-dialog-stack' }, [
          // 账号与到期概览条
          h('div', { class: 'dvp-dialog-summary' }, [
            h('div', { class: 'dvp-dialog-summary-left' }, [
              iconSvg(h, ICONS.crown, { size: 15 }),
              h('span', null, `畅听 VIP · ${runtime.vipExpiry}`),
              runtime.loggedIn === false
                ? h('span', { class: 'dvp-pill dvp-pill-warning' }, '未登录')
                : runtime.claimedToday
                  ? h('span', { class: 'dvp-pill dvp-pill-success' }, '今日已领')
                  : h('span', { class: 'dvp-pill dvp-pill-primary' }, '今日待领'),
            ]),
            h('span', { class: 'dvp-pill' }, runtime.userId ? `ID ${runtime.userId}` : '当前账号'),
          ]),

          // 失败告警（绝不假阳性）
          runtime.lastError
            ? h('div', { class: 'dvp-error-banner', role: 'alert' }, [
                iconSvg(h, ICONS.alert, { size: 15 }),
                h('span', null, runtime.lastError),
              ])
            : null,

          // 4 步状态分解
          h('div', { class: 'dvp-panel dvp-panel-compact' }, [
            h('div', { class: 'dvp-panel-head' }, [
              h('span', { class: 'dvp-panel-title' }, '今日 4 步打卡进度'),
              h(
                'span',
                { class: 'dvp-panel-subtitle' },
                runtime.enableConceptTasks ? '含概念版子任务' : '仅基础与升级',
              ),
            ]),
            renderStepStrip(h, runtime.steps, runtime.enableConceptTasks, true),
          ]),

          // 3 项核心统计
          h('div', { class: 'dvp-kpi-grid-3' }, [
            h('div', { class: 'dvp-kpi-card' }, [
              h('div', { class: 'dvp-kpi-label' }, [
                iconSvg(h, ICONS.gift, { size: 12 }),
                h('span', null, '累计打卡'),
              ]),
              h('div', { class: 'dvp-kpi-value is-accent' }, [
                renderMetricNumber(h, RollingNumber, `${runtime.totalSuccess} 天`),
              ]),
            ]),
            h('div', { class: 'dvp-kpi-card' }, [
              h('div', { class: 'dvp-kpi-label' }, [
                iconSvg(h, ICONS.flame, { size: 12 }),
                h('span', null, '连续签到'),
              ]),
              h('div', { class: 'dvp-kpi-value' }, [
                renderMetricNumber(h, RollingNumber, `${runtime.streakDays} 天`),
              ]),
            ]),
            h('div', { class: 'dvp-kpi-card' }, [
              h('div', { class: 'dvp-kpi-label' }, [
                iconSvg(h, ICONS.coin, { size: 12 }),
                h('span', null, '累计节省约'),
              ]),
              h('div', { class: 'dvp-kpi-value' }, [
                renderMetricNumber(h, RollingNumber, `¥${runtime.savedMoney}`),
              ]),
            ]),
          ]),

          // 7 天连胜轨道
          h('div', { class: 'dvp-panel dvp-panel-compact' }, [
            h('div', { class: 'dvp-panel-head' }, [
              h('span', { class: 'dvp-panel-title' }, [
                iconSvg(h, ICONS.flame, { size: 13 }),
                h('span', null, '7 天连胜轨道'),
              ]),
              h('span', { class: 'dvp-panel-subtitle' }, `当前连续 ${runtime.streakDays} 天`),
            ]),
            renderStreakRail(h, runtime.streakDays),
          ]),

          // 最近流水
          h('div', { class: 'dvp-panel dvp-panel-compact' }, [
            h('div', { class: 'dvp-panel-head' }, [
              h('span', { class: 'dvp-panel-title' }, '最近打卡流水'),
              h('span', { class: 'dvp-panel-subtitle' }, `共 ${runtime.recentLogs.length} 条`),
            ]),
            recent.length === 0
              ? h('div', { class: 'dvp-empty-state', style: 'padding: 20px 12px;' }, [
                  h('span', null, '暂无本地打卡记录，点击下方按钮即可执行打卡'),
                ])
              : h(
                  'div',
                  { class: 'dvp-log-list dvp-log-list-scroll' },
                  recent.map((log) => renderLedgerRow(h, log)),
                ),
          ]),
        ]);
      };

      const renderFooter = () => {
        const isLoggedOut = runtime.loggedIn === false;
        const isClaimed = runtime.claimedToday;
        const claimLabel = isLoggedOut
          ? '去登录'
          : runtime.isClaiming
            ? isClaimed
              ? '正在补同步...'
              : '正在打卡...'
            : claimResultTone.value === 'success'
              ? '同步完成'
              : isClaimed
                ? '今日已领 · 补同步'
                : '立即全套打卡';

        const primaryVariant = isLoggedOut
          ? 'soft-primary'
          : isClaimed
            ? 'soft-secondary'
            : 'soft-primary';

        return [
          h(
            Button,
            {
              variant: 'soft-secondary',
              size: 'default',
              onClick: () => {
                visible.value = false;
              },
            },
            { default: () => '关闭' },
          ),
          h(
            Button,
            {
              variant: primaryVariant,
              size: 'default',
              loading: runtime.isClaiming,
              disabled: runtime.isClaiming,
              onClick: handleClaimFromDialog,
            },
            {
              default: () =>
                h('span', { class: 'dvp-btn-content' }, [
                  !runtime.isClaiming
                    ? iconSvg(
                        h,
                        claimResultTone.value === 'success'
                          ? ICONS.check
                          : isClaimed
                            ? ICONS.refresh
                            : ICONS.sparkles,
                        { size: 14 },
                      )
                    : null,
                  h('span', null, claimLabel),
                ]),
            },
          ),
        ];
      };

      return () =>
        h(
          Dialog,
          {
            open: visible.value,
            'onUpdate:open': (val) => {
              visible.value = Boolean(val);
            },
            title: '每日畅听会员账本',
            description: 'SQLite 本地流水 · 每日 1 天畅听会员与特权续期',
            showClose: true,
            contentClass: 'dvp-ledger-dialog',
          },
          {
            headerActions: () => [
              h(
                Button,
                {
                  variant: 'ghost',
                  size: 'compact',
                  tooltip: '打开打卡主页',
                  onClick: handleOpenFullPage,
                },
                {
                  default: () =>
                    h('span', { class: 'dvp-btn-content' }, [
                      iconSvg(h, ICONS.external, { size: 13 }),
                      h('span', null, '主页'),
                    ]),
                },
              ),
              h(
                Button,
                {
                  variant: 'ghost',
                  size: 'icon',
                  tooltip: '刷新账本',
                  disabled: runtime.isRefreshing,
                  onClick: refresh,
                },
                {
                  default: () =>
                    iconSvg(h, ICONS.refresh, {
                      size: 14,
                      className: runtime.isRefreshing ? 'dvp-spin' : '',
                    }),
                },
              ),
            ],
            default: renderDialogBody,
            footer: renderFooter,
          },
        );
    },
  });
};

// ---- 个人中心 & 设置页嵌入式原生卡片（对齐 Profile.vue） ----

const createClaimCard = (ctx, comps) => {
  const { h, defineComponent, ref, onMounted } = ctx.vue;
  const { Button } = comps;

  return defineComponent({
    name: 'daily-vip-claim-card',
    props: {
      variant: { type: String, default: 'card' },
    },
    setup(props) {
      const showRecords = ref(false);
      const isLoadingRecords = ref(false);

      const loadRecords = async () => {
        if (isLoadingRecords.value) return;
        isLoadingRecords.value = true;
        try {
          await updateBadges(ctx, { force: true });
          showRecords.value = true;
          if (runtime.monthRecords.length === 0) {
            ctx.toast?.info?.('本月暂无领取记录');
          }
        } catch (error) {
          console.warn('[daily-vip-claim] 加载领取记录失败:', error);
          ctx.toast?.danger?.(getApiErrorMessage(error, '加载领取记录失败'));
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
        if (runtime.isClaiming) return;
        const res = await claimNow(ctx);
        if (res && res.ok && showRecords.value) {
          await updateBadges(ctx, { force: true });
        }
      };

      onMounted(() => {
        if (!runtime.updatedAt) {
          void updateBadges(ctx);
        }
      });

      return () => {
        const isLoggedOut = runtime.loggedIn === false;
        const isClaimed = runtime.claimedToday;
        const expiryTone =
          runtime.vipExpiry === '已过期'
            ? 'dvp-pill-danger'
            : runtime.vipExpiry !== '--'
              ? 'dvp-pill-primary'
              : '';

        return h(
          'div',
          { class: ['dvp-profile-card', props.variant === 'inline' ? 'is-inline' : ''] },
          [
            h('div', { class: 'dvp-card-top' }, [
              h('div', { class: 'dvp-card-lead' }, [
                h('div', { class: 'dvp-card-icon' }, [
                  iconSvg(h, ctx.icons?.iconGift || ICONS.gift, { size: 17 }),
                ]),
                h('div', null, [
                  h('h4', { class: 'dvp-card-title' }, '每日畅听会员'),
                  h(
                    'p',
                    { class: 'dvp-card-desc' },
                    isLoggedOut ? '登录后可每日领取 1 天畅听会员' : '每日领取 1 天畅听会员与特权续期',
                  ),
                ]),
              ]),
              isLoggedOut
                ? h(
                    Button,
                    {
                      variant: 'soft-primary',
                      size: 'xs',
                      onClick: () => ctx.router?.push?.('/login'),
                    },
                    { default: () => '去登录' },
                  )
                : h('div', { class: 'dvp-card-actions' }, [
                    h(
                      Button,
                      {
                        variant: 'ghost',
                        size: 'xs',
                        onClick: () => {
                          void ledgerModalState.open?.();
                        },
                      },
                      { default: () => '账本' },
                    ),
                    h(
                      Button,
                      {
                        variant: isClaimed ? 'soft-secondary' : 'soft-primary',
                        size: 'xs',
                        loading: runtime.isClaiming,
                        disabled: runtime.isClaiming,
                        onClick: handleClaim,
                      },
                      {
                        default: () =>
                          runtime.isClaiming
                            ? isClaimed
                              ? '同步中'
                              : '领取中'
                            : isClaimed
                              ? '今日已领 · 补同步'
                              : '领取 1 天',
                      },
                    ),
                  ]),
            ]),

            // 干净的柔和胶囊标签（替代冗长 `·` 拼接）
            !isLoggedOut
              ? h('div', { class: 'dvp-pill-row' }, [
                  h('span', { class: ['dvp-pill', expiryTone] }, `畅听 VIP · ${runtime.vipExpiry}`),
                  h(
                    'span',
                    { class: ['dvp-pill', isClaimed ? 'dvp-pill-success' : 'dvp-pill-warning'] },
                    isClaimed ? '今日已领' : '今日待领',
                  ),
                  runtime.monthCount != null
                    ? h('span', { class: 'dvp-pill' }, `本月 ${runtime.monthCount} 天`)
                    : null,
                  runtime.streakDays > 0
                    ? h('span', { class: 'dvp-pill' }, `连胜 ${runtime.streakDays} 天`)
                    : null,
                  runtime.savedMoney > 0
                    ? h('span', { class: 'dvp-pill' }, `省约 ¥${runtime.savedMoney}`)
                    : null,
                ])
              : null,

            // 失败提示
            !isLoggedOut && runtime.lastError
              ? h('div', { class: 'dvp-error-banner', role: 'alert' }, [
                  iconSvg(h, ICONS.alert, { size: 14 }),
                  h('span', null, runtime.lastError),
                ])
              : null,

            // 当月领取记录折叠区
            !isLoggedOut
              ? h('div', { class: 'dvp-records-foot' }, [
                  h('span', null, '当月领取记录'),
                  h(
                    'button',
                    {
                      type: 'button',
                      class: 'dvp-link-btn',
                      disabled: isLoadingRecords.value,
                      onClick: toggleRecords,
                    },
                    [
                      iconSvg(h, ICONS.refresh, {
                        size: 12,
                        className: isLoadingRecords.value ? 'dvp-spin' : '',
                      }),
                      h('span', null, showRecords.value ? '收起' : '查看'),
                    ],
                  ),
                ])
              : null,

            !isLoggedOut && showRecords.value
              ? h('div', { class: 'dvp-month-list' }, [
                  runtime.monthRecords.length === 0
                    ? h('div', { class: 'dvp-empty-state', style: 'padding: 16px 8px;' }, '本月暂无领取记录')
                    : runtime.monthRecords.map((record, index) =>
                        h('div', { class: 'dvp-month-row', key: `${record.date}-${index}` }, [
                          h('span', { class: 'dvp-month-date' }, record.date),
                          h('span', { class: 'dvp-month-label' }, record.label),
                        ]),
                      ),
                ])
              : null,
          ],
        );
      };
    },
  });
};

// ---- 独立页面 ClaimPage（SliverHeader + 吸顶下划线 Tabs + 月历 + 流水） ----

const createClaimPage = (ctx, comps) => {
  const { h, defineComponent, ref, computed, onMounted } = ctx.vue;
  const {
    Button,
    PageScrollContainer,
    DetailPageSliverHeader,
    PageStickyHeader,
    Tabs,
    TabsList,
    TabsTrigger,
    TabsContent,
    Popconfirm,
    RollingNumber,
  } = comps;

  const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

  return defineComponent({
    name: 'daily-vip-claim-page',
    setup() {
      const activeTab = ref('overview');
      const logFilter = ref('all'); // 'all' | 'success' | 'failed'
      const clearingLogs = ref(false);
      const sliverHeaderRef = ref(null);

      const tabsTop = computed(() => sliverHeaderRef.value?.currentHeight ?? 56);

      const coverUrl = computed(() => {
        try {
          if (ctx.cover && typeof ctx.cover.createThemedIconCoverUrl === 'function') {
            return ctx.cover.createThemedIconCoverUrl({
              icon: ctx.icons?.iconGift || ICONS.gift,
            });
          }
        } catch {}
        return buildFallbackCoverUrl();
      });

      const calendarData = computed(() => {
        const claimedSet = new Set();
        const failedSet = new Set();
        for (const rec of runtime.monthRecords || []) {
          if (rec && rec.date) claimedSet.add(rec.date);
        }
        for (const row of runtime.recentLogs || []) {
          if (!row || !row.claim_date) continue;
          if (row.status === 'success') claimedSet.add(row.claim_date);
          else failedSet.add(row.claim_date);
        }
        return buildMonthCalendar(claimedSet, failedSet);
      });

      const filteredLogs = computed(() => {
        const list = runtime.recentLogs || [];
        if (logFilter.value === 'success') return list.filter((item) => item.status === 'success');
        if (logFilter.value === 'failed') return list.filter((item) => item.status !== 'success');
        return list;
      });

      const handleRefresh = async () => {
        await updateBadges(ctx, { force: true });
      };

      const handleClaim = async () => {
        if (runtime.loggedIn === false) {
          ctx.router?.push?.('/login');
          return;
        }
        await claimNow(ctx);
      };

      const handleClearLogs = async () => {
        if (clearingLogs.value) return;
        clearingLogs.value = true;
        try {
          const uid = readUserId(ctx);
          const res = await clearLedgerForUser(uid);
          if (res.ok) {
            ctx.toast?.success?.('已清空当前账号的本地领取流水');
            await updateBadges(ctx);
          } else {
            ctx.toast?.danger?.(res.error || '清空失败');
          }
        } finally {
          clearingLogs.value = false;
        }
      };

      onMounted(() => {
        void updateBadges(ctx);
      });

      const renderOverviewTab = () => {
        if (runtime.loggedIn === false) {
          return h('div', { class: 'dvp-tab-body' }, [
            h('div', { class: 'dvp-panel' }, [
              h('div', { class: 'dvp-empty-state' }, [
                iconSvg(h, ICONS.user, { size: 44 }),
                h('div', { style: 'font-size: 15px; font-weight: 700; color: var(--color-text-main);' }, '请先登录酷狗账号'),
                h('div', null, '登录后即可一键领取每日 1 天畅听会员并自动记录打卡日历'),
                h(
                  Button,
                  {
                    variant: 'soft-primary',
                    size: 'default',
                    onClick: () => ctx.router?.push?.('/login'),
                  },
                  { default: () => '去登录' },
                ),
              ]),
            ]),
          ]);
        }

        const cal = calendarData.value;
        const expiryClass =
          runtime.vipExpiry === '已过期'
            ? 'dvp-kpi-value is-danger'
            : runtime.vipExpiry !== '--'
              ? 'dvp-kpi-value is-accent'
              : 'dvp-kpi-value';

        return h('div', { class: 'dvp-tab-body' }, [
          // 错误横幅（仅失败时显示）
          runtime.lastError
            ? h('div', { class: 'dvp-error-banner', role: 'alert' }, [
                iconSvg(h, ICONS.alert, { size: 15 }),
                h('span', null, runtime.lastError),
              ])
            : null,

          // 4 步实时状态条
          h('div', { class: 'dvp-panel' }, [
            h('div', { class: 'dvp-panel-head' }, [
              h('h3', { class: 'dvp-panel-title' }, [
                iconSvg(h, ICONS.sparkles, { size: 15 }),
                h('span', null, '今日 4 步打卡状态'),
              ]),
              h(
                'span',
                {
                  class: [
                    'dvp-pill',
                    runtime.claimedToday ? 'dvp-pill-success' : 'dvp-pill-warning',
                  ],
                },
                runtime.claimedToday ? '今日已领取' : '今日尚未领取',
              ),
            ]),
            renderStepStrip(h, runtime.steps, runtime.enableConceptTasks, false),
          ]),

          // 4 格 KPI 统计（接入 RollingNumber）
          h('div', { class: 'dvp-kpi-grid-4' }, [
            h('div', { class: 'dvp-kpi-card' }, [
              h('div', { class: 'dvp-kpi-label' }, [
                iconSvg(h, ICONS.crown, { size: 13 }),
                h('span', null, '畅听会员'),
              ]),
              h('div', { class: expiryClass }, runtime.vipExpiry),
              h('div', { class: 'dvp-kpi-sub' }, runtime.userId ? `账号 ${runtime.userId}` : '当前登录账号'),
            ]),
            h('div', { class: 'dvp-kpi-card' }, [
              h('div', { class: 'dvp-kpi-label' }, [
                iconSvg(h, ICONS.gift, { size: 13 }),
                h('span', null, '累计打卡'),
              ]),
              h('div', { class: 'dvp-kpi-value is-accent' }, [
                renderMetricNumber(h, RollingNumber, `${runtime.totalSuccess} 天`),
              ]),
              h('div', { class: 'dvp-kpi-sub' }, 'SQLite 本地统计'),
            ]),
            h('div', { class: 'dvp-kpi-card' }, [
              h('div', { class: 'dvp-kpi-label' }, [
                iconSvg(h, ICONS.flame, { size: 13 }),
                h('span', null, '连续签到'),
              ]),
              h('div', { class: 'dvp-kpi-value' }, [
                renderMetricNumber(h, RollingNumber, `${runtime.streakDays} 天`),
              ]),
              h('div', { class: 'dvp-kpi-sub' }, '保持每日续期'),
            ]),
            h('div', { class: 'dvp-kpi-card' }, [
              h('div', { class: 'dvp-kpi-label' }, [
                iconSvg(h, ICONS.coin, { size: 13 }),
                h('span', null, '累计节省约'),
              ]),
              h('div', { class: 'dvp-kpi-value' }, [
                renderMetricNumber(h, RollingNumber, `¥${runtime.savedMoney}`),
              ]),
              h('div', { class: 'dvp-kpi-sub' }, '按 ¥0.5/天 估算'),
            ]),
          ]),

          // 当月打卡日历 + 7 天连胜轨道与状态概览
          h('div', { class: 'dvp-overview-grid' }, [
            // 左：当月打卡日历
            h('div', { class: 'dvp-panel' }, [
              h('div', { class: 'dvp-panel-head' }, [
                h('h3', { class: 'dvp-panel-title' }, [
                  iconSvg(h, ICONS.calendar, { size: 15 }),
                  h('span', null, `${cal.monthLabel}打卡日历`),
                ]),
                h('span', { class: 'dvp-panel-subtitle' }, `已打卡 ${cal.claimedInMonth} / ${cal.daysInMonth} 天`),
              ]),
              h(
                'div',
                { class: 'dvp-cal-weekdays' },
                WEEKDAYS.map((w) => h('span', { key: w }, w)),
              ),
              h(
                'div',
                { class: 'dvp-cal-grid' },
                cal.cells.map((cell) => {
                  if (cell.empty) {
                    return h('div', { class: 'dvp-cal-cell is-empty', key: cell.key });
                  }
                  return h(
                    'div',
                    {
                      key: cell.key,
                      class: [
                        'dvp-cal-cell',
                        cell.isClaimed ? 'is-claimed' : '',
                        cell.isFailed ? 'is-failed' : '',
                        cell.isToday ? 'is-today' : '',
                        cell.isFuture ? 'is-future' : '',
                      ],
                      title: `${cell.dateStr} · ${
                        cell.isClaimed ? '已打卡' : cell.isFailed ? '打卡失败' : cell.isFuture ? '未到日期' : '未打卡'
                      }`,
                    },
                    [
                      h('span', null, String(cell.day)),
                      cell.isClaimed || cell.isFailed ? h('span', { class: 'dvp-cal-dot' }) : null,
                    ],
                  );
                }),
              ),
              h('div', { class: 'dvp-cal-legend' }, [
                h('span', { class: 'dvp-cal-legend-item' }, [
                  h('span', { class: 'dvp-legend-swatch is-claimed' }),
                  h('span', null, '已打卡'),
                ]),
                h('span', { class: 'dvp-cal-legend-item' }, [
                  h('span', { class: 'dvp-legend-swatch is-today' }),
                  h('span', null, '今天'),
                ]),
                h('span', { class: 'dvp-cal-legend-item' }, [
                  h('span', { class: 'dvp-legend-swatch is-failed' }),
                  h('span', null, '失败'),
                ]),
              ]),
            ]),

            // 右：7 天连胜轨道 + 自动化状态
            h('div', { style: 'display: flex; flex-direction: column; gap: 16px;' }, [
              h('div', { class: 'dvp-panel' }, [
                h('div', { class: 'dvp-panel-head' }, [
                  h('h3', { class: 'dvp-panel-title' }, [
                    iconSvg(h, ICONS.flame, { size: 15 }),
                    h('span', null, '7 天连胜轨道'),
                  ]),
                  h('span', { class: 'dvp-panel-subtitle' }, `当前连胜 ${runtime.streakDays} 天`),
                ]),
                renderStreakRail(h, runtime.streakDays),
              ]),
              h('div', { class: 'dvp-panel' }, [
                h('div', { class: 'dvp-panel-head' }, [
                  h('h3', { class: 'dvp-panel-title' }, '自动化守护状态'),
                ]),
                h('div', { class: 'dvp-kv-list' }, [
                  h('div', { class: 'dvp-kv-row' }, [
                    h('span', { class: 'dvp-kv-key' }, '启动后自动领取'),
                    h(
                      'span',
                      {
                        class: ['dvp-pill', runtime.autoClaim ? 'dvp-pill-success' : ''],
                      },
                      runtime.autoClaim ? '已开启' : '未开启',
                    ),
                  ]),
                  h('div', { class: 'dvp-kv-row' }, [
                    h('span', { class: 'dvp-kv-key' }, '概念版子任务（广告/听歌）'),
                    h(
                      'span',
                      {
                        class: ['dvp-pill', runtime.enableConceptTasks ? 'dvp-pill-primary' : ''],
                      },
                      runtime.enableConceptTasks ? '已启用' : '已关闭',
                    ),
                  ]),
                  h('div', { class: 'dvp-kv-row' }, [
                    h('span', { class: 'dvp-kv-key' }, '播放栏天数胶囊'),
                    h(
                      'span',
                      {
                        class: ['dvp-pill', runtime.playerbarBadge ? 'dvp-pill-primary' : ''],
                      },
                      runtime.playerbarBadge ? '显示中' : '已隐藏',
                    ),
                  ]),
                ]),
              ]),
            ]),
          ]),
        ]);
      };

      const renderClearButton = () => {
        const triggerBtn = h(
          Button,
          {
            variant: 'ghost',
            size: 'compact',
            disabled: clearingLogs.value || (runtime.recentLogs || []).length === 0,
          },
          {
            default: () =>
              h('span', { class: 'dvp-btn-content' }, [
                iconSvg(h, ICONS.trash, { size: 13 }),
                h('span', null, '清空流水'),
              ]),
          },
        );
        if (Popconfirm) {
          return h(
            Popconfirm,
            {
              title: '清空当前账号的本地领取流水？',
              description: '仅清理本地 SQLite 账本记录，不影响已获得的酷狗会员时长。',
              confirmText: '确认清空',
              cancelText: '取消',
              tone: 'danger',
              disabled: clearingLogs.value || (runtime.recentLogs || []).length === 0,
              confirmLoading: clearingLogs.value,
              onConfirm: handleClearLogs,
            },
            { trigger: () => triggerBtn },
          );
        }
        return h(
          Button,
          {
            variant: 'danger',
            size: 'compact',
            disabled: clearingLogs.value || (runtime.recentLogs || []).length === 0,
            onClick: handleClearLogs,
          },
          { default: () => '清空流水' },
        );
      };

      const renderLedgerTab = () => {
        const list = filteredLogs.value;
        return h('div', { class: 'dvp-tab-body' }, [
          h('div', { class: 'dvp-panel' }, [
            h('div', { class: 'dvp-panel-head' }, [
              h('div', { class: 'dvp-filter-bar', role: 'tablist', 'aria-label': '流水状态筛选' }, [
                ...[
                  { key: 'all', label: `全部 (${(runtime.recentLogs || []).length})` },
                  {
                    key: 'success',
                    label: `成功 (${(runtime.recentLogs || []).filter((i) => i.status === 'success').length})`,
                  },
                  {
                    key: 'failed',
                    label: `失败 (${(runtime.recentLogs || []).filter((i) => i.status !== 'success').length})`,
                  },
                ].map((opt) =>
                  h(
                    'button',
                    {
                      key: opt.key,
                      type: 'button',
                      class: ['dvp-filter-btn', logFilter.value === opt.key ? 'is-active' : ''],
                      onClick: () => {
                        logFilter.value = opt.key;
                      },
                    },
                    opt.label,
                  ),
                ),
              ]),
              renderClearButton(),
            ]),
            list.length === 0
              ? h('div', { class: 'dvp-empty-state' }, [
                  iconSvg(h, ICONS.book, { size: 32 }),
                  h(
                    'span',
                    null,
                    logFilter.value === 'all' ? '暂无本地领取流水记录' : '当前筛选条件下暂无记录',
                  ),
                ])
              : h(
                  'div',
                  { class: 'dvp-log-list' },
                  list.map((log) => renderLedgerRow(h, log)),
                ),
          ]),
        ]);
      };

      return () => {
        const isLoggedOut = runtime.loggedIn === false;
        const isClaimed = runtime.claimedToday;
        const claimBtnLabel = isLoggedOut
          ? '去登录'
          : runtime.isClaiming
            ? isClaimed
              ? '正在补同步...'
              : '正在打卡...'
            : isClaimed
              ? '今日已领 · 补同步'
              : '立即全套打卡';

        return h('div', { class: 'dvp-root' }, [
          h(PageScrollContainer, { class: 'dvp-scroll' }, {
            default: () =>
              h('div', { class: 'dvp-page-shell' }, [
                h(
                  DetailPageSliverHeader,
                  {
                    ref: sliverHeaderRef,
                    typeLabel: 'DAILY VIP',
                    title: '每日畅听会员',
                    coverUrl: coverUrl.value,
                    hasDetails: true,
                    distributeDetails: true,
                    expandedHeight: 176,
                    collapsedHeight: 56,
                  },
                  {
                    details: () =>
                      h('div', { class: 'dvp-header-details' }, [
                        h('div', { class: 'dvp-header-line' }, [
                          h('span', null, `畅听 VIP · ${runtime.vipExpiry}`),
                          isLoggedOut
                            ? h('span', { class: 'dvp-pill dvp-pill-warning' }, '未登录')
                            : h(
                                'span',
                                {
                                  class: [
                                    'dvp-pill',
                                    isClaimed ? 'dvp-pill-success' : 'dvp-pill-primary',
                                  ],
                                },
                                isClaimed ? '今日已领' : '今日待领',
                              ),
                        ]),
                        h(
                          'div',
                          { class: 'dvp-header-line' },
                          isLoggedOut
                            ? '登录后可每日自动领取 1 天畅听会员并追踪月历与流水'
                            : `本月已领 ${runtime.monthCount ?? 0} 天 · 连续 ${runtime.streakDays} 天 · 累计省约 ¥${runtime.savedMoney}`,
                        ),
                      ]),
                    actions: () =>
                      h('div', { class: 'dvp-header-actions' }, [
                        h(
                          Button,
                          {
                            variant: !isLoggedOut && isClaimed ? 'soft-secondary' : 'soft-primary',
                            size: 'default',
                            loading: runtime.isClaiming,
                            disabled: runtime.isClaiming,
                            onClick: handleClaim,
                          },
                          {
                            default: () =>
                              h('span', { class: 'dvp-btn-content' }, [
                                !runtime.isClaiming
                                  ? iconSvg(h, isClaimed ? ICONS.refresh : ICONS.sparkles, {
                                      size: 14,
                                    })
                                  : null,
                                h('span', null, claimBtnLabel),
                              ]),
                          },
                        ),
                        h(
                          Button,
                          {
                            variant: 'soft-secondary',
                            size: 'default',
                            disabled: runtime.isRefreshing,
                            onClick: handleRefresh,
                          },
                          {
                            default: () =>
                              h('span', { class: 'dvp-btn-content' }, [
                                iconSvg(h, ICONS.refresh, {
                                  size: 14,
                                  className: runtime.isRefreshing ? 'dvp-spin' : '',
                                }),
                                h('span', null, '刷新状态'),
                              ]),
                          },
                        ),
                        h(
                          Button,
                          {
                            variant: 'ghost',
                            size: 'default',
                            onClick: () => {
                              void ledgerModalState.open?.();
                            },
                          },
                          {
                            default: () =>
                              h('span', { class: 'dvp-btn-content' }, [
                                iconSvg(h, ICONS.book, { size: 14 }),
                                h('span', null, '快捷账本'),
                              ]),
                          },
                        ),
                      ]),
                    'collapsed-actions': () => [
                      h(
                        Button,
                        {
                          variant: 'unstyled',
                          size: 'icon',
                          class: 'action-icon',
                          tooltip: claimBtnLabel,
                          disabled: runtime.isClaiming,
                          onClick: handleClaim,
                        },
                        {
                          default: () =>
                            iconSvg(
                              h,
                              runtime.isClaiming
                                ? ICONS.loader
                                : isClaimed
                                  ? ICONS.refresh
                                  : ICONS.sparkles,
                              {
                                size: 17,
                                className: runtime.isClaiming ? 'dvp-spin' : '',
                              },
                            ),
                        },
                      ),
                      h(
                        Button,
                        {
                          variant: 'unstyled',
                          size: 'icon',
                          class: 'action-icon',
                          tooltip: '刷新状态',
                          disabled: runtime.isRefreshing,
                          onClick: handleRefresh,
                        },
                        {
                          default: () =>
                            iconSvg(h, ICONS.refresh, {
                              size: 16,
                              className: runtime.isRefreshing ? 'dvp-spin' : '',
                            }),
                        },
                      ),
                    ],
                  },
                ),

                h(
                  Tabs,
                  {
                    modelValue: activeTab.value,
                    'onUpdate:modelValue': (val) => {
                      activeTab.value = String(val);
                    },
                  },
                  {
                    default: () => [
                      h(
                        PageStickyHeader,
                        {
                          stickyTop: tabsTop.value,
                          class: 'dvp-sticky-header',
                          style: { top: `${tabsTop.value}px` },
                        },
                        {
                          default: () =>
                            h('div', { class: 'dvp-sticky-inner' }, [
                              h('div', { class: 'dvp-sticky-bar' }, [
                                h(TabsList, { class: 'dvp-tabs-list' }, {
                                  default: () => [
                                    h(TabsTrigger, { value: 'overview' }, {
                                      default: () =>
                                        h('span', { class: 'dvp-tab-label' }, [
                                          h('span', null, '今日与月历'),
                                        ]),
                                    }),
                                    h(TabsTrigger, { value: 'ledger' }, {
                                      default: () =>
                                        h('span', { class: 'dvp-tab-label' }, [
                                          h('span', null, '领取流水'),
                                          h(
                                            'span',
                                            { class: 'dvp-tab-count' },
                                            String((runtime.recentLogs || []).length),
                                          ),
                                        ]),
                                    }),
                                  ],
                                }),
                                h('div', { class: 'dvp-sticky-right' }, [
                                  h(
                                    'span',
                                    { class: 'dvp-sticky-meta' },
                                    `${calendarData.value.monthLabel} · 已打卡 ${calendarData.value.claimedInMonth} 天`,
                                  ),
                                ]),
                              ]),
                            ]),
                        },
                      ),

                      h(TabsContent, { value: 'overview' }, { default: renderOverviewTab }),
                      h(TabsContent, { value: 'ledger' }, { default: renderLedgerTab }),
                    ],
                  },
                ),
              ]),
          }),
        ]);
      };
    },
  });
};

// ---- 个人中心自愈式嵌入（兼容新版 .profile-details 与旧版布局） ----

const injectProfileClaim = (ctx, ClaimCard) => {
  const MOUNT_ID = 'daily-vip-claim-profile';

  let current = null;
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

  const findProfileTarget = () => {
    const details = document.querySelector('.profile-page .profile-details');
    if (details && details.isConnected && details.offsetParent !== null && details.parentElement) {
      return { anchor: details, mode: 'after', variant: 'card' };
    }
    const legacySpaces = document.querySelectorAll('div.space-y-2');
    for (const el of legacySpaces) {
      if (
        el.isConnected &&
        el.offsetParent !== null &&
        el.closest('.profile-page') &&
        el.parentElement?.classList?.contains('md:col-span-2') &&
        el.querySelector(':scope > div.rounded-2xl') != null
      ) {
        return { anchor: el, mode: 'append', variant: 'inline' };
      }
    }
    const legacyHeader = document.querySelector('.profile-view .profile-header');
    if (
      legacyHeader &&
      legacyHeader.isConnected &&
      legacyHeader.offsetParent !== null &&
      legacyHeader.parentElement
    ) {
      return { anchor: legacyHeader, mode: 'after', variant: 'card' };
    }
    return null;
  };

  const mountInto = ({ anchor, mode, variant }) => {
    if (current) return;
    const container = document.createElement('div');
    container.className = 'echo-plugin-mount dvp-profile-mount';
    container.setAttribute('data-plugin-id', 'daily-vip-claim');
    container.setAttribute('data-plugin-mount', MOUNT_ID);
    if (mode === 'after') {
      container.style.marginTop = '20px';
      anchor.insertAdjacentElement('afterend', container);
    } else {
      anchor.appendChild(container);
    }

    const app = ctx.vue.createApp(ClaimCard, { variant });
    if (ctx.pinia) app.use(ctx.pinia);
    if (ctx.router) app.use(ctx.router);
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
    const mounted = document.querySelector(`[data-plugin-mount="${MOUNT_ID}"]`);
    if (mounted && mounted.isConnected) return;
    disposeCurrent();
    const target = findProfileTarget();
    if (target) mountInto(target);
  };

  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      scan();
    }, 80);
  };

  if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined' && document.body) {
    observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    schedule();
  }

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
  const { h, defineComponent, ref, onMounted, reactive } = ctx.vue;

  // 初始化本次激活的响应式状态容器
  runtime =
    typeof reactive === 'function' ? reactive(createInitialRuntimeData()) : createInitialRuntimeData();
  manuallyClearedUids.clear();
  monthRecordCache = { at: 0, value: [] };
  unregisterTitlebar = null;
  unregisterPlayerbar = null;

  ctx.css.inject(CSS, { id: 'page' });

  const comps = {
    Button: resolveHostComponent(ctx, 'Button'),
    PageScrollContainer: resolveHostComponent(ctx, 'PageScrollContainer'),
    Switch: resolveHostComponent(ctx, 'Switch'),
    Dialog: resolveHostComponent(ctx, 'Dialog'),
    Popconfirm: resolveHostComponent(ctx, 'Popconfirm'),
    Tabs: resolveHostComponent(ctx, 'Tabs'),
    TabsList: resolveHostComponent(ctx, 'TabsList'),
    TabsTrigger: resolveHostComponent(ctx, 'TabsTrigger'),
    TabsContent: resolveHostComponent(ctx, 'TabsContent'),
    DetailPageSliverHeader: resolveHostComponent(ctx, 'DetailPageSliverHeader'),
    PageStickyHeader: resolveHostComponent(ctx, 'PageStickyHeader'),
    RollingNumber: resolveHostComponent(ctx, 'RollingNumber'),
  };

  const ClaimCard = createClaimCard(ctx, comps);
  const ClaimPage = createClaimPage(ctx, comps);
  const LedgerDialog = createLedgerDialog(ctx, comps);

  // 自动领取调度器（支持在设置中即时启停，无需重启）
  let disposed = false;
  let autoTimer = null;
  let autoInterval = null;
  let resumeDisposer = null;

  const stopAutoClaimScheduler = () => {
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
      } catch {}
      resumeDisposer = null;
    }
  };

  const syncAutoClaimScheduler = (enabled) => {
    const nextEnabled = Boolean(enabled);
    runtime.autoClaim = nextEnabled;
    stopAutoClaimScheduler();
    if (!nextEnabled || disposed) return;

    autoTimer = setTimeout(() => {
      autoTimer = null;
      if (!disposed && runtime.autoClaim) void maybeAutoClaim(ctx, false);
    }, 5000);
    autoInterval = setInterval(() => {
      if (!disposed && runtime.autoClaim) void maybeAutoClaim(ctx, false);
    }, 60 * 60 * 1000);
    try {
      resumeDisposer =
        ctx.electron?.power?.onResume?.(() => {
          if (!disposed && runtime.autoClaim) void maybeAutoClaim(ctx, false);
        }) || null;
    } catch (error) {
      console.warn('[daily-vip-claim] 注册唤醒监听失败:', error);
    }
  };

  // 1. 独立页面（命令/快捷入口可达）
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

  // 2. 个人中心嵌入原生风格卡片
  const disposeProfile = injectProfileClaim(ctx, ClaimCard);

  // 3. 插件设置面板（无外框原生分组，所有开关即时生效）
  const SettingsPanel = defineComponent({
    name: 'daily-vip-claim-settings',
    setup() {
      const autoClaim = ref(runtime.autoClaim);
      const playerbarBadge = ref(runtime.playerbarBadge);
      const enableConceptTasks = ref(runtime.enableConceptTasks);
      const loaded = ref(false);

      onMounted(async () => {
        try {
          const [rawAuto, rawPb, rawConcept] = await Promise.all([
            ctx.storage.get('autoClaim'),
            ctx.storage.get('playerbarBadge'),
            ctx.storage.get('enableConceptTasks'),
          ]);
          autoClaim.value = Boolean(rawAuto);
          playerbarBadge.value = rawPb === null || rawPb === undefined ? true : Boolean(rawPb);
          enableConceptTasks.value =
            rawConcept === null || rawConcept === undefined ? true : Boolean(rawConcept);
          runtime.autoClaim = autoClaim.value;
          runtime.playerbarBadge = playerbarBadge.value;
          runtime.enableConceptTasks = enableConceptTasks.value;
          syncConceptStepIdleState(enableConceptTasks.value);
        } catch (error) {
          console.warn('[daily-vip-claim] 读取设置失败:', error);
        }
        loaded.value = true;
      });

      const setAutoClaim = async (value) => {
        const next = Boolean(value);
        autoClaim.value = next;
        await ctx.storage.set('autoClaim', next).catch(() => {});
        syncAutoClaimScheduler(next);
      };

      const setPlayerbarBadge = async (value) => {
        const next = Boolean(value);
        playerbarBadge.value = next;
        await ctx.storage.set('playerbarBadge', next).catch(() => {});
        await updateBadges(ctx);
      };

      const setEnableConceptTasks = async (value) => {
        const next = Boolean(value);
        enableConceptTasks.value = next;
        runtime.enableConceptTasks = next;
        syncConceptStepIdleState(next);
        await ctx.storage.set('enableConceptTasks', next).catch(() => {});
      };

      return () =>
        h('div', { class: 'dvp-settings-root' }, [
          h('div', { class: 'dvp-settings-group' }, [
            h('div', { class: 'dvp-setting-row' }, [
              h('div', { class: 'dvp-setting-copy' }, [
                h('div', { class: 'dvp-setting-label' }, '启动后自动领取'),
                h(
                  'div',
                  { class: 'dvp-setting-hint' },
                  '启动 5 秒后、休眠唤醒及每小时自动检查；今日已领静默跳过，开关即时生效无需重启',
                ),
              ]),
              h(comps.Switch, {
                modelValue: autoClaim.value,
                'onUpdate:modelValue': setAutoClaim,
                disabled: !loaded.value,
              }),
            ]),
            h('div', { class: 'dvp-setting-row' }, [
              h('div', { class: 'dvp-setting-copy' }, [
                h('div', { class: 'dvp-setting-label' }, '播放栏快捷 VIP 胶囊'),
                h(
                  'div',
                  { class: 'dvp-setting-hint' },
                  '在底部播放栏右侧显示到期天数胶囊，点击打开畅听账本弹窗（关闭后立即隐藏）',
                ),
              ]),
              h(comps.Switch, {
                modelValue: playerbarBadge.value,
                'onUpdate:modelValue': setPlayerbarBadge,
                disabled: !loaded.value,
              }),
            ]),
            h('div', { class: 'dvp-setting-row' }, [
              h('div', { class: 'dvp-setting-copy' }, [
                h('div', { class: 'dvp-setting-label' }, '启用概念版附加打卡任务'),
                h(
                  'div',
                  { class: 'dvp-setting-hint' },
                  '打卡时同步上报概念版「广告打卡」与「听歌打卡」子任务；关闭后仅执行基础畅听领取与特权升级',
                ),
              ]),
              h(comps.Switch, {
                modelValue: enableConceptTasks.value,
                'onUpdate:modelValue': setEnableConceptTasks,
                disabled: !loaded.value,
              }),
            ]),
            h('div', { class: 'dvp-setting-row' }, [
              h('div', { class: 'dvp-setting-copy' }, [
                h('div', { class: 'dvp-setting-label' }, '打卡月历与流水主页'),
                h(
                  'div',
                  { class: 'dvp-setting-hint' },
                  '查看当月打卡日历网格、4 步实时状态与本地账本流水筛选',
                ),
              ]),
              h(
                comps.Button,
                {
                  variant: 'soft-secondary',
                  size: 'xs',
                  onClick: () => ctx.router?.push?.('/main/plugin/daily-vip-claim/claim'),
                },
                { default: () => '打开主页' },
              ),
            ]),
          ]),
          h(ClaimCard, { variant: 'card' }),
        ]);
    },
  });

  ctx.ui.settings.define({
    id: 'daily-vip-claim',
    title: '每日畅听会员领取',
    description: '自动领取开关、播放栏胶囊、概念版子任务与快捷领取',
    component: SettingsPanel,
  });

  // 4. 初始化 SQLite 本地流水账本与宿主原生账本 Dialog
  void initLedgerDb(ctx);
  let unmountModal = null;
  if (ctx.ui && typeof ctx.ui.teleport === 'function') {
    try {
      unmountModal = ctx.ui.teleport(LedgerDialog);
    } catch (teleportErr) {
      console.warn('[daily-vip-claim] 挂载账本弹窗失败:', teleportErr);
    }
  }

  // 5. 初始化标题栏与播放栏入口
  void updateBadges(ctx);

  // 6. 监听多账号切换
  let sessionDisposer = null;
  try {
    const userStore = ctx.pinia?._s?.get('user');
    if (userStore && typeof userStore.$subscribe === 'function') {
      let lastUid = String(userStore.info?.userid ?? userStore.info?.userId ?? '');
      let lastRev = Number(userStore.accountRevision || 0);
      let lastLoggedIn = Boolean(userStore.isLoggedIn);

      sessionDisposer = userStore.$subscribe(() => {
        const curUid = String(userStore.info?.userid ?? userStore.info?.userId ?? '');
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
          runtime.lastError = '';
          const freshSteps = createDefaultSteps(runtime.enableConceptTasks);
          runtime.steps.baseVip = freshSteps.baseVip;
          runtime.steps.upgrade = freshSteps.upgrade;
          runtime.steps.conceptAd = freshSteps.conceptAd;
          runtime.steps.conceptListen = freshSteps.conceptListen;
          console.info('[daily-vip-claim] 感知到账号会话切换:', curUid || '未登录');
          void refreshUserInfoBestEffort(ctx);
          if (curLoggedIn && curUid) {
            void backfillLedgerFromMonthRecords(ctx, curUid);
          }
          void updateBadges(ctx, { force: true });
        }
      });
    }
  } catch (err) {
    console.warn('[daily-vip-claim] 注册账号会话监听失败:', err);
  }

  // 7. 服务请求拦截：无感同步 VIP 状态（不触发栏位销毁重建）
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
              monthRecordCache.at = 0;
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
              void updateBadges(ctx);
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

  // 8. 启动自动领取调度器（读取持久化设置后即时启动）
  void (async () => {
    let autoEnabled = false;
    try {
      autoEnabled = Boolean(await ctx.storage.get('autoClaim'));
    } catch {}
    if (!disposed) {
      syncAutoClaimScheduler(autoEnabled);
    }
  })();

  // 9. 暴露跨插件轻量状态桥
  const bridge = {
    version: '2.5.0',
    getStatus: () => ({
      loggedIn: runtime.loggedIn,
      userId: runtime.userId,
      vipExpiry: runtime.vipExpiry,
      claimedToday: runtime.claimedToday,
      monthCount: runtime.monthCount,
      streakDays: runtime.streakDays,
      totalSuccess: runtime.totalSuccess,
      savedMoney: runtime.savedMoney,
      autoClaim: runtime.autoClaim,
      playerbarBadge: runtime.playerbarBadge,
      enableConceptTasks: runtime.enableConceptTasks,
      steps: snapshotSteps(),
      lastError: runtime.lastError,
      updatedAt: runtime.updatedAt,
    }),
    openLedger: () => ledgerModalState.open?.(),
    openPage: () => ctx.router?.push?.('/main/plugin/daily-vip-claim/claim'),
    claimNow: () => claimNow(ctx),
    syncAutoClaimScheduler,
  };
  globalThis.__echoMusicDailyVip = bridge;

  disposeAll = () => {
    if (disposed) return;
    disposed = true;
    stopAutoClaimScheduler();
    if (globalThis.__echoMusicDailyVip === bridge) {
      delete globalThis.__echoMusicDailyVip;
    }
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
    ledgerModalState.open = null;
    ledgerModalState.close = null;
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
