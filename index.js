// 每日畅听会员领取插件
// 通过 ctx.kugou 复用宿主登录态调用酷狗 API（插件不接触用户令牌），
// 领取 1 天畅听会员（含升级），并展示当月领取记录。
//
// 入口分布（v1.1）：
// - 个人中心「会员状态」下方嵌入领取卡片（MutationObserver 自愈注入）
// - 插件设置项（设置 → 插件管理 → 本插件）：自动领取开关 + 快速领取卡片
// - 独立页面（无侧边栏入口，可通过命令/快捷键打开）：/main/plugin/daily-vip-claim/claim

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

// 领取 1 天 VIP → 升级为畅听会员（升级可选：失败不阻断领取结果）
const claimOnce = async (ctx) => {
  await ctx.kugou.user.claimDayVip(formatClaimDate());
  try {
    await ctx.kugou.user.upgradeDayVip();
  } catch (upgradeError) {
    console.warn('[daily-vip-claim] 升级失败（非阻断）:', upgradeError);
  }
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

// 领取卡片共享状态/动作（页面、设置项、个人中心注入三处复用）
const createClaimState = (ctx) => {
  const { ref } = ctx.vue;

  const isClaiming = ref(false);
  const isLoadingRecords = ref(false);
  const showRecords = ref(false);
  const records = ref([]);

  const loadRecords = async () => {
    if (isLoadingRecords.value) return;
    isLoadingRecords.value = true;
    try {
      const res = await ctx.kugou.user.getVipMonthRecord();
      records.value = normalizeVipRecords(res);
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
    try {
      await claimOnce(ctx);
      ctx.toast.success('已领取 1 天畅听会员');
      refreshUserInfoBestEffort(ctx);
      if (showRecords.value) await loadRecords();
    } catch (error) {
      console.warn('[daily-vip-claim] 领取失败:', error);
      ctx.toast.danger(getApiErrorMessage(error, '领取每日畅听会员失败'));
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

// 自动领取：今日已领取（131001）静默跳过；网络等失败等待后重试一次
const runAutoClaim = async (ctx) => {
  const ok = await isLoggedInCached(ctx);
  if (ok === false) {
    console.info('[daily-vip-claim] 自动领取跳过：未登录');
    return;
  }
  for (let attempt = 0; attempt <= 1; attempt += 1) {
    try {
      await claimOnce(ctx);
      ctx.toast.success('已自动领取 1 天畅听会员');
      refreshUserInfoBestEffort(ctx);
      return;
    } catch (error) {
      if (isClaim131001(error)) {
        console.info('[daily-vip-claim] 自动领取跳过：今日已领取');
        return;
      }
      if (attempt === 1) {
        console.warn('[daily-vip-claim] 自动领取失败:', error);
        ctx.toast.danger(getApiErrorMessage(error, '自动领取每日畅听会员失败'));
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
  gap: 10px;
  margin: 20px 0 24px;
}

.dvp-header-icon {
  color: var(--color-primary, #31cfa1);
}

.dvp-title {
  margin: 0;
  font-size: 22px;
  font-weight: 900;
  letter-spacing: -0.02em;
  color: var(--color-text-main, #f8fafc);
}

.dvp-card {
  border: 1px solid var(--border-subtle, rgba(148, 163, 184, 0.16));
  border-radius: 18px;
  background: var(--color-bg-elevated, rgba(148, 163, 184, 0.08));
  box-shadow: var(--shadow-sm, 0 1px 2px rgba(0, 0, 0, 0.2));
  padding: 16px;
}

/* 个人中心嵌入版：贴紧会员状态卡的视觉语言 */
.dvp-card-inline {
  border: 1px solid var(--border-subtle, rgba(148, 163, 184, 0.16));
  border-radius: 16px;
  background: var(--color-bg-elevated, rgba(148, 163, 184, 0.08));
  padding: 12px;
  min-width: 0;
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
  gap: 10px;
  min-width: 0;
}

.dvp-claim-icon {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-primary, #31cfa1) 10%, transparent);
  color: var(--color-primary, #31cfa1);
}

.dvp-claim-icon-sm {
  width: 28px;
  height: 28px;
}

.dvp-claim-title {
  margin: 0;
  font-size: 13px;
  font-weight: 900;
  color: var(--color-text-main, #f8fafc);
}

.dvp-muted {
  margin: 2px 0 0;
  font-size: 11px;
  font-weight: 700;
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.9));
  opacity: 0.6;
}

.dvp-records-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 12px;
}

.dvp-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: none;
  background: none;
  padding: 2px;
  color: var(--color-primary, #31cfa1);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  cursor: pointer;
  transition: opacity 0.15s;
}

.dvp-toggle:hover {
  opacity: 0.9;
}

.dvp-toggle:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.dvp-records-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 144px;
  overflow-y: auto;
  margin-top: 8px;
}

.dvp-record {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-radius: 8px;
  background: var(--control-muted-bg, rgba(148, 163, 184, 0.1));
  padding: 6px 10px;
}

.dvp-record-date {
  font-size: 11px;
  font-weight: 900;
  color: var(--color-text-main, #f8fafc);
}

.dvp-record-label {
  font-size: 10px;
  font-weight: 700;
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.9));
  opacity: 0.6;
}

.dvp-records-empty {
  padding: 6px 10px;
  font-size: 11px;
  font-weight: 700;
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.9));
  opacity: 0.6;
}

.dvp-logged-out {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  border: 1px solid var(--border-subtle, rgba(148, 163, 184, 0.16));
  border-radius: 18px;
  background: var(--color-bg-elevated, rgba(148, 163, 184, 0.08));
  padding: 48px 24px;
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.9));
}

.dvp-logged-out p {
  margin: 0;
  font-size: 13px;
  font-weight: 700;
}

/* 插件设置面板 */
.dvp-settings {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.dvp-setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.dvp-setting-copy {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.dvp-setting-label {
  font-size: 13px;
  font-weight: 900;
  color: var(--color-text-main, #f8fafc);
}

.dvp-setting-hint {
  font-size: 11px;
  font-weight: 700;
  color: var(--color-text-secondary, rgba(148, 163, 184, 0.9));
  opacity: 0.6;
}

@keyframes dvp-spin {
  to {
    transform: rotate(360deg);
  }
}

.dvp-spin {
  animation: dvp-spin 1s linear infinite;
  transform-origin: center;
  transform-box: fill-box;
}
`;

// ---- 共享组件 ----

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
      const state = createClaimState(ctx);
      const loggedIn = ref(null); // null = 检查中/未知，true/false = 已确认

      onMounted(async () => {
        loggedIn.value = await isLoggedInCached(ctx);
      });

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
                : h(
                    Button,
                    {
                      variant: 'outline',
                      size: 'xs',
                      loading: state.isClaiming.value,
                      onClick: state.handleClaim,
                    },
                    { default: () => (state.isClaiming.value ? '领取中' : '领取') },
                  ),
            ]),
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
    name: 'daily-vip-claim-settings',
    setup() {
      const autoClaim = ref(false);
      const loaded = ref(false);

      onMounted(async () => {
        try {
          autoClaim.value = Boolean(await ctx.storage.get('autoClaim'));
        } catch (error) {
          console.warn('[daily-vip-claim] 读取设置失败:', error);
        }
        loaded.value = true;
      });

      const setAutoClaim = (value) => {
        autoClaim.value = Boolean(value);
        void ctx.storage.set('autoClaim', autoClaim.value).catch(() => {});
      };

      return () =>
        h('div', { class: 'dvp-settings' }, [
          h('div', { class: 'dvp-setting-row' }, [
            h('div', { class: 'dvp-setting-copy' }, [
              h('div', { class: 'dvp-setting-label' }, '启动后自动领取'),
              h(
                'div',
                { class: 'dvp-setting-hint' },
                '应用启动 5 秒后自动领取；今日已领取时静默跳过，失败自动重试一次',
              ),
            ]),
            h(Switch, {
              modelValue: autoClaim.value,
              'onUpdate:modelValue': setAutoClaim,
              disabled: !loaded.value,
            }),
          ]),
          h(ClaimCard, { variant: 'card' }),
        ]);
    },
  });

  ctx.ui.settings.define({
    id: 'daily-vip-claim',
    title: '每日畅听会员领取',
    description: '自动领取开关与快速领取入口',
    component: SettingsPanel,
  });

  // 4. 自动领取（启动 5 秒后执行一次；今日已领取时静默跳过）
  let disposed = false;
  void (async () => {
    try {
      if (!(await ctx.storage.get('autoClaim'))) return;
    } catch {
      return;
    }
    setTimeout(() => {
      if (disposed) return;
      void runAutoClaim(ctx);
    }, 5000);
  })();

  disposeAll = () => {
    if (disposed) return;
    disposed = true;
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
