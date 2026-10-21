// dsh-comm — Client 半边
//
// 只做三件事：
//   1. 向右栏 tab 注册表注册一个 page 类型（id/kind = dsh-comm），带 guide 入口；
//   2. 在 sidebar.right.pane.tab 座位渲染一个 iframe；
//   3. iframe 指向 Host 半边挂在 /comm/ui 的页面（token 来自注入的 window.__DSH_COMM__）。
//
// 这样 UI 可以用普通 HTML/CSS/JS 写，宿主 API 由 iframe 内的 fetch 调 /comm/api/*。

window.__ModuleLoader__.load({
  id: 'dsh-comm',
  factory: (require) => {
    const react = require('react')

    const ID = 'dsh-comm'
    const KIND = 'dsh-comm'

    function CommIcon() {
      return react.createElement(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        },
        react.createElement('path', { d: 'M9 2v6M15 2v6' }),
        react.createElement('path', { d: 'M6 8h12v3a6 6 0 0 1-12 0V8z' }),
        react.createElement('path', { d: 'M12 17v5' }),
      )
    }

    function readDark() {
      try {
        const root = document.documentElement
        const token = getComputedStyle(root).getPropertyValue('--dsw-alias-bg-base').trim()
        const bg = token || getComputedStyle(document.body).backgroundColor
        const match = String(bg).match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/)
        if (match) {
          const luminance = Number(match[1]) * 0.299 + Number(match[2]) * 0.587 + Number(match[3]) * 0.114
          return luminance < 128
        }
      } catch { /* ignore */ }
      try { return !window.matchMedia('(prefers-color-scheme: light)').matches } catch { return true }
    }

    function postTheme(frame) {
      if (!frame || !frame.contentWindow) return
      try {
        frame.contentWindow.postMessage({ type: 'dsh-comm:theme', dark: readDark() }, '*')
      } catch { /* iframe may not be ready */ }
    }

    function patchBase(cfg) {
      // 普通浏览器/Electron HTTP 页面：相对 base 跟随当前 origin（代理、远端访问都正确）。
      // dsh-app:// 等非 http(s) 页面：用 Host 注入的绝对 origin 兜底。
      try {
        const protocol = window.location.protocol
        if (protocol === 'http:' || protocol === 'https:') return cfg.base
        const origin = String(cfg.origin || '').replace(/\/$/, '')
        return origin ? origin + cfg.base : cfg.base
      } catch {
        return cfg.base
      }
    }

    function CommFrame() {
      const frameRef = react.useRef(null)
      const cfg = typeof window !== 'undefined' ? window.__DSH_COMM__ : undefined
      react.useEffect(() => {
        const timer = setInterval(() => postTheme(frameRef.current), 1000)
        return () => clearInterval(timer)
      }, [])
      if (!cfg || !cfg.base || !cfg.token) {
        return react.createElement(
          'div',
          {
            style: {
              padding: '16px',
              fontSize: '12px',
              lineHeight: 1.7,
              color: 'var(--dsw-alias-label-tertiary, #8b94a7)',
            },
          },
          '通信面板未就绪：Host 没有注入 window.__DSH_COMM__。',
          react.createElement('br'),
          '请确认 dsh-comm 的 Host 半边已启动，然后刷新页面。',
        )
      }
      const src = `${patchBase(cfg)}/ui?token=${encodeURIComponent(cfg.token)}`
      return react.createElement('iframe', {
        ref: frameRef,
        src,
        title: '通信调试台',
        onLoad: () => postTheme(frameRef.current),
        style: {
          display: 'block',
          width: '100%',
          height: '100%',
          border: '0',
          background: 'transparent',
        },
      })
    }

    function TabTitle() {
      return react.createElement(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
        react.createElement(CommIcon),
        '通信',
      )
    }

    function apply(ctx) {
      const tabs = ctx.sidebarRightTabs
      if (!tabs || typeof tabs.register !== 'function') return
      // 类型注册：id 同时是正文/标题两个 keyed slot 的 key。
      ctx.effect(() => tabs.register({
        id: ID,
        kind: KIND,
        title: () => '通信',
        guide: [{
          id: `${ID}:guide`,
          order: 40,
          title: () => '通信',
          description: () => '串口 / TCP / UDP 调试台',
          icon: CommIcon,
        }],
      }))
      // 正文：keyed slot sidebar.right.pane.tab
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab',
        key: ID,
      }, () => react.createElement(CommFrame))))
      // 标题：keyed slot sidebar.right.pane.tab.title
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab.title',
        key: ID,
      }, () => react.createElement(TabTitle))))
    }

    return { name: ID, inject: ['slots', 'sidebarRightTabs'], apply }
  },
})
