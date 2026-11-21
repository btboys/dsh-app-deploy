window.__ModuleLoader__.load({
  id: 'dsh-app-deploy',
  factory(require) {
    const React = require('react')
    const { useEffect, useRef, useState } = React
    const h = React.createElement

    const API = '/api/dsh-app-deploy'
    const SSE = API + '/deploy'
    const HSTATUS = { success: '成功', failed: '失败', running: '进行中', aborted: '中断' }
    const KIND_LABEL = { front: '前端', server: '服务端' }
    const ENV_TABS = [
      { id: 'basic', label: '基本' },
      { id: 'ssh', label: 'SSH 目标' },
      { id: 'modules', label: '模块' },
    ]

    // ---------- 基础工具 ----------

    async function rpc(method, args) {
      const response = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method, args }),
      })
      let payload
      try { payload = await response.json() } catch { throw new Error('响应解析失败 (' + response.status + ')') }
      if (!payload || payload.ok !== true) throw new Error((payload && payload.error) || ('请求失败 (' + response.status + ')'))
      return payload.value
    }

    const pad2 = (n) => String(n).padStart(2, '0')
    function fmtTime(ms) {
      if (ms == null) return ''
      const d = new Date(ms)
      return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds())
    }
    function fmtDur(ms) {
      if (ms == null) return ''
      const s = Math.round(ms / 1000)
      return s >= 60 ? Math.floor(s / 60) + 'm' + (s % 60) + 's' : s + 's'
    }
    function fmtAgo(ms) {
      const s = Math.max(1, Math.round((Date.now() - ms) / 1000))
      if (s < 60) return '刚刚'
      const m = Math.round(s / 60)
      if (m < 60) return m + ' 分钟前'
      const hh = Math.round(m / 60)
      if (hh < 24) return hh + ' 小时前'
      const d = Math.round(hh / 24)
      if (d < 30) return d + ' 天前'
      return fmtTime(ms)
    }
    function clone(v) { return JSON.parse(JSON.stringify(v)) }
    function normPath(p) { return (p || '').replace(/\/+$/, '') }
    // 绝对路径：posix 以 / 开头，Windows 为盘符或 \ 开头（如 C:\proj、D:/proj）
    function isAbsPath(p) { return /^([a-zA-Z]:[\\/]|[\\/])/.test(p || '') }
    function joinPath(base, name) {
      if (!name) return base || ''
      if (isAbsPath(name)) return name
      const b = base || ''
      if (!b) return name
      return b === '/' ? '/' + name : b.replace(/[\\/]+$/, '') + '/' + name
    }
    function parentPath(p) {
      const base = normPath(p || '')
      if (!base || base === '/' || /^[a-zA-Z]:[\\/]?$/.test(base)) return base || '/'
      const i = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'))
      return i <= 0 ? '/' : base.slice(0, i)
    }
    function newEnvId(envs) {
      let id = 'env' + Date.now().toString(36)
      let n = 1
      while (envs.some((e) => e.id === id)) id = 'env' + Date.now().toString(36) + (n++)
      return id
    }
    function makeModule(modules) {
      let n = 1
      while (modules.some((m) => m.id === 'mod' + n)) n++
      return {
        id: 'mod' + n, name: '新模块', kind: 'front', enabled: true,
        buildCmd: '', buildDir: '', sshId: '', instances: [], localPath: '', remotePath: '',
        postCommand: '', healthCheckUrl: '', healthCheckPattern: '', frontEnv: '',
      }
    }
    function normalizeModule(m) {
      return {
        id: m.id || '', name: m.name || '', kind: m.kind === 'server' ? 'server' : 'front',
        enabled: m.enabled !== false,
        buildCmd: m.buildCmd || '', buildDir: m.buildDir || '', sshId: m.sshId || '',
        instances: Array.isArray(m.instances) ? m.instances.map((i) => ({ sshId: i.sshId || '', healthCheckUrl: i.healthCheckUrl || '', healthCheckPattern: i.healthCheckPattern || '' })) : [],
        localPath: m.localPath || '', remotePath: m.remotePath || '', postCommand: m.postCommand || '',
        healthCheckUrl: m.healthCheckUrl || '', healthCheckPattern: m.healthCheckPattern || '', frontEnv: m.frontEnv || '',
      }
    }
    // 模块的发布目标（与服务端 config.js targetFor 同规则：sshId 落空→第一个目标）
    function targetOf(env, m) {
      const list = (env && env.sshs) || []
      return list.find((s) => s.id === (m && m.sshId)) || list[0] || {}
    }

    function normalizeEnv(env) {
      const e = clone(env || {})
      // 旧格式 env.ssh 单对象自动迁移为 sshs 数组
      const rawSshs = Array.isArray(e.sshs) && e.sshs.length ? e.sshs : (e.ssh ? [e.ssh] : [])
      return {
        id: e.id || '',
        name: e.name || '',
        note: e.note || '',
        group: e.group || '',
        projectPath: e.projectPath || '',
        jdkHome: e.jdkHome || '',
        nodeHome: e.nodeHome || '',
        nodeOptions: e.nodeOptions || '',
        pmPath: e.pmPath || '',
        buildEnv: e.buildEnv || '',
        expTime: e.expTime || '',
        sshs: rawSshs.map((s, i) => ({
          id: s.id || (i === 0 ? 'default' : 'ssh' + (i + 1)),
          name: s.name || (i === 0 ? '默认' : 'SSH ' + (i + 1)),
          host: s.host || '', port: Number(s.port) || 22, user: s.user || 'root',
          password: s.password || '', keyFile: s.keyFile || '', options: s.options || '',
          proxyType: s.proxyType || '', jumpHost: s.jumpHost || '', jumpPort: Number(s.jumpPort) || 22,
          jumpUser: s.jumpUser || 'root', jumpKeyFile: s.jumpKeyFile || '',
          proxyHost: s.proxyHost || '', proxyPort: Number(s.proxyPort) || 0,
        })),
        modules: (e.modules || []).map(normalizeModule),
      }
    }

    // ---------- 工作空间关联部署：响应式匹配 ----------

    // 匹配用路径规范化：统一分隔符、去尾分隔符（保留 posix 根 '/'）
    function normMatchPath(p) {
      const raw = String(p || '').trim().replace(/\\/g, '/')
      const s = raw.replace(/\/+$/, '')
      if (s) return s
      return raw.startsWith('/') ? '/' : ''
    }
    // 当前工作空间 cwd 命中环境 projectPath：相等或 cwd 位于 projectPath 之下
    function pathMatches(cwd, projectPath) {
      const a = normMatchPath(cwd)
      const b = normMatchPath(projectPath)
      if (!a || !b || !isAbsPath(a) || !isAbsPath(b)) return false
      return a === b || a.startsWith(b + '/')
    }
    // 当前主会话 cwd：SessionListState.byId 中 retainedBy.mainView > 0 的那条
    function mainCwd(listState) {
      if (!listState || !listState.byId) return ''
      const main = Object.values(listState.byId)
        .find((s) => s && s.retainedBy && (s.retainedBy.mainView || 0) > 0)
      return (main && main.cwd) || ''
    }

    // 模块级共享：apply 内创建，Panel  mutations 后就地刷新侧栏直达入口
    let deployMatch = null
    function syncDeployEnvs(envs) { if (deployMatch) deployMatch.setEnvs(envs) }

    // 响应式匹配集合：订阅 sessions.list 算当前 cwd（无 RPC），envs 缓存定时/focus/就地刷新
    function createDeployMatch(ctx) {
      let envs = []
      let matched = []
      let sig = ''
      let sessionsSub = null
      const listeners = new Set()
      const notify = () => { for (const fn of [...listeners]) fn() }
      const currentCwd = () => {
        const sessions = ctx.get('sessions')
        if (!sessions || !sessions.list) return ''
        return mainCwd(sessions.list.getSnapshot())
      }
      const ensureSessions = () => {
        if (sessionsSub) return
        const sessions = ctx.get('sessions')
        if (sessions && sessions.list && sessions.list.subscribe) {
          sessionsSub = sessions.list.subscribe(recompute)
        }
      }
      const recompute = () => {
        ensureSessions()
        const cwd = currentCwd()
        const next = envs.filter((e) => pathMatches(cwd, e.projectPath))
        const nextSig = next.map((e) => e.id).join(',')
        if (nextSig === sig) return
        sig = nextSig
        matched = next
        notify()
      }
      const setEnvs = (list) => { envs = Array.isArray(list) ? list : []; recompute() }
      const refreshEnvs = () => { rpc('config').then((d) => setEnvs(d && d.envs)).catch(() => {}) }
      ensureSessions()
      const timer = setInterval(refreshEnvs, 30000)
      const onFocus = () => refreshEnvs()
      window.addEventListener('focus', onFocus)
      refreshEnvs()
      recompute()
      return {
        getSnapshot: () => matched,
        subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
        setEnvs,
        dispose: () => {
          if (sessionsSub) sessionsSub()
          clearInterval(timer)
          window.removeEventListener('focus', onFocus)
          listeners.clear()
        },
      }
    }

    // ---------- 右栏工作空间部署 tab ----------

    const RB_TAB_ID = 'dsh-app-deploy/rightbar'
    const RB_KIND = 'dsh-app-deploy'
    // 直达面板预选环境：取匹配集合第一个（配置顺序）
    function pickDeployEnvId() {
      const matched = deployMatch ? deployMatch.getSnapshot() : []
      return matched.length ? matched[0].id : ''
    }
    function deployGuideDesc() {
      const m = deployMatch ? deployMatch.getSnapshot() : []
      if (!m.length) return ''
      if (m.length === 1) return m[0].name || m[0].id
      return m.length + ' 个环境 · ' + (m[0].name || m[0].id)
    }
    // guide 卡片图标（IconProps: size/className）
    function DeployGuideIcon(props) { return h(Icon, { size: (props && props.size) || 22 }) }
    // 右栏 tab body：复用完整部署面板，预选匹配环境
    function DeployTabBody() { return h(Panel, { initialEnvId: pickDeployEnvId() }) }

    // ---------- 图标 ----------

    function Icon({ size }) {
      return h('svg', {
        viewBox: '0 0 24 24', width: size || 20, height: size || 20, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('path', { d: 'M12 3v11' }),
        h('path', { d: 'M7.5 9.5 12 14l4.5-4.5' }),
        h('path', { d: 'M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4' }))
    }

    // ---------- 小组件 ----------

    function Field({ label, wide, children }) {
      return h('div', { className: 'dad-field' + (wide ? ' dad-field-wide' : '') },
        h('span', { className: 'dad-label' }, label),
        children)
    }

    // 路径下拉选择器（JDK / Node 共用）：输入框 + 候选项弹层
    function PathPicker({ value, aria, items, open, wrapRef, onFocus, onChange, onPick, emptyText }) {
      return h('div', { className: 'dad-jdkwrap', ref: wrapRef },
        h('input', {
          className: 'dad-input', type: 'text', value, 'aria-label': aria, onFocus,
          onChange: (ev) => onChange(ev.target.value),
        }),
        open ? h('div', { className: 'dad-jdkdd' },
          items.length
            ? items.map((j) => h('button', {
              key: j.path, type: 'button', className: 'dad-jitem',
              onClick: () => onPick(j.path),
            },
              h('span', { className: 'dad-jlbl' }, j.label),
              h('span', { className: 'dad-jfull' }, j.path)))
            : h('div', { className: 'dad-jempty' }, emptyText)) : null)
    }

    // 构建工具预设：选中即填充构建命令（可再手动编辑）
    const BUILD_PRESETS = [
      { tool: 'Gradle', cmd: './gradlew' },
      { tool: 'Maven', cmd: 'mvn -DskipTests package' },
      { tool: 'npm', cmd: 'npm run build' },
      { tool: 'pnpm', cmd: 'pnpm run build' },
      { tool: 'yarn', cmd: 'yarn build' },
    ]

    function EnvCard({ env, selected, lastBuild, onSelect, onCopy, onDelete }) {
      const lb = lastBuild[env.id]
      const sshList = env.sshs || []
      const ssh = sshList[0] || {}
      const sshText = ssh.host
        ? (ssh.user || 'root') + '@' + ssh.host + ':' + (ssh.port || 22) + (sshList.length > 1 ? ' 等 ' + sshList.length + ' 个目标' : '')
        : 'SSH 未配置'
      return h('div', {
        className: 'dad-env',
        'data-sel': selected ? '1' : '0',
      },
        h('button', {
          type: 'button', className: 'dad-env-main', onClick: onSelect,
          'aria-current': selected ? 'true' : undefined,
        },
          h('span', { className: 'dad-env-name' },
            h('i', { className: 'dad-dot' + (lb ? ' st-' + lb.status : ''), 'aria-hidden': true }),
            env.name || env.id),
          h('span', { className: 'dad-sub' }, env.id + (env.note ? ' · ' + env.note : '')),
          h('span', { className: 'dad-sub' }, sshText),
          h('span', { className: 'dad-sub dad-build' + (lb ? ' ' + lb.status : '') },
            h('i', { className: 'dad-dot', 'aria-hidden': true }),
            lb ? '最后构建: ' + fmtTime(lb.time) + '（' + (HSTATUS[lb.status] || lb.status) + '）' : '最后构建: 从未')),
        h('div', { className: 'dad-envops' },
          h('button', {
            type: 'button', className: 'dad-linkbtn',
            onClick: () => onCopy(),
          }, '复制'),
          h('button', {
            type: 'button', className: 'dad-linkbtn dad-linkbtn-danger',
            onClick: () => onDelete(),
          }, '删除')))
    }

    function EnvList({ envs, lastBuild, draft, onSelect, onCopy, onDelete, onAdd, onImport, onExport }) {
      const buckets = new Map()
      const order = []
      const ungrouped = []
      for (const e of envs) {
        const g = (e.group || '').trim()
        if (!g) { ungrouped.push(e); continue }
        if (!buckets.has(g)) { buckets.set(g, []); order.push(g) }
        buckets.get(g).push(e)
      }
      const nodes = []
      for (const g of order) {
        nodes.push(h('div', { key: 'grp:' + g, className: 'dad-grp' }, g))
        for (const e of buckets.get(g)) {
          nodes.push(h(EnvCard, {
            key: e.id, env: e, lastBuild,
            selected: !!draft && draft.id === e.id,
            onSelect: () => onSelect(e), onCopy: () => onCopy(e), onDelete: () => onDelete(e),
          }))
        }
      }
      if (ungrouped.length) {
        nodes.push(h('div', { key: 'grp:__ungrouped', className: 'dad-grp' }, '未分组'))
        for (const e of ungrouped) {
          nodes.push(h(EnvCard, {
            key: e.id, env: e, lastBuild,
            selected: !!draft && draft.id === e.id,
            onSelect: () => onSelect(e), onCopy: () => onCopy(e), onDelete: () => onDelete(e),
          }))
        }
      }
      return h('div', { className: 'dad-left' },
        h('div', { className: 'dad-left-head' },
          h('span', { className: 'dad-left-title' }, '环境'),
          h('button', {
            type: 'button', className: 'dad-btn', title: '从 JSON 配置文件导入环境（相同 ID 覆盖本地）',
            onClick: onImport,
          }, '导入'),
          h('button', {
            type: 'button', className: 'dad-btn', title: '选择要导出的环境，下载为 JSON（含 SSH 密码）',
            onClick: onExport, disabled: envs.length === 0,
          }, '导出'),
          h('button', { type: 'button', className: 'dad-btn dad-btn-primary', onClick: onAdd }, '+ 添加环境')),
        h('div', { className: 'dad-envs' },
          envs.length === 0 ? h('div', { className: 'dad-hint' }, '（暂无环境，点击「+ 添加环境」）') : null,
          nodes))
    }

    // 保存失败时把服务端错误归到对应页，避免用户停在看不到出错字段的 Tab 上。
    function saveErrorTarget(text, modules) {
      const msg = String(text || '')
      const parts = msg.split('；')
      let tab = ''
      let moduleIndex = -1
      const list = modules || []
      for (const part of parts) {
        const piece = part.trim()
        if (!piece) continue
        if (!tab) {
          if (piece.indexOf('SSH 目标') === 0 || piece === '至少需要一个 SSH 目标') tab = 'ssh'
          else if (piece.indexOf('模块') === 0 || piece === '至少需要一个模块') tab = 'modules'
          else {
            const named = list.findIndex((m) => {
              const name = (m.name || '').trim()
              const id = (m.id || '').trim()
              return (name && piece.indexOf(name + ':') === 0) || (id && piece.indexOf(id + ':') === 0)
            })
            if (named >= 0) {
              tab = 'modules'
              moduleIndex = named
            }
          }
        }
        if (tab === 'modules' && moduleIndex < 0) {
          const named = list.findIndex((m) => {
            const name = (m.name || '').trim()
            const id = (m.id || '').trim()
            return (name && piece.indexOf(name + ':') === 0) || (id && piece.indexOf(id + ':') === 0)
              || (name && piece.indexOf('模块 ' + name) === 0) || (id && piece.indexOf('模块 ' + id) === 0)
          })
          if (named >= 0) moduleIndex = named
        }
        if (tab && (tab !== 'modules' || moduleIndex >= 0)) break
      }
      return { tab: tab || 'basic', moduleIndex }
    }

    function ModuleTabs({ modules, sshs, index, onIndex, onChange, onDelete, onAdd }) {
      const list = modules || []
      const active = list.length ? Math.max(0, Math.min(index || 0, list.length - 1)) : 0
      const tabListRef = useRef(null)
      const focusTab = useRef(-1)
      useEffect(() => {
        if (focusTab.current !== active) return
        const root = tabListRef.current
        const btn = root && root.querySelector('[data-mod="' + active + '"]')
        focusTab.current = -1
        if (btn) btn.focus()
      }, [active])
      function onKey(ev) {
        if (!list.length) return
        if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight' && ev.key !== 'Home' && ev.key !== 'End') return
        let next = active
        if (ev.key === 'ArrowLeft') next = (active + list.length - 1) % list.length
        else if (ev.key === 'ArrowRight') next = (active + 1) % list.length
        else if (ev.key === 'Home') next = 0
        else next = list.length - 1
        ev.preventDefault()
        focusTab.current = next
        onIndex(next)
      }
      const mod = list[active]
      return h('div', null,
        h('div', { className: 'dad-modtabs' },
          h('div', { className: 'dad-modtablist', role: 'tablist', 'aria-label': '构建 / 发布模块', ref: tabListRef },
            list.length === 0
              ? h('span', { className: 'dad-hint' }, '（暂无模块）')
              : list.map((m, i) => {
                const selected = i === active
                const label = (m.name || '').trim() || (m.id || '').trim() || ('模块 ' + (i + 1))
                return h('button', {
                  key: i, type: 'button', role: 'tab',
                  className: 'dad-modtab', 'data-mod': String(i), 'data-off': m.enabled ? '0' : '1',
                  id: 'dad-mod-tab-' + i,
                  'aria-selected': selected ? 'true' : 'false',
                  'aria-controls': 'dad-mod-panel',
                  tabIndex: selected ? 0 : -1,
                  title: label + (m.enabled ? '' : '（未启用）'),
                  onClick: () => onIndex(i),
                  onKeyDown: onKey,
                },
                  h('span', { className: 'dad-modtab-name' }, label),
                  h('span', { className: 'dad-kindtag' + (m.kind === 'front' || m.kind === 'server' ? ' dad-kind-' + m.kind : '') }, KIND_LABEL[m.kind] || m.kind))
              })),
          h('button', { type: 'button', className: 'dad-btn', onClick: onAdd }, '+ 添加模块')),
        mod
          ? h('div', {
            role: 'tabpanel', id: 'dad-mod-panel', 'aria-labelledby': 'dad-mod-tab-' + active,
          },
            h(ModuleCard, {
              mod, sshs,
              onChange: (field, value) => onChange(active, field, value),
              onDelete: () => onDelete(active),
            }))
          : null)
    }

    function ModuleCard({ mod, onChange, onDelete, sshs }) {
      const envFile = mod.id === 'bsFront' ? 'client/client-front/.env'
        : mod.id === 'adminFront' ? 'admin/admin-front/.env' : ''
      const feLabel = 'frontEnv（KEY=VALUE 多行，构建时注入'
        + (envFile ? ' ' + envFile : '') + '）'
      return h('div', { className: 'dad-mcard', 'data-off': mod.enabled ? '0' : '1' },
        h('button', {
          type: 'button', className: 'dad-btndel', title: '删除模块', 'aria-label': '删除模块',
          onClick: onDelete,
        }, '×'),
        h('div', { className: 'dad-row' },
          h(Field, { label: '显示名' },
            h('input', {
              className: 'dad-input', type: 'text', value: mod.name, 'aria-label': '显示名',
              onChange: (ev) => onChange('name', ev.target.value),
            })),
          h(Field, { label: '类型' },
            h('select', {
              className: 'dad-select', value: mod.kind, 'aria-label': '类型',
              onChange: (ev) => onChange('kind', ev.target.value),
            },
              h('option', { value: 'front' }, '前端'),
              h('option', { value: 'server' }, '服务端'))),
          h(Field, { label: 'ID' },
            h('input', {
              className: 'dad-input', type: 'text', value: mod.id, 'aria-label': '模块 ID',
              onChange: (ev) => onChange('id', ev.target.value),
            })),
          h('label', { className: 'dad-chk' },
            h('input', {
              type: 'checkbox', checked: !!mod.enabled,
              onChange: (ev) => onChange('enabled', ev.target.checked),
            }), '启用')),
        h('div', { className: 'dad-row' },
          h(Field, { label: '构建命令（可左侧选工具自动填充，再手动补任务/参数）', wide: true },
            h('div', { className: 'dad-inline' },
              h('select', {
                className: 'dad-select', 'aria-label': '构建工具',
                value: (BUILD_PRESETS.find((p) => p.cmd === (mod.buildCmd || '').trim()) || {}).cmd || '',
                onChange: (ev) => { if (ev.target.value) onChange('buildCmd', ev.target.value) },
              },
                h('option', { value: '' }, '构建工具…'),
                BUILD_PRESETS.map((p) => h('option', { key: p.cmd, value: p.cmd }, p.tool))),
              h('input', {
                className: 'dad-input', type: 'text', value: mod.buildCmd, 'aria-label': '构建命令',
                onChange: (ev) => onChange('buildCmd', ev.target.value),
              }))),
          h(Field, { label: '执行目录（相对项目路径或绝对路径，留空 = 项目根目录）' },
            h('input', {
              className: 'dad-input', type: 'text', value: mod.buildDir || '', 'aria-label': '构建执行目录',
              placeholder: '如 catering/tenant-web',
              onChange: (ev) => onChange('buildDir', ev.target.value),
            }))),
        h('div', { className: 'dad-row' },
          h(Field, { label: '本地产物路径' },
            h('input', {
              className: 'dad-input', type: 'text', value: mod.localPath, 'aria-label': '本地产物路径',
              onChange: (ev) => onChange('localPath', ev.target.value),
            })),
          h(Field, { label: '远程目标路径' },
            h('input', {
              className: 'dad-input', type: 'text', value: mod.remotePath, 'aria-label': '远程目标路径',
              onChange: (ev) => onChange('remotePath', ev.target.value),
            })),
          h(Field, { label: 'SSH 目标' },
            h('select', {
              className: 'dad-select', value: mod.sshId || '', 'aria-label': 'SSH 目标',
              onChange: (ev) => onChange('sshId', ev.target.value),
            },
              (sshs || []).map((s) => h('option', { key: s.id, value: s.id }, s.name || s.id))))),
        h('div', { className: 'dad-row' },
          h(Field, { label: '部署后远程命令（可空）' },
            h('input', {
              className: 'dad-input', type: 'text', value: mod.postCommand, 'aria-label': '部署后远程命令',
              onChange: (ev) => onChange('postCommand', ev.target.value),
            })),
          h(Field, { label: '健康检查 URL（该模块部署后检查，留空跳过）', wide: true },
            h('input', {
              className: 'dad-input', type: 'url', value: mod.healthCheckUrl, 'aria-label': '健康检查 URL',
              onChange: (ev) => onChange('healthCheckUrl', ev.target.value),
            }))),
        h(Field, { label: '成功内容正则（可空：响应文本需匹配才算通过；HTTP 200 始终必需）', wide: true },
          h('input', {
            className: 'dad-input', type: 'text', value: mod.healthCheckPattern, placeholder: '如 "success"\\s*:\\s*true 或 /ok/i（需同时填 URL）',
            spellCheck: false, 'aria-label': '健康检查成功内容正则',
            onChange: (ev) => onChange('healthCheckPattern', ev.target.value),
          })),
        h('div', { className: 'dad-hint' },
          '健康检查：HTTP 状态码必须为 200；填了成功内容正则时响应文本还需匹配；单次最多 5 秒，间隔 3 秒，最多等待 120 秒，失败中止后续模块。'),
        h('div', { className: 'dad-instbox' },
          h('div', { className: 'dad-insthead' },
            h('span', { className: 'dad-label' }, '多实例（滚动发布：按顺序逐实例更新，探活通过才更新下一个；留空 = 单实例）'),
            h('button', {
              type: 'button', className: 'dad-btn', onClick: () => onChange('instances', [...(mod.instances || []), { sshId: (sshs[0] || {}).id || '', healthCheckUrl: '', healthCheckPattern: '' }]),
            }, '+ 添加实例')),
          (mod.instances || []).map((inst, ii) => h('div', { key: ii, className: 'dad-inline', style: { marginBottom: '6px' } },
            h('select', {
              className: 'dad-select', value: inst.sshId, 'aria-label': '实例 ' + (ii + 1) + ' SSH 目标',
              onChange: (ev) => onChange('instances', (mod.instances || []).map((x, j) => (j === ii ? { ...x, sshId: ev.target.value } : x))),
            },
              (sshs || []).map((s) => h('option', { key: s.id, value: s.id }, s.name || s.id))),
            h('input', {
              className: 'dad-input', type: 'text', value: inst.healthCheckUrl, placeholder: '探活 URL（可空，默认用模块的）',
              'aria-label': '实例 ' + (ii + 1) + ' 健康检查 URL',
              onChange: (ev) => onChange('instances', (mod.instances || []).map((x, j) => (j === ii ? { ...x, healthCheckUrl: ev.target.value } : x))),
            }),
            h('input', {
              className: 'dad-input', type: 'text', value: inst.healthCheckPattern || '', placeholder: '成功正则（可空，默认用模块的）',
              spellCheck: false, 'aria-label': '实例 ' + (ii + 1) + ' 成功内容正则',
              onChange: (ev) => onChange('instances', (mod.instances || []).map((x, j) => (j === ii ? { ...x, healthCheckPattern: ev.target.value } : x))),
            }),
            h('button', {
              type: 'button', className: 'dad-btndel', title: '删除实例', 'aria-label': '删除实例 ' + (ii + 1),
              style: { position: 'static' },
              onClick: () => onChange('instances', (mod.instances || []).filter((_, j) => j !== ii)),
            }, '×')))),
        mod.kind === 'front'
          ? h('div', { className: 'dad-row' },
            h(Field, { label: feLabel, wide: true },
              h('textarea', {
                className: 'dad-textarea', rows: 4, spellCheck: false, value: mod.frontEnv,
                'aria-label': 'frontEnv',
                onChange: (ev) => onChange('frontEnv', ev.target.value),
              })))
          : null)
    }

    function EnvForm({
      env, isNew, groups, message, open, tab, onTab, moduleIndex, onModuleIndex, onToggle,
      onPatch, onPatchSsh, onPatchModule, onAddModule, onDeleteModule,
      onSave, onDelete, onBrowse, onBrowseKey, onBrowseJumpKey,
      onAddSsh, onDeleteSsh, onTestSsh, sshTest,
      jdks, jdkOpen, jdkRef, onJdkFocus, onJdkPick,
      nodes, nodeOpen, nodeRef, nodeErr, onNodeFocus, onNodePick,
      pms, pmOpen, pmRef, pmErr, onPmFocus, onPmPick,
    }) {
      const title = env ? '环境配置' : '选择左侧环境进行编辑'
      const groupOptions = groups.map((g) => h('option', { key: g, value: g }))
      const sshList = env ? (env.sshs || []) : []
      const active = ENV_TABS.some((t) => t.id === tab) ? tab : 'basic'
      const sshCount = sshList.length
      const moduleCount = env ? env.modules.length : 0
      const tabListRef = useRef(null)
      const focusTab = useRef('')
      useEffect(() => {
        if (!focusTab.current || focusTab.current !== active) return
        const root = tabListRef.current
        const btn = root && root.querySelector('[data-tab="' + active + '"]')
        focusTab.current = ''
        if (btn) btn.focus()
      }, [active])
      function tabCount(id) {
        if (id === 'ssh') return sshCount
        if (id === 'modules') return moduleCount
        return 0
      }
      function onTabKey(ev) {
        if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight' && ev.key !== 'Home' && ev.key !== 'End') return
        const i = ENV_TABS.findIndex((t) => t.id === active)
        let next = i
        if (ev.key === 'ArrowLeft') next = (i + ENV_TABS.length - 1) % ENV_TABS.length
        else if (ev.key === 'ArrowRight') next = (i + 1) % ENV_TABS.length
        else if (ev.key === 'Home') next = 0
        else next = ENV_TABS.length - 1
        ev.preventDefault()
        focusTab.current = ENV_TABS[next].id
        onTab(ENV_TABS[next].id)
      }
      return h('div', { className: 'dad-card' },
        h('div', { className: 'dad-card-head' },
          h('span', { className: 'dad-card-title', title }, title),
          // 收起时把最近一次保存结果留在标题栏，避免反馈丢失
          !open && message ? h('span', { className: 'dad-msg ' + (message.kind || '') }, message.text) : null,
          h('button', {
            type: 'button', className: 'dad-btn', onClick: onToggle,
            title: open ? '收缩编辑面板' : '展开编辑面板',
            'aria-expanded': open ? 'true' : 'false',
          }, open ? '‹' : '›')),
        !env
          ? h('div', { className: 'dad-hint' }, '选择或新增一个环境后编辑配置。')
          : (open ? h('div', null,
            h('div', { className: 'dad-tabs', role: 'tablist', 'aria-label': '环境配置', ref: tabListRef },
              ENV_TABS.map((t) => {
                const selected = t.id === active
                const count = tabCount(t.id)
                return h('button', {
                  key: t.id, type: 'button', role: 'tab',
                  className: 'dad-tab', 'data-tab': t.id,
                  id: 'dad-env-tab-' + t.id,
                  'aria-selected': selected ? 'true' : 'false',
                  'aria-controls': 'dad-env-panel-' + t.id,
                  tabIndex: selected ? 0 : -1,
                  onClick: () => onTab(t.id),
                  onKeyDown: onTabKey,
                },
                  t.label,
                  count ? h('span', { className: 'dad-tab-count' }, String(count)) : null)
              })),
            h('div', {
              className: 'dad-sec', role: 'tabpanel', id: 'dad-env-panel-basic',
              'aria-labelledby': 'dad-env-tab-basic', hidden: active !== 'basic',
            },
              active !== 'basic' ? null : h('div', null,
              h('div', { className: 'dad-row' },
                h(Field, { label: '名称' },
                  h('input', {
                    className: 'dad-input', type: 'text', value: env.name, 'aria-label': '名称',
                    onChange: (ev) => onPatch({ name: ev.target.value }),
                  })),
                h(Field, { label: 'ID（小写字母/数字/连字符）' },
                  h('input', {
                    className: 'dad-input', type: 'text', value: env.id, disabled: !isNew,
                    'aria-label': '环境 ID', title: isNew ? '' : '已保存环境的 ID 不可修改',
                    onChange: (ev) => onPatch({ id: ev.target.value }),
                  })),
                h(Field, { label: '备注' },
                  h('input', {
                    className: 'dad-input', type: 'text', value: env.note, 'aria-label': '备注',
                    onChange: (ev) => onPatch({ note: ev.target.value }),
                  })),
                h(Field, { label: '分组（可留空）' },
                  h('input', {
                    className: 'dad-input', type: 'text', value: env.group, list: 'dad-group-list',
                    'aria-label': '分组', onChange: (ev) => onPatch({ group: ev.target.value }),
                  })),
                h('datalist', { id: 'dad-group-list' }, groupOptions)),
              h('div', { className: 'dad-row' },
                h(Field, { label: '项目路径（本地仓库根目录）', wide: true },
                  h('div', { className: 'dad-inline' },
                    h('input', {
                      className: 'dad-input', type: 'text', value: env.projectPath,
                      'aria-label': '项目路径', onChange: (ev) => onPatch({ projectPath: ev.target.value }),
                    }),
                    h('button', { type: 'button', className: 'dad-btn', onClick: onBrowse }, '浏览…'))),
                h(Field, { label: 'JDK 路径（JAVA_HOME，可留空）', wide: true },
                  h(PathPicker, {
                    value: env.jdkHome, aria: 'JDK 路径', items: jdks, open: jdkOpen, wrapRef: jdkRef,
                    onFocus: onJdkFocus, onChange: (v) => onPatch({ jdkHome: v }), onPick: onJdkPick,
                    emptyText: '未发现可用 JDK',
                  }))),
              h('div', { className: 'dad-row' },
                h(Field, { label: 'Node 路径（构建时加入 PATH，可留空）', wide: true },
                  h(PathPicker, {
                    value: env.nodeHome || '', aria: 'Node 路径', items: nodes, open: nodeOpen, wrapRef: nodeRef,
                    onFocus: onNodeFocus, onChange: (v) => onPatch({ nodeHome: v }), onPick: onNodePick,
                    emptyText: nodeErr || '未发现已装 Node（支持 nvm / n / fnm / volta）',
                  })),
                h(Field, { label: 'Node options（NODE_OPTIONS，可留空）' },
                  h('input', {
                    className: 'dad-input', type: 'text', value: env.nodeOptions || '', 'aria-label': 'Node options',
                    onChange: (ev) => onPatch({ nodeOptions: ev.target.value }),
                  }))),
              h('div', { className: 'dad-row' },
                h(Field, { label: '包管理器路径（如 …/pnpm，构建时加入 PATH，可留空）', wide: true },
                  h(PathPicker, {
                    value: env.pmPath || '', aria: '包管理器路径', items: pms, open: pmOpen, wrapRef: pmRef,
                    onFocus: onPmFocus, onChange: (v) => onPatch({ pmPath: v }), onPick: onPmPick,
                    emptyText: pmErr || '未发现 pnpm / yarn（npm 随 Node 自动可用）',
                  }))),
              h('div', { className: 'dad-row' },
                h(Field, { label: '构建环境变量（KEY=VALUE 多行，构建时注入所有模块，可留空）', wide: true },
                  h('textarea', {
                    className: 'dad-textarea', rows: 3, spellCheck: false, value: env.buildEnv || '',
                    'aria-label': '构建环境变量',
                    onChange: (ev) => onPatch({ buildEnv: ev.target.value }),
                  }))),
              h('div', { className: 'dad-row' },
                h(Field, { label: '过期时间 expTime（YYYY-MM-DD，可留空）' },
                  h('input', {
                    className: 'dad-input', type: 'date', value: env.expTime, 'aria-label': '过期时间',
                    onChange: (ev) => onPatch({ expTime: ev.target.value }),
                  }))))),
            h('div', {
              className: 'dad-sec', role: 'tabpanel', id: 'dad-env-panel-ssh',
              'aria-labelledby': 'dad-env-tab-ssh', hidden: active !== 'ssh',
            },
              active !== 'ssh' ? null : h('div', null,
              h('div', { className: 'dad-sec-title' }, '模块可选发布到任一目标'),
              sshList.map((s, i) => {
                const t = (sshTest || {})[i]
                return h('div', { key: s.id || i, className: 'dad-sshtarget' },
                  h('div', { className: 'dad-row' },
                    h(Field, { label: '目标名称' },
                      h('input', {
                        className: 'dad-input', type: 'text', value: s.name, 'aria-label': 'SSH 目标名称',
                        onChange: (ev) => onPatchSsh(i, { name: ev.target.value }),
                      })),
                    h(Field, { label: 'ID（字母/数字/连字符）' },
                      h('input', {
                        className: 'dad-input', type: 'text', value: s.id, 'aria-label': 'SSH 目标 ID',
                        onChange: (ev) => onPatchSsh(i, { id: ev.target.value }),
                      })),
                    sshList.length > 1
                      ? h('button', {
                        type: 'button', className: 'dad-btndel', title: '删除目标', 'aria-label': '删除 SSH 目标',
                        onClick: () => onDeleteSsh(i),
                      }, '×')
                      : null),
                  h('div', { className: 'dad-row' },
                    h(Field, { label: 'Host' },
                      h('input', {
                        className: 'dad-input', type: 'text', value: s.host, 'aria-label': 'SSH Host',
                        onChange: (ev) => onPatchSsh(i, { host: ev.target.value }),
                      })),
                    h(Field, { label: 'Port' },
                      h('input', {
                        className: 'dad-input', type: 'number', value: s.port, 'aria-label': 'SSH Port',
                        onChange: (ev) => onPatchSsh(i, { port: ev.target.value }),
                      })),
                    h(Field, { label: 'User' },
                      h('input', {
                        className: 'dad-input', type: 'text', value: s.user, 'aria-label': 'SSH User',
                        onChange: (ev) => onPatchSsh(i, { user: ev.target.value }),
                      }))),
                  h('div', { className: 'dad-row' },
                    h(Field, { label: '密码（留空=ssh-agent/密钥）' },
                      h('input', {
                        className: 'dad-input', type: 'password', value: s.password, 'aria-label': 'SSH 密码',
                        autoComplete: 'new-password',
                        onChange: (ev) => onPatchSsh(i, { password: ev.target.value }),
                      })),
                    h(Field, { label: '私钥路径（留空=默认密钥/agent，优先于选项里的 -i）', wide: true },
                      h('div', { className: 'dad-inline' },
                        h('input', {
                          className: 'dad-input', type: 'text', value: s.keyFile || '', 'aria-label': '私钥路径',
                          onChange: (ev) => onPatchSsh(i, { keyFile: ev.target.value }),
                        }),
                        h('button', { type: 'button', className: 'dad-btn', onClick: () => onBrowseKey(i) }, '浏览…')))),
                  h('div', { className: 'dad-row' },
                    h(Field, { label: '自定义 ssh 选项（如 -o StrictHostKeyChecking=no）', wide: true },
                      h('input', {
                        className: 'dad-input', type: 'text', value: s.options, 'aria-label': '自定义 ssh 选项',
                        onChange: (ev) => onPatchSsh(i, { options: ev.target.value }),
                      }))),
                  h('div', { className: 'dad-row' },
                    h(Field, { label: '连接方式' },
                      h('select', {
                        className: 'dad-select', value: s.proxyType || '', 'aria-label': '连接方式',
                        onChange: (ev) => onPatchSsh(i, { proxyType: ev.target.value }),
                      },
                        h('option', { value: '' }, '直连'),
                        h('option', { value: 'jump' }, 'SSH 跳板'),
                        h('option', { value: 'socks5' }, 'SOCKS5 代理'),
                        h('option', { value: 'http' }, 'HTTP 代理'))),
                    s.proxyType === 'jump'
                      ? h(Field, { label: '跳板 Host' },
                          h('input', {
                            className: 'dad-input', type: 'text', value: s.jumpHost || '', 'aria-label': '跳板 Host',
                            onChange: (ev) => onPatchSsh(i, { jumpHost: ev.target.value }),
                          }))
                      : null,
                    s.proxyType === 'jump'
                      ? h(Field, { label: '跳板 Port' },
                          h('input', {
                            className: 'dad-input', type: 'number', value: s.jumpPort || 22, 'aria-label': '跳板 Port',
                            onChange: (ev) => onPatchSsh(i, { jumpPort: ev.target.value }),
                          }))
                      : null),
                  s.proxyType === 'jump'
                    ? h('div', { className: 'dad-row' },
                        h(Field, { label: '跳板 User' },
                          h('input', {
                            className: 'dad-input', type: 'text', value: s.jumpUser || 'root', 'aria-label': '跳板 User',
                            onChange: (ev) => onPatchSsh(i, { jumpUser: ev.target.value }),
                          })),
                        h(Field, { label: '跳板私钥路径（留空=默认密钥/agent，跳板仅支持密钥/agent 认证）', wide: true },
                          h('div', { className: 'dad-inline' },
                            h('input', {
                              className: 'dad-input', type: 'text', value: s.jumpKeyFile || '', 'aria-label': '跳板私钥路径',
                              onChange: (ev) => onPatchSsh(i, { jumpKeyFile: ev.target.value }),
                            }),
                            h('button', { type: 'button', className: 'dad-btn', onClick: () => onBrowseJumpKey(i) }, '浏览…'))))
                    : null,
                  s.proxyType === 'socks5' || s.proxyType === 'http'
                    ? h('div', { className: 'dad-row' },
                        h(Field, { label: '代理 Host' },
                          h('input', {
                            className: 'dad-input', type: 'text', value: s.proxyHost || '', 'aria-label': '代理 Host',
                            onChange: (ev) => onPatchSsh(i, { proxyHost: ev.target.value }),
                          })),
                        h(Field, { label: s.proxyType === 'socks5' ? '代理 Port（留空=1080）' : '代理 Port（留空=8080）' },
                          h('input', {
                            className: 'dad-input', type: 'number', value: s.proxyPort || '', 'aria-label': '代理 Port',
                            onChange: (ev) => onPatchSsh(i, { proxyPort: ev.target.value }),
                          })))
                    : null,
                  h('div', { className: 'dad-inline' },
                    h('button', {
                      type: 'button', className: 'dad-btn', onClick: () => onTestSsh(i),
                      disabled: t && t.state === 'run',
                    }, t && t.state === 'run' ? '测试中…' : '测试连接'),
                    t && t.state !== 'run'
                      ? h('span', { className: 'dad-msg ' + (t.state === 'ok' ? 'ok' : 'err') }, t.text)
                      : null))
              }),
              h('div', { className: 'dad-row' },
                h('button', { type: 'button', className: 'dad-btn', onClick: onAddSsh }, '+ 添加 SSH 目标')),
              h('div', { className: 'dad-hint' },
                '密码留空时使用本机 ssh-agent / 密钥认证；密码只经 sshpass 环境变量传递，不会写入日志。跳板仅支持密钥/agent 认证（sshpass 无法应答两级密码）；SOCKS5/HTTP 代理走 OpenBSD nc、不支持代理自身认证；代理/跳板 + 密码的组合在 rclone 回退同步下不可用（须 rsync 或改用密钥）'))),
            h('div', {
              className: 'dad-sec', role: 'tabpanel', id: 'dad-env-panel-modules',
              'aria-labelledby': 'dad-env-tab-modules', hidden: active !== 'modules',
            },
              active !== 'modules' ? null : h(ModuleTabs, {
                modules: env.modules, sshs: sshList, index: moduleIndex,
                onIndex: onModuleIndex,
                onChange: onPatchModule, onDelete: onDeleteModule, onAdd: onAddModule,
              })),
            h('div', { className: 'dad-formfoot' },
              h('button', { type: 'button', className: 'dad-btn dad-btn-primary', onClick: onSave }, '保存环境'),
              h('button', { type: 'button', className: 'dad-btn dad-btn-danger', onClick: onDelete }, '删除此环境'),
              message ? h('span', { className: 'dad-msg ' + (message.kind || '') }, message.text) : null))
            : null))
    }

    function GitBar({ env, git, buildPath, onPickPath }) {
      if (!env || !normPath(env.projectPath)) {
        return h('div', { className: 'dad-gitbar' }, h('span', { className: 'dad-muted' }, '（未选择环境或项目路径为空）'))
      }
      const eff = buildPath || normPath(env.projectPath)
      const worktrees = (git && git.worktrees) || []
      let head = null
      if (!git || git.state === 'loading') head = h('span', { className: 'dad-muted' }, '正在读取 git 信息…')
      else if (git.state === 'error') head = h('span', { className: 'dad-err' }, '无法读取 git 信息')
      else if (git.state === 'nogit') head = h('span', { className: 'dad-muted' }, '该项目不是 git 仓库')
      else {
        head = h('span', { className: 'dad-ghead' },
          h('span', { className: 'dad-branch' }, git.detached ? 'HEAD（游离）' : (git.branch || '?')),
          git.detached ? null : h('span', { className: 'dad-mono' }, git.shortCommit ? '#' + git.shortCommit : ''))
      }
      return h('div', { className: 'dad-gitbar' },
        head,
        buildPath ? h('span', { className: 'dad-gtmp' }, '临时构建路径') : null,
        h('span', { className: 'dad-gpath', title: eff }, eff),
        worktrees.length > 1
          ? h('select', {
            className: 'dad-select dad-gsel', value: eff,
            title: '临时选择本次部署要构建的 worktree（仅本次会话有效，不修改环境配置）',
            'aria-label': '临时构建路径',
            onChange: (ev) => onPickPath(ev.target.value),
          }, worktrees.map((w) => h('option', { key: w.path, value: w.path },
            (w.branch || w.head || '?') + ' — ' + w.path)))
          : null)
    }

    function ExportDialog({ envs, selectedIds, onToggle, onToggleAll, onClose, onConfirm }) {
      const allOn = envs.length > 0 && selectedIds.length === envs.length
      const buckets = new Map()
      const order = []
      const ungrouped = []
      for (const e of envs) {
        const g = (e.group || '').trim()
        if (!g) { ungrouped.push(e); continue }
        if (!buckets.has(g)) { buckets.set(g, []); order.push(g) }
        buckets.get(g).push(e)
      }
      const groups = order.map((g) => [g, buckets.get(g)])
      if (ungrouped.length) groups.push(['未分组', ungrouped])
      const rows = []
      for (const [g, list] of groups) {
        if (groups.length > 1) rows.push(h('div', { key: 'grp:' + g, className: 'dad-grp dad-export-grp' }, g))
        for (const e of list) {
          const on = selectedIds.includes(e.id)
          const sshList = e.sshs || []
          const ssh = sshList[0] || {}
          const sshText = ssh.host
            ? (ssh.user || 'root') + '@' + ssh.host + (sshList.length > 1 ? ' 等 ' + sshList.length + ' 个' : '')
            : 'SSH 未配置'
          const modCount = (e.modules || []).length
          rows.push(h('label', {
            key: e.id, className: 'dad-opt',
            'data-sel': on ? '1' : '0',
          },
            h('input', {
              type: 'checkbox', checked: on,
              onChange: () => onToggle(e.id),
            }),
            h('span', { className: 'dad-opt-main' },
              h('b', { className: 'dad-opt-name' }, e.name || e.id),
              h('span', { className: 'dad-sub' }, e.id + ' · ' + sshText + ' · ' + modCount + ' 个模块'))))
        }
      }
      return h('div', {
        className: 'dad-mask', role: 'presentation',
        onClick: onClose,
      },
        h('div', {
          className: 'dad-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '导出配置',
          onClick: (ev) => ev.stopPropagation(),
        },
          h('div', { className: 'dad-modal-head' },
            h('strong', null, '导出配置'),
            h('span', { className: 'dad-spacer' }),
            h('button', { type: 'button', className: 'dad-btn', onClick: onClose, 'aria-label': '关闭' }, '×')),
          h('div', { className: 'dad-modal-body' },
            h('div', { className: 'dad-modbar' },
              h('span', { className: 'dad-hint' }, '勾选要导出的环境（含 SSH 密码，请妥善保管）'),
              h('button', {
                type: 'button', className: 'dad-btn', onClick: onToggleAll,
                disabled: envs.length === 0,
              }, allOn ? '清空' : '全选')),
            h('div', { className: 'dad-export-list' }, rows)),
          h('div', { className: 'dad-modal-foot' },
            h('span', { className: 'dad-hint dad-export-count' }, '已选 ' + selectedIds.length + ' / ' + envs.length),
            h('span', { className: 'dad-spacer' }),
            h('button', { type: 'button', className: 'dad-btn', onClick: onClose }, '取消'),
            h('button', {
              type: 'button', className: 'dad-btn dad-btn-primary',
              disabled: selectedIds.length === 0,
              onClick: onConfirm,
            }, '导出'))))
    }

    function ConfirmDialog({ state, onClose }) {
      return h('div', {
        className: 'dad-mask', role: 'presentation',
        onClick: onClose,
      },
        h('div', {
          className: 'dad-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': state.title,
          onClick: (ev) => ev.stopPropagation(),
        },
          h('div', { className: 'dad-modal-head' },
            h('strong', null, state.title),
            h('span', { className: 'dad-spacer' }),
            h('button', { type: 'button', className: 'dad-btn', onClick: onClose, 'aria-label': '关闭' }, '×')),
          h('div', { className: 'dad-modal-body' },
            state.pre ? h('pre', { className: 'dad-plan' }, state.body) : h('div', { className: 'dad-plan-text' }, state.body)),
          h('div', { className: 'dad-modal-foot' },
            h('button', { type: 'button', className: 'dad-btn', onClick: onClose }, '取消'),
            h('button', {
              type: 'button',
              className: 'dad-btn ' + (state.danger ? 'dad-btn-danger-solid' : 'dad-btn-primary'),
              onClick: () => { const fn = state.onConfirm; onClose(); if (fn) fn() },
            }, state.confirmLabel || '确定'))))
    }

    function BrowseModal({ state, onClose, onNavigate, onUp, onPick, onSelectFile, onToggleHidden }) {
      return h('div', { className: 'dad-mask', role: 'presentation', onClick: onClose },
        h('div', {
          className: 'dad-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': state.file ? '选择文件' : '选择目录',
          onClick: (ev) => ev.stopPropagation(),
        },
          h('div', { className: 'dad-modal-head' },
            h('strong', null, state.file ? '选择文件' : '选择目录'),
            h('label', { className: 'dad-chk dad-autoflex' },
              h('input', {
                type: 'checkbox', checked: !!state.hidden,
                onChange: (ev) => onToggleHidden(ev.target.checked),
              }), '显示隐藏目录'),
            h('span', { className: 'dad-spacer' }),
            h('button', { type: 'button', className: 'dad-btn', onClick: onClose, 'aria-label': '关闭' }, '×')),
          h('div', { className: 'dad-modal-body' },
            h('div', { className: 'dad-browse-path' }, state.path || '（读取中…）'),
            state.error ? h('div', { className: 'dad-msg err' }, state.error) : null,
            state.worktrees && state.worktrees.length
              ? h('div', { className: 'dad-wts' },
                h('span', { className: 'dad-label' }, 'Worktrees'),
                state.worktrees.map((w) => h('button', {
                  key: w.path, type: 'button', className: 'dad-wt',
                  'data-cur': w.path === state.path ? '1' : '0',
                  title: w.path, disabled: w.path === state.path,
                  onClick: () => onNavigate(w.path),
                },
                  h('span', { className: 'dad-wbr' }, w.branch || w.head || '(detached)'),
                  w.head ? h('span', { className: 'dad-mono' }, w.head) : null)))
              : null,
            h('div', { className: 'dad-dirs' },
              state.error ? null : (state.loading ? h('div', { className: 'dad-hint' }, '读取中…')
                : (state.dirs || []).length ? null : h('div', { className: 'dad-hint' }, '（空目录）')),
              (state.dirs || []).map((dir) => h('button', {
                key: dir, type: 'button', className: 'dad-dir',
                onClick: () => onNavigate(dir),
              }, dir))),
            state.file
              ? h('div', { className: 'dad-dirs' },
                (state.files || []).length ? null : h('div', { className: 'dad-hint' }, '（无文件）'),
                (state.files || []).map((f) => h('button', {
                  key: f, type: 'button', className: 'dad-dir', 'data-sel': state.sel === f ? '1' : '0',
                  onClick: () => onSelectFile(f),
                }, f)))
              : null),
          h('div', { className: 'dad-modal-foot' },
            h('button', {
              type: 'button', className: 'dad-btn', onClick: onUp,
              disabled: state.loading || !state.path || state.path === '/',
            }, '上级'),
            state.file
              ? h('button', {
                type: 'button', className: 'dad-btn dad-btn-primary', onClick: onPick,
                disabled: state.loading || !state.path || !state.sel,
              }, '选择此文件')
              : h('button', {
                type: 'button', className: 'dad-btn dad-btn-primary', onClick: onPick,
                disabled: state.loading || !state.path,
              }, '选择当前目录'))))
    }

    // ---------- 主面板 ----------

    function Panel({ initialEnvId } = {}) {
      const [envs, setEnvs] = useState([])
      const [defProject, setDefProject] = useState('')
      const [lastBuild, setLastBuild] = useState({})
      const [loadError, setLoadError] = useState('')
      const [draft, setDraft] = useState(null)
      const [formOpen, setFormOpen] = useState(true)
      const [formTab, setFormTab] = useState('basic')
      const [moduleIndex, setModuleIndex] = useState(0)
      const [formMsg, setFormMsg] = useState(null)
      // 全局提示：导入等不依赖当前选中环境的操作也必须有可见反馈
      const [notice, setNotice] = useState(null)

      const [jdks, setJdks] = useState([])
      const [jdkOpen, setJdkOpen] = useState(false)
      const jdkRef = useRef(null)

      const [nodes, setNodes] = useState([])
      const [nodeErr, setNodeErr] = useState('')

      const [pms, setPms] = useState([])
      const [pmErr, setPmErr] = useState('')
      const [pmOpen, setPmOpen] = useState(false)
      const pmRef = useRef(null)
      const [sshTest, setSshTest] = useState({}) // { [目标index]: { state: 'run'|'ok'|'err', text } }
      const [nodeOpen, setNodeOpen] = useState(false)
      const nodeRef = useRef(null)

      const [browse, setBrowse] = useState(null)

      const [selected, setSelected] = useState([])
      const [buildPath, setBuildPath] = useState('')
      const [gitInfo, setGitInfo] = useState(null)

      const [logText, setLogText] = useState('')
      const [deployState, setDeployState] = useState({ running: false, text: '', kind: '' })
      const [history, setHistory] = useState([])
      const [historyState, setHistoryState] = useState('')
      const [historyTick, setHistoryTick] = useState(0)

      const [confirmState, setConfirmState] = useState(null)
      const [exportOpen, setExportOpen] = useState(false)
      const [exportIds, setExportIds] = useState([])

      const logRef = useRef(null)
      const esRef = useRef(null)
      const importRef = useRef(null)
      const keyPickRef = useRef(null) // 文件浏览弹窗的选中回调（私钥选择用）
      const dragIdRef = useRef(null)
      const [draggingId, setDraggingId] = useState('')
      const [dragOverId, setDragOverId] = useState('')
      const frontEnvFetched = useRef(new Set())

      const envId = draft && envs.some((e) => e.id === draft.id) ? draft.id : ''
      const isNew = !!draft && !envs.some((e) => e.id === draft.id)
      const groups = Array.from(new Set(envs.map((e) => (e.group || '').trim()).filter(Boolean)))
      const enabledModules = draft ? draft.modules.filter((m) => m.enabled) : []
      const moduleById = {}
      if (draft) for (const m of draft.modules) moduleById[m.id] = m

      // 首次加载配置；之后只刷新最后构建时间
      useEffect(() => {
        let cancelled = false
        rpc('config').then((d) => {
          if (cancelled) return
          const list = Array.isArray(d && d.envs) ? d.envs : []
          setEnvs(list)
          syncDeployEnvs(list)
          setDefProject((d && d.defaultProjectPath) || '')
          setLastBuild((d && d.lastBuild) || {})
          setDraft((prev) => {
            if (prev) {
              const match = list.find((e) => e.id === prev.id)
              if (match) return normalizeEnv(match)
            }
            const pick = (initialEnvId && list.find((e) => e.id === initialEnvId)) || list[0]
            return pick ? normalizeEnv(pick) : null
          })
        }).catch((error) => { if (!cancelled) setLoadError(error.message || String(error)) })
        return () => { cancelled = true }
      }, [])

      // 全局提示 6 秒后自动消失
      useEffect(() => {
        if (!exportOpen) return undefined
        function onKey(ev) {
          if (ev.key === 'Escape') setExportOpen(false)
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [exportOpen])

      useEffect(() => {
        if (!notice) return undefined
        const timer = setTimeout(() => setNotice(null), 6000)
        return () => clearTimeout(timer)
      }, [notice])

      // 组件卸载时断开日志流
      useEffect(() => () => {
        if (esRef.current) { try { esRef.current.close() } catch { /* 已关闭 */ } }
      }, [])

      function refreshLastBuild() {
        rpc('config').then((d) => setLastBuild((d && d.lastBuild) || {})).catch(() => {})
      }

      // 选中环境/模块变化时清理失效的勾选
      useEffect(() => {
        setSelected((prev) => {
          const ids = new Set(enabledModules.map((m) => m.id))
          const next = prev.filter((id) => ids.has(id))
          return next.length === prev.length ? prev : next
        })
      }, [draft && draft.id, draft && draft.modules])

      // 切换环境时临时构建路径回落到环境自身路径
      useEffect(() => { setBuildPath('') }, [draft && draft.id])

      // 读取 git 信息（生效路径 = 临时构建路径 || 项目路径）
      useEffect(() => {
        if (!envId || !draft || !normPath(draft.projectPath)) { setGitInfo(null); return undefined }
        let cancelled = false
        setGitInfo({ state: 'loading' })
        const args = { env: envId }
        if (buildPath) args.path = buildPath
        rpc('git', args).then((d) => {
          if (cancelled) return
          if (!d || !d.ok || !d.isGit) {
            setGitInfo({ state: d && d.ok ? 'nogit' : 'error' })
            return
          }
          const worktrees = Array.isArray(d.worktrees) ? d.worktrees : []
          if (buildPath && !worktrees.some((w) => w.path === buildPath)) setBuildPath('')
          setGitInfo({
            state: 'ok', branch: d.branch || '', shortCommit: d.shortCommit || '',
            detached: !!d.detached, worktrees,
          })
        }).catch(() => { if (!cancelled) setGitInfo({ state: 'error' }) })
        return () => { cancelled = true }
      }, [envId, draft && draft.projectPath, buildPath, envs])

      // 执行记录（当前环境最近 20 条）
      useEffect(() => {
        if (!envId) { setHistory([]); setHistoryState(''); return undefined }
        let cancelled = false
        setHistoryState('loading')
        rpc('history', { env: envId, limit: 20 }).then((list) => {
          if (cancelled) return
          setHistory(Array.isArray(list) ? list : [])
          setHistoryState('')
        }).catch(() => { if (!cancelled) setHistoryState('error') })
        return () => { cancelled = true }
      }, [envId, historyTick])

      // frontEnv 为空的前端模块读取 .env 参考文本（用户已填写则不覆盖）
      useEffect(() => {
        if (!envId || !draft) return
        for (const m of draft.modules) {
          if (m.kind !== 'front' || m.frontEnv) continue
          const key = envId + '::' + m.id
          if (frontEnvFetched.current.has(key)) continue
          frontEnvFetched.current.add(key)
          rpc('frontEnv', { env: envId, module: m.id }).then((d) => {
            const text = d && typeof d.text === 'string' ? d.text : ''
            if (!text) return
            setDraft((prev) => {
              if (!prev || prev.id !== envId) return prev
              let changed = false
              const modules = prev.modules.map((x) => {
                if (x.id === m.id && x.kind === 'front' && !x.frontEnv) {
                  changed = true
                  return { ...x, frontEnv: text }
                }
                return x
              })
              return changed ? { ...prev, modules } : prev
            })
          }).catch(() => { /* 读不到参考文本就留空 */ })
        }
      }, [envId, draft && draft.modules])

      // 日志自动滚到底部
      useEffect(() => {
        const el = logRef.current
        if (el) el.scrollTop = el.scrollHeight
      }, [logText])

      // JDK/Node/包管理器 下拉：点击空白处关闭
      useEffect(() => {
        if (!jdkOpen && !nodeOpen && !pmOpen) return undefined
        function onDocDown(ev) {
          if (jdkOpen && jdkRef.current && !jdkRef.current.contains(ev.target)) setJdkOpen(false)
          if (nodeOpen && nodeRef.current && !nodeRef.current.contains(ev.target)) setNodeOpen(false)
          if (pmOpen && pmRef.current && !pmRef.current.contains(ev.target)) setPmOpen(false)
        }
        document.addEventListener('mousedown', onDocDown)
        return () => document.removeEventListener('mousedown', onDocDown)
      }, [jdkOpen, nodeOpen, pmOpen])

      // ---------- 环境操作 ----------

      function selectEnv(env) {
        setDraft(normalizeEnv(env))
        setSelected([])
        setFormTab('basic')
        setModuleIndex(0)
        setFormMsg(null)
      }
      function addEnv() {
        const env = {
          id: newEnvId(envs), name: '新环境', note: '', group: '',
          projectPath: defProject, jdkHome: '', nodeHome: '', nodeOptions: '', pmPath: '', buildEnv: '', expTime: '',
          sshs: [{ id: 'default', name: '默认', host: '', port: 22, user: 'root', password: '', keyFile: '', options: '', proxyType: '', jumpHost: '', jumpPort: 22, jumpUser: 'root', jumpKeyFile: '', proxyHost: '', proxyPort: 0 }],
          modules: [],
        }
        setDraft(env)
        setSelected([])
        setFormOpen(true)
        setFormTab('basic')
        setModuleIndex(0)
        setFormMsg({ text: '新环境尚未保存，填写后点击「保存环境」', kind: 'warn' })
      }
      function copyEnv(source) {
        const copy = normalizeEnv(source)
        let id = source.id + '-copy'
        let n = 2
        while (envs.some((e) => e.id === id)) id = source.id + '-copy' + (n++)
        copy.id = id
        copy.name = source.name + '（副本）'
        setDraft(copy)
        setSelected([])
        setFormOpen(true)
        setFormTab('basic')
        setModuleIndex(0)
        setFormMsg({ text: '副本尚未保存，点击「保存环境」后写入配置', kind: 'warn' })
      }
      function askDeleteEnv(env) {
        setConfirmState({
          title: '删除环境',
          body: '删除环境 ' + (env.name || env.id) + '（' + env.id + '）？此操作会写回配置。',
          danger: true,
          confirmLabel: '删除',
          onConfirm: () => {
            rpc('deleteEnv', { id: env.id }).then((d) => {
              const list = Array.isArray(d && d.envs) ? d.envs : []
              setEnvs(list)
              syncDeployEnvs(list)
              setSelected([])
              setFormMsg(null)
              setDraft((prev) => {
                if (prev && prev.id !== env.id) return prev
                return list.length ? normalizeEnv(list[0]) : null
              })
            }).catch((error) => setFormMsg({ text: '删除失败：' + (error.message || error), kind: 'err' }))
          },
        })
      }
      function deleteCurrentEnv() {
        if (!draft) return
        if (isNew) {
          setSelected([])
          setFormMsg(null)
          setDraft(envs.length ? normalizeEnv(envs[0]) : null)
          return
        }
        askDeleteEnv(draft)
      }

      // ---------- 导入 / 导出配置 ----------

      // 打开勾选框；默认全选。下载内容与 envs.json 同构，可直接用于「导入」（含 SSH 密码）
      function openExport() {
        if (!envs.length) return
        setExportIds(envs.map((e) => e.id))
        setExportOpen(true)
      }
      function toggleExportId(id) {
        setExportIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : prev.concat(id)))
      }
      function toggleExportAll() {
        setExportIds((prev) => (prev.length === envs.length ? [] : envs.map((e) => e.id)))
      }
      function confirmExport() {
        const picked = envs.filter((e) => exportIds.includes(e.id))
        if (!picked.length) return
        const d = new Date()
        const date = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
        const blob = new Blob([JSON.stringify(picked, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = 'envs-' + date + '.json'
        document.body.appendChild(a)
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
        setExportOpen(false)
        setNotice({ text: '已导出 ' + picked.length + ' 个环境（含 SSH 密码，请妥善保管）', kind: 'ok' })
      }

      function openImport() {
        if (importRef.current) importRef.current.click()
      }
      async function importFile(ev) {
        const input = ev.target
        const file = input.files && input.files[0]
        input.value = '' // 允许重复选择同一文件
        if (!file) return
        let text
        try { text = await file.text() } catch {
          setNotice({ text: '读取文件失败', kind: 'err' })
          return
        }
        // 客户端只预览要覆盖哪些 ID；解析/校验/合并以服务端为准
        let ids = []
        try {
          const data = JSON.parse(text)
          const list = Array.isArray(data) ? data : (data && Array.isArray(data.envs) ? data.envs : [])
          ids = list.map((e) => String((e && e.id) || '')).filter(Boolean)
          if (!ids.length) throw new Error('没有环境（需为环境数组，元素含 id）')
        } catch (error) {
          setNotice({ text: '导入失败：' + (error.message || error), kind: 'err' })
          return
        }
        const overwritten = ids.filter((id) => envs.some((e) => e.id === id))
        setConfirmState({
          title: '导入配置',
          body: '将导入 ' + ids.length + ' 个环境：' + ids.join('、') + '。'
            + (overwritten.length ? '以下 ID 与本地相同，将被导入文件覆盖：' + overwritten.join('、') + '。' : ''),
          danger: overwritten.length > 0,
          confirmLabel: '导入',
          onConfirm: () => doImport(text),
        })
      }
      function doImport(text) {
        rpc('importEnvs', { content: text }).then((d) => {
          const next = Array.isArray(d && d.envs) ? d.envs : []
          const added = Array.isArray(d && d.added) ? d.added : []
          const overwritten = Array.isArray(d && d.overwritten) ? d.overwritten : []
          const warning = (d && d.warning) || ''
          setEnvs(next)
          syncDeployEnvs(next)
          setSelected([])
          const targetId = added[0] || overwritten[0] || ''
          setDraft((prev) => {
            const target = next.find((e) => e.id === targetId)
              || (prev && next.find((e) => e.id === prev.id))
              || next[0]
            return target ? normalizeEnv(target) : null
          })
          setNotice({
            text: '已导入 ' + (added.length + overwritten.length) + ' 个环境'
              + (overwritten.length ? '，覆盖：' + overwritten.join('、') : '')
              + (warning ? '；' + warning : ''),
            kind: warning ? 'warn' : 'ok',
          })
        }).catch((error) => {
          setNotice({ text: '导入失败：' + (error.message || error), kind: 'err' })
        })
      }

      function patchEnv(patch) {
        setDraft((prev) => (prev ? { ...prev, ...patch } : prev))
      }
      function patchSsh(index, patch) {
        setDraft((prev) => (prev
          ? { ...prev, sshs: (prev.sshs || []).map((s, i) => (i === index ? { ...s, ...patch } : s)) }
          : prev))
      }
      function addSsh() {
        setDraft((prev) => {
          if (!prev) return prev
          const n = (prev.sshs || []).length + 1
          return {
            ...prev,
            sshs: [...(prev.sshs || []), { id: 'ssh-' + Date.now().toString(36), name: 'SSH ' + n, host: '', port: 22, user: 'root', password: '', keyFile: '', options: '', proxyType: '', jumpHost: '', jumpPort: 22, jumpUser: 'root', jumpKeyFile: '', proxyHost: '', proxyPort: 0 }],
          }
        })
      }
      function deleteSsh(index) {
        setDraft((prev) => (prev && (prev.sshs || []).length > 1
          ? { ...prev, sshs: prev.sshs.filter((_, i) => i !== index) }
          : prev))
      }
      // 测试连接：直接用表单当前值（无需先保存环境）
      function runSshTest(index) {
        const t = draft && draft.sshs && draft.sshs[index]
        if (!t) return
        setSshTest((p) => ({ ...p, [index]: { state: 'run', text: '测试中…' } }))
        rpc('sshTest', {
          target: {
            host: (t.host || '').trim(), port: Number(t.port) || 22,
            user: (t.user || '').trim() || 'root', password: t.password || '',
            keyFile: (t.keyFile || '').trim(), options: (t.options || '').trim(),
            proxyType: t.proxyType || '', jumpHost: (t.jumpHost || '').trim(), jumpPort: Number(t.jumpPort) || 22,
            jumpUser: (t.jumpUser || '').trim() || 'root', jumpKeyFile: (t.jumpKeyFile || '').trim(),
            proxyHost: (t.proxyHost || '').trim(), proxyPort: Number(t.proxyPort) || 0,
          },
        })
          .then((r) => setSshTest((p) => ({
            ...p,
            [index]: r && r.ok ? { state: 'ok', text: '连接成功（' + r.ms + ' ms）' } : { state: 'err', text: '失败：' + ((r && r.error) || '未知错误') },
          })))
          .catch((e) => setSshTest((p) => ({ ...p, [index]: { state: 'err', text: '失败：' + String(e?.message || e) } })))
      }
      function patchModule(index, field, value) {
        setDraft((prev) => {
          if (!prev) return prev
          const modules = prev.modules.map((m, i) => (i === index ? { ...m, [field]: value } : m))
          return { ...prev, modules }
        })
      }
      function addModule() {
        setDraft((prev) => {
          if (!prev) return prev
          const next = prev.modules.concat([makeModule(prev.modules)])
          setModuleIndex(next.length - 1)
          return { ...prev, modules: next }
        })
      }
      function askDeleteModule(index) {
        if (!draft || !draft.modules[index]) return
        const mod = draft.modules[index]
        setConfirmState({
          title: '删除模块',
          body: '删除模块「' + (mod.name || mod.id) + '」？保存环境后生效。',
          danger: true,
          confirmLabel: '删除',
          onConfirm: () => setDraft((prev) => {
            if (!prev) return prev
            setModuleIndex((cur) => Math.max(0, Math.min(cur, prev.modules.length - 2)))
            return { ...prev, modules: prev.modules.filter((_m, i) => i !== index) }
          }),
        })
      }

      function saveEnv() {
        if (!draft) return
        const envIdValue = (draft.id || '').trim()
        if (!envIdValue) {
          setFormTab('basic')
          setFormMsg({ text: 'ID 不能为空', kind: 'err' })
          return
        }
        if (isNew && envs.some((e) => e.id === envIdValue)) {
          setFormTab('basic')
          setFormMsg({ text: 'ID「' + envIdValue + '」已被其他环境使用', kind: 'err' })
          return
        }
        const env = {
          id: envIdValue,
          name: (draft.name || '').trim() || '未命名',
          note: (draft.note || '').trim(),
          group: (draft.group || '').trim(),
          projectPath: (draft.projectPath || '').trim() || defProject,
          jdkHome: (draft.jdkHome || '').trim(),
          nodeHome: (draft.nodeHome || '').trim(),
          nodeOptions: (draft.nodeOptions || '').trim(),
          pmPath: (draft.pmPath || '').trim(),
          buildEnv: draft.buildEnv || '',
          expTime: draft.expTime || '',
          sshs: (draft.sshs || []).map((s) => ({
            id: (s.id || '').trim(),
            name: (s.name || '').trim(),
            host: (s.host || '').trim(),
            port: Number(s.port) || 22,
            user: (s.user || '').trim() || 'root',
            password: s.password || '',
            keyFile: (s.keyFile || '').trim(),
            options: (s.options || '').trim(),
            proxyType: s.proxyType || '',
            jumpHost: (s.jumpHost || '').trim(),
            jumpPort: Number(s.jumpPort) || 22,
            jumpUser: (s.jumpUser || '').trim() || 'root',
            jumpKeyFile: (s.jumpKeyFile || '').trim(),
            proxyHost: (s.proxyHost || '').trim(),
            proxyPort: Number(s.proxyPort) || 0,
          })),
          modules: draft.modules.map((m) => ({
            id: (m.id || '').trim(),
            name: (m.name || '').trim() || '新模块',
            kind: m.kind === 'server' ? 'server' : 'front',
            enabled: !!m.enabled,
            buildCmd: (m.buildCmd || '').trim(),
            buildDir: (m.buildDir || '').trim(),
            sshId: (m.sshId || '').trim(),
            instances: (m.instances || []).map((i) => ({ sshId: (i.sshId || '').trim(), healthCheckUrl: (i.healthCheckUrl || '').trim(), healthCheckPattern: (i.healthCheckPattern || '').trim() })),
            localPath: (m.localPath || '').trim(),
            remotePath: (m.remotePath || '').trim(),
            postCommand: (m.postCommand || '').trim(),
            healthCheckUrl: (m.healthCheckUrl || '').trim(),
            healthCheckPattern: (m.healthCheckPattern || '').trim(),
            frontEnv: m.frontEnv || '',
          })),
        }
        rpc('saveEnv', env).then((d) => {
          const list = Array.isArray(d && d.envs) ? d.envs : []
          setEnvs(list)
          syncDeployEnvs(list)
          const saved = list.find((x) => x.id === env.id) || env
          setDraft(normalizeEnv(saved))
          setFormOpen(false)
          setFormMsg({ text: (d && d.warning) || '已保存', kind: (d && d.warning) ? 'warn' : 'ok' })
        }).catch((error) => {
          const text = error.message || String(error)
          const target = saveErrorTarget(text, draft.modules)
          setFormTab(target.tab)
          if (target.moduleIndex >= 0) setModuleIndex(target.moduleIndex)
          setFormMsg({ text, kind: 'err' })
        })
      }

      // ---------- 路径浏览 ----------

      function loadBrowse(path, hidden, file) {
        setBrowse((prev) => ({
          path: prev ? prev.path : '',
          parent: prev ? prev.parent : '',
          dirs: prev ? prev.dirs : [],
          worktrees: prev ? prev.worktrees : [],
          files: prev && prev.file === !!file ? prev.files : [],
          file: !!file, sel: '',
          hidden: !!hidden, loading: true, error: '',
        }))
        const args = {}
        if (path) args.path = path
        if (hidden) args.hidden = true
        if (file) args.file = true
        rpc('browse', args).then((d) => {
          setBrowse({
            path: (d && d.path) || '',
            parent: (d && d.parent) || parentPath((d && d.path) || ''),
            dirs: Array.isArray(d && d.dirs) ? d.dirs : [],
            files: Array.isArray(d && d.files) ? d.files : [],
            worktrees: Array.isArray(d && d.worktrees) ? d.worktrees : [],
            file: !!file, sel: '',
            hidden: !!hidden, loading: false, error: '',
          })
        }).catch((error) => {
          setBrowse((prev) => ({
            path: prev ? prev.path : '',
            parent: prev ? prev.parent : '',
            dirs: [], worktrees: [], files: [],
            file: !!file, sel: '',
            hidden: !!hidden, loading: false,
            error: error.message || String(error),
          }))
        })
      }
      function openBrowse() {
        if (!draft) return
        keyPickRef.current = null
        loadBrowse((draft.projectPath || '').trim(), false, false)
      }
      // 选择私钥文件：从当前 keyFile 所在目录（或 ~/.ssh）起步，默认显示隐藏文件（密钥多为点开头无，但 .ssh 是隐藏目录）
      function openKeyBrowse(index) {
        const t = draft && draft.sshs && draft.sshs[index]
        keyPickRef.current = (p) => patchSsh(index, { keyFile: p })
        loadBrowse(t && t.keyFile ? parentPath(t.keyFile) : '~/.ssh', true, true)
      }
      // 选择跳板私钥文件：与目标私钥同一浏览模式（file:true），从跳板私钥所在目录（或 ~/.ssh）起步
      function openJumpKeyBrowse(index) {
        const t = draft && draft.sshs && draft.sshs[index]
        keyPickRef.current = (p) => patchSsh(index, { jumpKeyFile: p })
        loadBrowse(t && t.jumpKeyFile ? parentPath(t.jumpKeyFile) : '~/.ssh', true, true)
      }
      function navigateBrowse(target) {
        if (!browse) return
        loadBrowse(joinPath(browse.path, target), browse.hidden, browse.file)
      }
      function browseUp() {
        if (!browse) return
        loadBrowse(browse.parent || parentPath(browse.path), browse.hidden, browse.file)
      }
      function browsePick() {
        if (!browse || !browse.path) return
        if (browse.file) {
          if (!browse.sel) return
          if (keyPickRef.current) keyPickRef.current(joinPath(browse.path, browse.sel))
        } else {
          patchEnv({ projectPath: browse.path })
        }
        setBrowse(null)
      }
      function browseSelectFile(name) {
        setBrowse((prev) => (prev ? { ...prev, sel: name } : prev))
      }
      function browseToggleHidden(hidden) {
        if (!browse) return
        loadBrowse(browse.path, hidden, browse.file)
      }

      // ---------- JDK ----------

      function openJdk() {
        setJdkOpen(true)
        if (!jdks.length) {
          rpc('jdks').then((list) => setJdks(Array.isArray(list) ? list : [])).catch(() => setJdks([]))
        }
      }
      function pickJdk(path) {
        patchEnv({ jdkHome: path })
        setJdkOpen(false)
      }

      // ---------- Node ----------

      function openNode() {
        setNodeOpen(true)
        if (!nodes.length) {
          rpc('nodes').then((list) => setNodes(Array.isArray(list) ? list : [])).catch((e) => setNodeErr(String(e?.message || e)))
        }
      }
      function pickNode(path) {
        patchEnv({ nodeHome: path })
        setNodeOpen(false)
      }

      // ---------- 包管理器 ----------

      function openPm() {
        setPmOpen(true)
        if (!pms.length) {
          rpc('packageManagers').then((list) => setPms(Array.isArray(list) ? list : [])).catch((e) => setPmErr(String(e?.message || e)))
        }
      }
      function pickPm(path) {
        patchEnv({ pmPath: path })
        setPmOpen(false)
      }

      // ---------- 部署 ----------

      function toggleSel(id) {
        setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : prev.concat([id])))
      }
      function toggleSelAll() {
        const all = enabledModules.map((m) => m.id)
        setSelected((prev) => (all.length > 0 && prev.length === all.length ? [] : all))
      }
      function orderDrop(targetId) {
        const dragId = dragIdRef.current
        dragIdRef.current = null
        setDraggingId('')
        setDragOverId('')
        if (!dragId) return
        setSelected((prev) => {
          const from = prev.indexOf(dragId)
          if (from < 0) return prev
          const to = targetId ? prev.indexOf(targetId) : -1
          const arr = prev.slice()
          arr.splice(from, 1)
          if (to >= 0) arr.splice(Math.min(to, arr.length), 0, dragId)
          else arr.push(dragId)
          return arr
        })
      }

      function buildPlan(env, mods) {
        const lines = []
        lines.push('环境: ' + env.name + ' (' + env.id + ')')
        lines.push('模块（按执行顺序）: ' + mods.map((m) => m.name || m.id).join(' + '))
        if (buildPath) lines.push('构建路径: ' + buildPath + '（临时 worktree，不写回配置）')
        lines.push('')
        lines.push('将依次执行:')
        for (const m of mods) {
          // expTime 追加规则与服务端一致：仅首 token 是 gradle 的 server 模块
          const exp = m.kind === 'server' && env.expTime && ((m.buildCmd || '').trim().split(/\s+/)[0] || '').includes('gradle') ? ' -PexpTime=' + env.expTime : ''
          lines.push('')
          lines.push('[' + (m.name || m.id) + ']')
          lines.push('  构建: ' + m.buildCmd + exp + (m.buildDir ? '（目录: ' + m.buildDir + '）' : ''))
          const insts = (m.instances || []).length
            ? m.instances.map((inst, ii) => ({ target: targetOf(env, { sshId: inst.sshId }), healthCheckUrl: inst.healthCheckUrl || m.healthCheckUrl, healthCheckPattern: inst.healthCheckPattern || m.healthCheckPattern, label: '实例' + (ii + 1) }))
            : [{ target: targetOf(env, m), healthCheckUrl: m.healthCheckUrl, healthCheckPattern: m.healthCheckPattern, label: '' }]
          for (const inst of insts) {
            const t = inst.target
            lines.push('  ' + (inst.label ? inst.label + ' ' : '') + 'rsync: ' + m.localPath + ' → ' + (t.user || 'root') + '@' + (t.host || '?') + ':' + m.remotePath + (inst.label ? '' : (env.sshs && env.sshs.length > 1 ? '（目标: ' + (t.name || t.id) + '）' : '')))
            if (inst.healthCheckUrl) lines.push('    探活: ' + inst.healthCheckUrl + (inst.healthCheckPattern ? '（成功正则: ' + inst.healthCheckPattern + '）' : ''))
          }
          if (m.postCommand) lines.push('  ssh: ' + m.postCommand)
        }
        return lines.join('\n')
      }

      function requestDeploy() {
        if (!draft || !selected.length) return
        if (isNew) { setDeployState({ running: false, text: '请先保存环境再执行部署', kind: 'err' }); return }
        const deployTargets = [...new Set(selected.map((id) => {
          const m = moduleById[id]
          return m && targetOf(draft, m)
        }).filter(Boolean))]
        if (!deployTargets.length || deployTargets.some((t) => !t.host || !t.user)) {
          setDeployState({ running: false, text: '所选模块的 SSH 目标配置不完整，请先保存 SSH 配置', kind: 'err' })
          return
        }
        const mods = selected.map((id) => moduleById[id]).filter((m) => m && m.enabled)
        if (!mods.length) { setDeployState({ running: false, text: '所选模块均已禁用', kind: 'err' }); return }
        const ids = mods.map((m) => m.id)
        // 部署读的是已保存配置：未保存的模块改动会让服务端按旧的启用状态执行，先拦住
        const savedEnv = envs.find((e) => e.id === draft.id)
        const savedEnabled = new Set(((savedEnv && savedEnv.modules) || []).filter((m) => m.enabled).map((m) => m.id))
        const unsaved = ids.filter((id) => !savedEnabled.has(id))
        if (unsaved.length) {
          setDeployState({ running: false, text: '有模块改动尚未保存（' + unsaved.join('、') + '），请先保存环境', kind: 'err' })
          return
        }
        const envIdValue = draft.id
        setConfirmState({
          title: '确认部署',
          body: buildPlan(draft, mods),
          pre: true,
          danger: true,
          confirmLabel: '执行部署',
          onConfirm: () => startDeploy(envIdValue, ids),
        })
      }

      function startDeploy(envIdValue, ids) {
        if (esRef.current) { try { esRef.current.close() } catch { /* 已关闭 */ } esRef.current = null }
        setLogText('')
        setDeployState({ running: true, text: '部署中...', kind: '' })
        setLastBuild((prev) => ({ ...prev, [envIdValue]: { time: Date.now(), status: 'running' } }))
        let url = SSE + '?env=' + encodeURIComponent(envIdValue) + '&modules=' + ids.map((id) => encodeURIComponent(id)).join(',')
        if (buildPath) url += '&path=' + encodeURIComponent(buildPath)
        let es
        try { es = new EventSource(url) } catch (error) {
          setDeployState({ running: false, text: '无法建立日志连接：' + (error.message || error), kind: 'err' })
          return
        }
        esRef.current = es
        let finished = false
        es.onmessage = (ev) => {
          let chunk
          try { chunk = JSON.parse(ev.data) } catch { return }
          if (typeof chunk !== 'string') return
          setLogText((prev) => prev + chunk)
        }
        es.addEventListener('replay', (ev) => {
          let text
          try { text = JSON.parse(ev.data) } catch { return }
          if (typeof text !== 'string') return
          setLogText(text)
        })
        es.addEventListener('done', (ev) => {
          finished = true
          let data = {}
          try { data = JSON.parse(ev.data) || {} } catch { data = {} }
          try { es.close() } catch { /* 已关闭 */ }
          if (esRef.current === es) esRef.current = null
          const code = data.code
          setDeployState(code === 0
            ? { running: false, text: '部署完成', kind: 'ok' }
            : { running: false, text: '部署失败 (exit ' + code + ')', kind: 'err' })
          setHistoryTick((t) => t + 1)
          refreshLastBuild()
        })
        es.onerror = () => {
          if (finished) return
          if (es.readyState === 2) {
            // 服务端 204（记录已不存在）或彻底失败：停止重连，结果看执行记录
            try { es.close() } catch { /* 已关闭 */ }
            if (esRef.current === es) esRef.current = null
            setDeployState({ running: false, text: '连接已断开，部署结果请查看下方执行记录', kind: 'err' })
            setHistoryTick((t) => t + 1)
            refreshLastBuild()
          } else {
            // EventSource 自动重连中：服务端会加入原部署并回放日志
            setDeployState({ running: true, text: '连接中断，重连中…', kind: 'warn' })
          }
        }
      }

      function askClearHistory() {
        setConfirmState({
          title: '清空执行记录',
          body: '清空全部执行记录？（进行中的部署记录会保留）',
          danger: true,
          confirmLabel: '清空',
          onConfirm: () => {
            rpc('clearHistory').then(() => setHistoryTick((t) => t + 1))
              .catch((error) => setDeployState({ running: false, text: '清空失败：' + (error.message || error), kind: 'err' }))
          },
        })
      }

      const allSelected = enabledModules.length > 0 && selected.length === enabledModules.length
      const canRun = !!draft && !isNew && selected.length > 0 && !deployState.running

      // 标题行：对象名 + 一句「现状」（ID / 最近部署结果 / SSH 目标），全部来自已有数据
      const selSsh = draft && draft.sshs && draft.sshs[0] ? draft.sshs[0] : {}
      const selSshText = selSsh.host ? (selSsh.user || 'root') + '@' + selSsh.host + ':' + (selSsh.port || 22) : ''
      const selBuild = draft ? lastBuild[draft.id] : null
      let titleSub = '选择左侧环境，或新增一个环境'
      let titleDot = ''
      if (draft) {
        if (isNew) titleSub = draft.id + ' · 新环境尚未保存，保存后才能部署'
        else if (selBuild) {
          titleDot = selBuild.status
          titleSub = draft.id + ' · 上次部署 ' + (HSTATUS[selBuild.status] || selBuild.status) + ' · ' + fmtTime(selBuild.time)
            + '（' + fmtAgo(selBuild.time) + '）' + (selSshText ? ' · ' + selSshText : '')
        } else titleSub = draft.id + ' · ' + (selSshText ? selSshText + ' · ' : '') + '从未部署'
      }

      return h('div', { className: 'dad-root' },
        h('style', null, CSS),
        h('input', {
          type: 'file', accept: '.json,application/json', ref: importRef,
          style: { display: 'none' }, onChange: importFile,
        }),
        loadError ? h('div', { className: 'dad-loaderr' }, '配置读取失败：' + loadError) : null,
        notice ? h('div', { className: 'dad-notice ' + (notice.kind || ''), role: 'status' },
          h('span', { className: 'dad-notice-text' }, notice.text),
          h('button', {
            type: 'button', className: 'dad-notice-close', 'aria-label': '关闭提示',
            onClick: () => setNotice(null),
          }, '×')) : null,
        h(EnvList, {
          envs, lastBuild, draft,
          onSelect: selectEnv, onCopy: copyEnv, onDelete: askDeleteEnv, onAdd: addEnv,
          onImport: openImport,
          onExport: openExport,
        }),
        h('div', { className: 'dad-right' },
          h('div', { className: 'dad-title' },
            h('h1', { className: 'dad-h1' }, draft ? (draft.name || '未命名环境') : '部署'),
            h('p', { className: 'dad-title-sub' },
              titleDot ? h('i', { className: 'dad-dot st-' + titleDot, 'aria-hidden': true }) : null,
              titleSub)),
          h('div', { className: 'dad-card' },
            h('div', { className: 'dad-card-head' },
              h('span', { className: 'dad-card-title' }, '部署')),
            h(GitBar, {
              env: draft, git: gitInfo, buildPath,
              onPickPath: (value) => {
                setBuildPath(value === normPath(draft && draft.projectPath) ? '' : value)
              },
            }),
            h('div', { className: 'dad-modbar' },
              h('span', { className: 'dad-hint' }, '勾选要部署的模块：'),
              h('button', {
                type: 'button', className: 'dad-btn', onClick: toggleSelAll,
                disabled: enabledModules.length === 0,
              }, allSelected ? '清空' : '全选')),
            enabledModules.length === 0
              ? h('div', { className: 'dad-hint' }, '该环境没有启用的模块，请先在编辑区添加并启用模块。')
              : h('div', { className: 'dad-mods' },
                enabledModules.map((m) => h('label', {
                  key: m.id, className: 'dad-opt',
                  'data-sel': selected.includes(m.id) ? '1' : '0',
                },
                  h('input', {
                    type: 'checkbox', checked: selected.includes(m.id),
                    onChange: () => toggleSel(m.id),
                  }),
                  h('span', { className: 'dad-opt-main' },
                    h('b', { className: 'dad-opt-name' }, m.name || m.id),
                    h('span', { className: 'dad-sub' }, m.id + ' · ' + (KIND_LABEL[m.kind] || m.kind)))))),
            h('div', { className: 'dad-otitle' },
              '执行顺序（', h('b', null, String(selected.length)), ' 个模块，拖动调整顺序）'),
            h('div', {
              className: 'dad-order',
              onDragOver: (ev) => { ev.preventDefault(); if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move' },
              onDrop: (ev) => { ev.preventDefault(); orderDrop(null) },
            },
              selected.length === 0
                ? h('span', { className: 'dad-order-emptytext' }, '（空白）勾选上方模块添加，可拖动调整顺序')
                : selected.map((id, idx) => {
                  const m = moduleById[id] || { id, name: id, kind: '' }
                  return h('div', {
                    key: id,
                    className: 'dad-orderitem',
                    draggable: true,
                    'data-dragging': draggingId === id ? '1' : '0',
                    'data-over': dragOverId === id ? '1' : '0',
                    onDragStart: (ev) => {
                      dragIdRef.current = id
                      setDraggingId(id)
                      if (ev.dataTransfer) {
                        ev.dataTransfer.effectAllowed = 'move'
                        try { ev.dataTransfer.setData('text/plain', id) } catch { /* 忽略 */ }
                      }
                    },
                    onDragEnd: () => { dragIdRef.current = null; setDraggingId(''); setDragOverId('') },
                    onDragOver: (ev) => { ev.preventDefault(); ev.stopPropagation(); setDragOverId(id) },
                    onDrop: (ev) => { ev.preventDefault(); ev.stopPropagation(); orderDrop(id) },
                  },
                    h('span', { className: 'dad-onum' }, String(idx + 1)),
                    h('span', { className: 'dad-oname' }, m.name || m.id),
                    h('span', { className: 'dad-kindtag' + (m.kind === 'front' || m.kind === 'server' ? ' dad-kind-' + m.kind : '') }, KIND_LABEL[m.kind] || '模块'),
                    h('button', {
                      type: 'button', className: 'dad-ordel', title: '移除', 'aria-label': '从执行顺序移除',
                      onClick: (ev) => { ev.stopPropagation(); toggleSel(id) },
                    }, '×'))
                })),
            h('div', { className: 'dad-bar' },
              h('span', { className: 'dad-summary' },
                draft && selected.length
                  ? ['环境 ', h('b', { key: 'n' }, draft.name), ' · 已选 ', h('b', { key: 'c' }, String(selected.length)), ' 个模块']
                  : '未选择'),
              h('button', {
                type: 'button', className: 'dad-btn dad-btn-primary dad-run',
                disabled: !canRun, onClick: requestDeploy,
              }, deployState.running ? '部署中…' : '执行部署'),
              deployState.text && deployState.text !== '部署中...'
                ? h('span', { className: 'dad-msg ' + (deployState.kind || '') }, deployState.text)
                : null),
            isNew ? h('div', { className: 'dad-hint' }, '当前环境尚未保存，保存环境后才能执行部署。') : null),
          h('div', { className: 'dad-card' },
            h('div', { className: 'dad-card-head' },
              h('span', { className: 'dad-card-title' }, '部署日志'),
              !logText && !deployState.running && history[0]
                ? h('span', { className: 'dad-head-note' },
                  '上次部署 ' + fmtTime(history[0].startTime)
                  + (history[0].durationMs != null ? ' · 耗时 ' + fmtDur(history[0].durationMs) : ''))
                : null),
            h('pre', { className: 'dad-log', ref: logRef },
              logText || (deployState.running ? '等待日志…' : (history[0] && history[0].logTail) || '（尚未执行）'))),
          h('div', { className: 'dad-card' },
            h('div', { className: 'dad-card-head' },
              h('span', { className: 'dad-card-title' }, '执行记录'),
              h('button', {
                type: 'button', className: 'dad-btn', onClick: askClearHistory,
              }, '清空')),
            h('div', { className: 'dad-hist' },
              !envId
                ? h('div', { className: 'dad-hint' }, '（未选择已保存的环境）')
                : historyState === 'error'
                  ? h('div', { className: 'dad-hint' }, '执行记录读取失败')
                  : history.length === 0
                    ? h('div', { className: 'dad-hint' }, historyState === 'loading' ? '读取中…' : '（暂无记录）')
                    : history.map((r) => h('details', { key: r.id, className: 'dad-hrow' },
                      h('summary', { className: 'dad-hsum' },
                        h('span', { className: 'dad-badge ' + r.status }, HSTATUS[r.status] || r.status),
                        h('span', { className: 'dad-mono', title: fmtTime(r.startTime) }, fmtAgo(r.startTime)),
                        r.durationMs != null ? h('span', { className: 'dad-muted dad-mono' }, '耗时 ' + fmtDur(r.durationMs)) : null,
                        h('span', { className: 'dad-hmods' }, (r.modules || []).map((m) => m.name || m.id).join(' + ')),
                        r.status === 'failed'
                          ? h('span', { className: 'dad-err dad-hfail' },
                            '失败: ' + (r.failedModule || '部署后')
                            + (r.failedStep ? ' / ' + r.failedStep : '')
                            + ' (exit ' + r.exitCode + ')')
                          : null),
                      r.logTail ? h('pre', { className: 'dad-hlog' }, r.logTail) : null)))),
          h(EnvForm, {
            env: draft, isNew, groups, message: formMsg, open: formOpen,
            tab: formTab, onTab: setFormTab,
            moduleIndex, onModuleIndex: setModuleIndex,
            onToggle: () => setFormOpen((v) => !v),
            onPatch: patchEnv, onPatchSsh: patchSsh, onPatchModule: patchModule,
            onAddModule: addModule, onDeleteModule: askDeleteModule,
            onAddSsh: addSsh, onDeleteSsh: deleteSsh, onTestSsh: runSshTest, sshTest,
            onSave: saveEnv, onDelete: deleteCurrentEnv, onBrowse: openBrowse, onBrowseKey: openKeyBrowse, onBrowseJumpKey: openJumpKeyBrowse,
            jdks, jdkOpen, jdkRef, onJdkFocus: openJdk, onJdkPick: pickJdk,
            nodes, nodeOpen, nodeRef, nodeErr, onNodeFocus: openNode, onNodePick: pickNode,
            pms, pmOpen, pmRef, pmErr, onPmFocus: openPm, onPmPick: pickPm,
          })),
        confirmState ? h(ConfirmDialog, { state: confirmState, onClose: () => setConfirmState(null) }) : null,
        exportOpen ? h(ExportDialog, {
          envs, selectedIds: exportIds,
          onToggle: toggleExportId, onToggleAll: toggleExportAll,
          onClose: () => setExportOpen(false), onConfirm: confirmExport,
        }) : null,
        browse ? h(BrowseModal, {
          state: browse, onClose: () => setBrowse(null),
          onNavigate: navigateBrowse, onUp: browseUp, onPick: browsePick, onSelectFile: browseSelectFile,
          onToggleHidden: browseToggleHidden,
        }) : null)
    }

    // ---------- 样式（颜色/背景/边框只用主题变量） ----------

    const CSS = [
      '.dad-root{height:100%;box-sizing:border-box;display:flex;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}',
      '.dad-root *{box-sizing:border-box}',
      '.dad-root :focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.dad-left{width:264px;flex:0 0 264px;min-width:0;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-module-platform);border-right:.5px solid var(--dsw-alias-border-l3)}',
      '.dad-left-head{flex:none;display:flex;align-items:center;gap:8px;padding:14px 12px 10px}',
      '.dad-left-title{flex:1;min-width:0;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dad-envs{flex:1;min-height:0;overflow:auto;padding:0 10px 12px;display:flex;flex-direction:column;gap:6px}',
      '.dad-grp{margin:10px 2px 0;padding-left:10px;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.dad-grp:first-child{margin-top:0}',
      '.dad-env{position:relative;display:block;width:100%;min-width:0;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;text-align:left}',
      '.dad-env-main{display:block;width:100%;min-width:0;margin:0;padding:0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}',
      '.dad-env:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l4)}',
      '.dad-env[data-sel="1"]{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-state-business-tertiary)}',
      '.dad-env-name{display:block;font-size:13.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-right:58px}',
      '.dad-envops{position:absolute;top:6px;right:8px;display:none;gap:8px;align-items:center}',
      '.dad-env:hover .dad-envops,.dad-env:focus-within .dad-envops{display:flex}',
      '.dad-linkbtn{border:0;background:none;padding:0;font:inherit;font-size:12px;cursor:pointer;color:var(--dsw-alias-state-business-primary)}',
      '.dad-linkbtn-danger{color:var(--dsw-alias-state-error-primary)}',
      '.dad-right{flex:1 1 auto;min-width:0;min-height:0;overflow:auto;padding:16px 20px 32px;display:flex;flex-direction:column;gap:16px}',
      '.dad-title{margin:2px 0 0;min-width:0}',
      '.dad-h1{margin:0;font-size:20px;font-weight:600;line-height:1.3;letter-spacing:-0.01em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dad-title-sub{margin:5px 0 0;font-size:13px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dad-loaderr{flex:none;margin:12px 16px 0;padding:8px 12px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);font-size:12px}',
      '.dad-notice{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:70;display:flex;align-items:center;gap:10px;max-width:min(640px,80vw);padding:7px 12px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);font-size:12px;color:var(--dsw-alias-label-primary)}',
      '.dad-notice.ok{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}',
      '.dad-notice.err{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.dad-notice.warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-label)}',
      '.dad-notice-text{min-width:0;overflow-wrap:anywhere}',
      '.dad-notice-close{border:0;background:none;color:inherit;font-size:14px;line-height:1;padding:0 2px;cursor:pointer;opacity:.7}',
      '.dad-notice-close:hover{opacity:1}',
      '.dad-card{min-width:0;padding:14px 16px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1)}',
      '.dad-card-head{display:flex;align-items:center;gap:8px;min-width:0;margin-bottom:12px}',
      '.dad-card-title{flex:1;min-width:0;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dad-tabs{display:flex;align-items:stretch;gap:2px;min-width:0;margin:0 0 10px;padding:3px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-module-platform)}',
      '.dad-tab{flex:1 1 0;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:0;margin:0;padding:6px 10px;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;font-weight:500;cursor:pointer}',
      '.dad-tab:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
      '.dad-tab[aria-selected="true"]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:var(--dsw-elevation-subtle,0 0 0 .5px var(--dsw-alias-border-l3))}',
      '.dad-tab-count{flex:0 0 auto;min-width:16px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:600;font-variant-numeric:tabular-nums;line-height:16px}',
      '.dad-tab[aria-selected="true"] .dad-tab-count{background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary)}',
      '.dad-sec{padding:12px 14px;margin-bottom:10px;border-radius:var(--dsw-radius-lg);min-width:0;background:var(--dsw-alias-bg-module-platform)}',
      '.dad-sec[hidden]{display:none}',
      '.dad-sec-title{margin-bottom:10px;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.dad-row{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px;align-items:flex-end;min-width:0}',
      '.dad-row:last-child{margin-bottom:0}',
      '.dad-field{display:flex;flex-direction:column;gap:3px;flex:1 1 170px;min-width:0}',
      '.dad-field-wide{flex:2 1 300px}',
      '.dad-label{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dad-input,.dad-select,.dad-textarea{width:100%;min-width:0;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:5px 9px;outline:none}',
      '.dad-input:focus,.dad-select:focus,.dad-textarea:focus{border-color:var(--dsw-alias-state-business-primary)}',
      '.dad-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:not-allowed}',
      '.dad-textarea{resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.5}',
      '.dad-inline{display:flex;gap:6px;align-items:center;min-width:0}',
      '.dad-inline .dad-input{flex:1 1 auto}',
      '.dad-chk{display:inline-flex;align-items:center;gap:6px;flex:0 0 auto;align-self:flex-end;padding-bottom:5px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.dad-chk input[type=checkbox]{accent-color:var(--dsw-alias-state-business-primary);width:14px;height:14px;margin:0}',
      '.dad-autoflex{align-self:center;padding-bottom:0}',
      '.dad-hint{margin-top:4px;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.dad-muted{color:var(--dsw-alias-label-tertiary)}',
      '.dad-err{color:var(--dsw-alias-state-error-primary)}',
      '.dad-msg{font-size:12.5px;font-weight:600;min-width:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}',
      '.dad-msg.ok::before,.dad-msg.err::before,.dad-msg.warn::before{content:"";display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;vertical-align:1px}',
      '.dad-msg.ok::before{background:var(--dsw-alias-state-success-primary)}',
      '.dad-msg.err::before{background:var(--dsw-alias-state-error-primary)}',
      '.dad-msg.warn::before{background:var(--dsw-alias-state-warn-primary)}',
      '.dad-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px}',
      '.dad-sub{display:block;margin-top:2px;font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dad-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-caption);margin-right:5px;vertical-align:1px}',
      '.dad-dot.st-success{background:var(--dsw-alias-state-success-primary)}',
      '.dad-dot.st-failed{background:var(--dsw-alias-state-error-primary)}',
      '.dad-dot.st-running,.dad-dot.st-aborted{background:var(--dsw-alias-state-warn-primary)}',
      '.dad-env-name .dad-dot,.dad-title-sub .dad-dot{margin-right:6px;vertical-align:1px}',
      '.dad-head-note{flex:0 0 auto;font-size:12px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.dad-build.success .dad-dot{background:var(--dsw-alias-state-success-primary)}',
      '.dad-build.failed .dad-dot{background:var(--dsw-alias-state-error-primary)}',
      '.dad-build.running .dad-dot,.dad-build.aborted .dad-dot{background:var(--dsw-alias-state-warn-primary)}',
      '.dad-btn{flex:0 0 auto;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;padding:5px 11px;cursor:pointer;white-space:nowrap}',
      '.dad-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dad-btn:disabled{opacity:.5;cursor:default}',
      '.dad-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}',
      '.dad-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
      '.dad-btn-danger{color:var(--dsw-alias-state-error-primary)}',
      '.dad-btn-danger:hover:not(:disabled){border-color:var(--dsw-alias-state-error-primary)}',
      '.dad-btn-danger-solid{background:var(--dsw-alias-state-error-primary);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}',
      '.dad-btn-danger-solid:hover:not(:disabled){background:var(--dsw-alias-state-error-primary)}',
      '.dad-formfoot{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:4px}',
      '.dad-modtabs{display:flex;align-items:flex-end;gap:8px;min-width:0;margin-bottom:10px}',
      '.dad-modtablist{flex:1 1 auto;display:flex;align-items:stretch;gap:4px;min-width:0;overflow-x:auto;padding-bottom:1px}',
      '.dad-modtab{flex:0 0 auto;display:inline-flex;align-items:center;gap:6px;max-width:220px;min-width:0;margin:0;padding:6px 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;cursor:pointer}',
      '.dad-modtab:hover{border-color:var(--dsw-alias-border-l4);color:var(--dsw-alias-label-primary)}',
      '.dad-modtab[aria-selected="true"]{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-label-primary);font-weight:600}',
      '.dad-modtab[data-off="1"]{opacity:.55}',
      '.dad-modtab-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dad-mcard{position:relative;min-width:0;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1)}',
      '.dad-sshtarget{position:relative;min-width:0;padding:8px 10px 10px;margin-bottom:8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1)}',
      '.dad-mcard[data-off="1"]{opacity:.6}',
      '.dad-btndel{position:absolute;top:4px;right:6px;border:0;background:none;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:1;padding:2px 4px;cursor:pointer}',
      '.dad-btndel:hover{color:var(--dsw-alias-state-error-primary)}',
      '.dad-jdkwrap{position:relative;display:block;min-width:0}',
      '.dad-jdkdd{position:absolute;top:100%;left:0;z-index:40;margin-top:3px;min-width:280px;max-width:min(460px,80vw);max-height:240px;overflow:auto;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);box-shadow:var(--dsw-elevation-prominent)}',
      '.dad-jitem{display:flex;flex-direction:column;align-items:flex-start;gap:1px;width:100%;border:0;border-bottom:.5px solid var(--dsw-alias-border-l1);background:none;color:inherit;font:inherit;text-align:left;padding:6px 10px;cursor:pointer}',
      '.dad-jitem:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dad-jlbl{font-size:12px;font-weight:600}',
      '.dad-jfull{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;color:var(--dsw-alias-label-tertiary);word-break:break-all}',
      '.dad-jempty{padding:8px 10px;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}',
      '.dad-gitbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;margin-bottom:12px;padding:8px 12px;font-size:12.5px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform)}',
      '.dad-ghead{display:inline-flex;align-items:center;gap:6px;flex:0 0 auto}',
      '.dad-branch{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;font-weight:600;color:var(--dsw-alias-state-business-primary);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);padding:2px 7px;background:var(--dsw-alias-bg-layer-1)}',
      '.dad-gpath{flex:1 1 160px;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:var(--dsw-alias-label-secondary);word-break:break-all}',
      '.dad-gtmp{flex:0 0 auto;font-size:11.5px;color:var(--dsw-alias-state-warn-label);border:.5px solid var(--dsw-alias-state-warn-primary);border-radius:var(--dsw-radius-sm);padding:1px 6px}',
      '.dad-gsel{flex:0 0 auto;width:auto;max-width:100%;font-size:12.5px}',
      '.dad-modbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px}',
      '.dad-mods{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px;min-width:0}',
      '.dad-export-list{display:flex;flex-direction:column;gap:10px;min-width:0}',
      '.dad-export-sec{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.dad-export-grp{margin:0}',
      '.dad-export-count{margin:0;align-self:center}',
      '.dad-opt{display:flex;align-items:center;gap:8px;min-width:0;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);cursor:pointer}',
      '.dad-opt:hover{border-color:var(--dsw-alias-border-l4);background:var(--dsw-alias-interactive-bg-hover)}',
      '.dad-opt[data-sel="1"]{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary)}',
      '.dad-opt input[type=checkbox]{flex:0 0 auto;width:14px;height:14px;margin:0;accent-color:var(--dsw-alias-state-business-primary)}',
      '.dad-opt-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column}',
      '.dad-opt-name{font-size:12.5px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dad-otitle{margin:10px 0 6px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dad-otitle b{color:var(--dsw-alias-state-business-primary)}',
      '.dad-order{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-height:42px;padding:6px;border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform)}',
      '.dad-order-emptytext{font-size:12px;color:var(--dsw-alias-label-secondary);padding:2px 4px}',
      '.dad-orderitem{display:inline-flex;align-items:center;gap:6px;max-width:220px;min-width:0;padding:4px 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);font-size:12px;cursor:grab;user-select:none}',
      '.dad-orderitem:hover{border-color:var(--dsw-alias-border-l4)}',
      '.dad-orderitem[data-over="1"]{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover)}',
      '.dad-orderitem[data-dragging="1"]{opacity:.45}',
      '.dad-onum{flex:0 0 auto;width:17px;height:17px;border-radius:50%;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground);font-size:10px;display:inline-flex;align-items:center;justify-content:center}',
      '.dad-oname{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}',
      '.dad-kindtag{flex:0 0 auto;font-size:10px;color:var(--dsw-alias-label-tertiary);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);padding:0 5px}',
      '.dad-kind-front{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary)}',
      '.dad-kind-server{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent)}',
      '.dad-ordel{flex:0 0 auto;border:0;background:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1;padding:0 2px;cursor:pointer}',
      '.dad-ordel:hover{color:var(--dsw-alias-state-error-primary)}',
      '.dad-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:14px -16px -14px;padding:12px 16px;background:var(--dsw-alias-bg-module-platform);border-radius:0 0 var(--dsw-radius-lg) var(--dsw-radius-lg)}',
      '.dad-summary{font-size:12.5px}',
      '.dad-summary b{color:var(--dsw-alias-label-primary)}',
      '.dad-run{padding:8px 26px;font-size:13.5px;font-weight:600}',
      '.dad-run:disabled{opacity:.4;cursor:default}',
      '.dad-log{margin:0;height:200px;overflow:auto;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.5;white-space:pre-wrap;word-break:break-all}',
      '.dad-hist{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.dad-hrow{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);min-width:0}',
      '.dad-hrow:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dad-hsum{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 12px;font-size:12.5px;cursor:pointer;list-style:none;font-variant-numeric:tabular-nums}',
      '.dad-hsum::-webkit-details-marker{display:none}',
      '.dad-badge{flex:0 0 auto;display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary)}',
      '.dad-badge::before{content:"";flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-caption)}',
      '.dad-badge.success::before{background:var(--dsw-alias-state-success-primary)}',
      '.dad-badge.failed::before{background:var(--dsw-alias-state-error-primary)}',
      '.dad-badge.running::before{background:var(--dsw-alias-state-business-primary)}',
      '.dad-badge.aborted::before{background:var(--dsw-alias-state-warn-primary)}',
      '.dad-hmods{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dad-hfail{min-width:0;overflow-wrap:anywhere}',
      '.dad-hlog{margin:0 10px 10px;max-height:220px;overflow:auto;padding:8px 10px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-all}',
      '.dad-mask{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;padding:20px;background:var(--dsw-alias-bg-mask-2)}',
      '.dad-modal{display:flex;flex-direction:column;width:min(560px,100%);max-height:min(80vh,720px);min-width:0;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);overflow:hidden}',
      '.dad-modal-head{flex:none;display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:.5px solid var(--dsw-alias-border-l3);min-width:0}',
      '.dad-modal-body{flex:1 1 auto;min-height:0;overflow:auto;padding:10px 14px}',
      '.dad-modal-foot{flex:none;display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:10px 14px;border-top:.5px solid var(--dsw-alias-border-l3)}',
      '.dad-spacer{flex:1 1 auto}',
      '.dad-plan{margin:0;padding:10px 12px;max-height:46vh;overflow:auto;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.55;white-space:pre-wrap;word-break:break-all}',
      '.dad-plan-text{font-size:12.5px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
      '.dad-browse-path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all;padding:6px 10px;margin-bottom:8px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform)}',
      '.dad-wts{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:8px;min-width:0}',
      '.dad-wt{display:inline-flex;align-items:center;gap:5px;max-width:100%;min-width:0;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:none;color:inherit;font:inherit;font-size:11px;padding:2px 8px;cursor:pointer}',
      '.dad-wt:hover{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}',
      '.dad-wt[data-cur="1"]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary);cursor:default}',
      '.dad-wic{flex:0 0 auto;color:var(--dsw-alias-label-tertiary)}',
      '.dad-wbr{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dad-dirs{display:flex;flex-direction:column;gap:1px;max-height:46vh;overflow:auto;padding:4px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md)}',
      '.dad-dir{border:0;background:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;text-align:left;padding:5px 8px;border-radius:var(--dsw-radius-sm);cursor:pointer;word-break:break-all;min-width:0}',
      '.dad-dir:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dad-envs,.dad-right,.dad-log,.dad-dirs,.dad-modal-body,.dad-jdkdd,.dad-hlog,.dad-plan{--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}',
      '@media (max-width:900px){.dad-root{flex-direction:column}.dad-left{width:auto;flex:0 0 auto;max-height:38vh;border-right:0;border-bottom:.5px solid var(--dsw-alias-border-l3)}.dad-right{flex:1 1 auto}.dad-h1{font-size:18px}.dad-title-sub{font-size:12px}}',
    ].join('\n')

    return {
      inject: ['slots'],
      apply(ctx) {
        // 常驻全局「部署」入口（全部环境面板），行为保持不变
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: 'deploy', label: '部署', order: 45,
        }, Icon))
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: 'deploy',
        }, Panel))

        // 工作空间关联部署：响应式匹配集合（先于动态 inject 创建，保证 inject 回调可见）
        const store = createDeployMatch(ctx)
        deployMatch = store
        ctx.effect(() => () => {
          if (deployMatch === store) deployMatch = null
          store.dispose()
        })

        // 右栏 tab body（stage 2）：常驻注册，key = 类型 id；类型未注册时不会渲染
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab', key: RB_TAB_ID,
        }, DeployTabBody))

        // 右栏 guide 卡片（stage 1）：按当前工作空间匹配集合动态注册/注销 tab 类型
        ctx.effect(() => {
          const tabsReg = ctx.get('sidebarRightTabs')
          const sr = ctx.get('sidebarRight')
          if (!tabsReg || !deployMatch) return () => {}
          let disposeType = null
          const closeDeployTabs = () => {
            if (!sr || !sr.openTabs) return
            for (const t of sr.openTabs.getSnapshot()) {
              if (t.kind !== RB_KIND) continue
              if (typeof sr.closeIn === 'function') sr.closeIn(t.sessionId, t.tabId)
              else if (sr.mounted && sr.mounted.getSnapshot() === t.sessionId) sr.close(t.tabId)
            }
          }
          const sync = () => {
            const want = deployMatch.getSnapshot().length > 0
            if (want && !disposeType) {
              disposeType = tabsReg.register({
                id: RB_TAB_ID, kind: RB_KIND, multiple: false, keepMounted: true,
                title: () => '部署',
                guide: [{
                  id: 'deploy', order: 60,
                  title: () => '部署',
                  description: deployGuideDesc,
                  icon: DeployGuideIcon,
                }],
              })
            } else if (!want && disposeType) {
              // 工作空间不再关联：先关闭已开的部署 tab，再注销类型（guide 卡片随之消失）
              closeDeployTabs()
              disposeType()
              disposeType = null
            }
          }
          const un = deployMatch.subscribe(sync)
          sync()
          return () => { un(); if (disposeType) { disposeType(); disposeType = null } }
        })
      },
    }
  },
})
