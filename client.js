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
    function joinPath(base, name) {
      if (!name) return base || ''
      if (name.startsWith('/')) return name
      const b = base || ''
      if (!b) return name
      return b === '/' ? '/' + name : b.replace(/\/+$/, '') + '/' + name
    }
    function parentPath(p) {
      const base = normPath(p || '')
      if (!base || base === '/') return '/'
      const i = base.lastIndexOf('/')
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
        gradleTask: '', key: '', extraArgs: '', localPath: '', remotePath: '',
        postCommand: '', healthCheckUrl: '', frontEnv: '',
      }
    }
    function normalizeModule(m) {
      return {
        id: m.id || '', name: m.name || '', kind: m.kind === 'server' ? 'server' : 'front',
        enabled: m.enabled !== false,
        gradleTask: m.gradleTask || '', key: m.key || '', extraArgs: m.extraArgs || '',
        localPath: m.localPath || '', remotePath: m.remotePath || '', postCommand: m.postCommand || '',
        healthCheckUrl: m.healthCheckUrl || '', frontEnv: m.frontEnv || '',
      }
    }
    function normalizeEnv(env) {
      const e = clone(env || {})
      const ssh = e.ssh || {}
      return {
        id: e.id || '',
        name: e.name || '',
        note: e.note || '',
        group: e.group || '',
        projectPath: e.projectPath || '',
        jdkHome: e.jdkHome || '',
        expTime: e.expTime || '',
        ssh: {
          host: ssh.host || '', port: Number(ssh.port) || 22, user: ssh.user || 'root',
          password: ssh.password || '', options: ssh.options || '',
        },
        modules: (e.modules || []).map(normalizeModule),
      }
    }

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

    function EnvCard({ env, selected, lastBuild, onSelect, onCopy, onDelete }) {
      const lb = lastBuild[env.id]
      const ssh = env.ssh || {}
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
          h('span', { className: 'dad-sub' }, ssh.host ? (ssh.user || 'root') + '@' + ssh.host + ':' + (ssh.port || 22) : 'SSH 未配置'),
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
            type: 'button', className: 'dad-btn', title: '导出全部环境配置为 JSON（含 SSH 密码）',
            onClick: onExport, disabled: envs.length === 0,
          }, '导出'),
          h('button', { type: 'button', className: 'dad-btn dad-btn-primary', onClick: onAdd }, '+ 添加环境')),
        h('div', { className: 'dad-envs' },
          envs.length === 0 ? h('div', { className: 'dad-hint' }, '（暂无环境，点击「+ 添加环境」）') : null,
          nodes))
    }

    function ModuleCard({ mod, onChange, onDelete }) {
      const envFile = mod.id === 'bsFront' ? 'client/client-front/.env'
        : mod.id === 'adminFront' ? 'admin/admin-front/.env' : ''
      const feLabel = 'frontEnv（KEY=VALUE 多行，构建时注入'
        + (envFile ? ' ' + envFile + (mod.key ? '.' + mod.key : '') : '') + '）'
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
          h(Field, { label: 'gradle 任务' },
            h('input', {
              className: 'dad-input', type: 'text', value: mod.gradleTask, 'aria-label': 'gradle 任务',
              onChange: (ev) => onChange('gradleTask', ev.target.value),
            })),
          h(Field, { label: '-Pkey（可空）' },
            h('input', {
              className: 'dad-input', type: 'text', value: mod.key, 'aria-label': '-Pkey',
              onChange: (ev) => onChange('key', ev.target.value),
            })),
          h(Field, { label: '额外参数（如 -PexpTime=…）' },
            h('input', {
              className: 'dad-input', type: 'text', value: mod.extraArgs, 'aria-label': '额外参数',
              onChange: (ev) => onChange('extraArgs', ev.target.value),
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
            }))),
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
        h('div', { className: 'dad-hint' },
          '健康检查：HTTP 2xx、success=true、code=200；单次最多 5 秒，间隔 3 秒，最多等待 120 秒，失败中止后续模块。'),
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
      env, isNew, groups, message, open, onToggle,
      onPatch, onPatchSsh, onPatchModule, onAddModule, onDeleteModule,
      onSave, onDelete, onBrowse,
      jdks, jdkOpen, jdkRef, onJdkFocus, onJdkPick,
    }) {
      const title = env ? '环境配置' : '选择左侧环境进行编辑'
      const groupOptions = groups.map((g) => h('option', { key: g, value: g }))
      const ssh = env ? env.ssh : { host: '', port: 22, user: '', password: '', options: '' }
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
            h('div', { className: 'dad-sec' },
              h('div', { className: 'dad-sec-title' }, '基本'),
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
                  h('div', { className: 'dad-jdkwrap', ref: jdkRef },
                    h('input', {
                      className: 'dad-input', type: 'text', value: env.jdkHome, 'aria-label': 'JDK 路径',
                      onFocus: onJdkFocus, onChange: (ev) => onPatch({ jdkHome: ev.target.value }),
                    }),
                    jdkOpen ? h('div', { className: 'dad-jdkdd' },
                      jdks.length
                        ? jdks.map((j) => h('button', {
                          key: j.path, type: 'button', className: 'dad-jitem',
                          onClick: () => onJdkPick(j.path),
                        },
                          h('span', { className: 'dad-jlbl' }, j.label),
                          h('span', { className: 'dad-jfull' }, j.path)))
                        : h('div', { className: 'dad-jempty' }, '未发现可用 JDK')) : null))),
              h('div', { className: 'dad-row' },
                h(Field, { label: '过期时间 expTime（YYYY-MM-DD，可留空）' },
                  h('input', {
                    className: 'dad-input', type: 'date', value: env.expTime, 'aria-label': '过期时间',
                    onChange: (ev) => onPatch({ expTime: ev.target.value }),
                  })))),
            h('div', { className: 'dad-sec' },
              h('div', { className: 'dad-sec-title' }, 'SSH'),
              h('div', { className: 'dad-row' },
                h(Field, { label: 'Host' },
                  h('input', {
                    className: 'dad-input', type: 'text', value: ssh.host, 'aria-label': 'SSH Host',
                    onChange: (ev) => onPatchSsh({ host: ev.target.value }),
                  })),
                h(Field, { label: 'Port' },
                  h('input', {
                    className: 'dad-input', type: 'number', value: ssh.port, 'aria-label': 'SSH Port',
                    onChange: (ev) => onPatchSsh({ port: ev.target.value }),
                  })),
                h(Field, { label: 'User' },
                  h('input', {
                    className: 'dad-input', type: 'text', value: ssh.user, 'aria-label': 'SSH User',
                    onChange: (ev) => onPatchSsh({ user: ev.target.value }),
                  }))),
              h('div', { className: 'dad-row' },
                h(Field, { label: '密码（留空=ssh-agent/密钥）' },
                  h('input', {
                    className: 'dad-input', type: 'password', value: ssh.password, 'aria-label': 'SSH 密码',
                    autoComplete: 'new-password',
                    onChange: (ev) => onPatchSsh({ password: ev.target.value }),
                  })),
                h(Field, { label: '自定义 ssh 选项（如 -o StrictHostKeyChecking=no）', wide: true },
                  h('input', {
                    className: 'dad-input', type: 'text', value: ssh.options, 'aria-label': '自定义 ssh 选项',
                    onChange: (ev) => onPatchSsh({ options: ev.target.value }),
                  }))),
              h('div', { className: 'dad-hint' },
                ssh.password
                  ? '已配置密码，部署时将使用 sshpass（密码不会写入日志）'
                  : '密码留空时使用本机 ssh-agent / 密钥认证')),
            h('div', { className: 'dad-sec' },
              h('div', { className: 'dad-sec-title' }, '构建 / 发布模块'),
              env.modules.length === 0 ? h('div', { className: 'dad-hint' }, '（暂无模块）') : null,
              env.modules.map((m, i) => h(ModuleCard, {
                key: i, mod: m,
                onChange: (field, value) => onPatchModule(i, field, value),
                onDelete: () => onDeleteModule(i),
              })),
              h('div', { className: 'dad-row' },
                h('button', { type: 'button', className: 'dad-btn', onClick: onAddModule }, '+ 添加模块'))),
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

    function BrowseModal({ state, onClose, onNavigate, onUp, onPick, onToggleHidden }) {
      return h('div', { className: 'dad-mask', role: 'presentation', onClick: onClose },
        h('div', {
          className: 'dad-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '选择目录',
          onClick: (ev) => ev.stopPropagation(),
        },
          h('div', { className: 'dad-modal-head' },
            h('strong', null, '选择目录'),
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
              }, dir)))),
          h('div', { className: 'dad-modal-foot' },
            h('button', {
              type: 'button', className: 'dad-btn', onClick: onUp,
              disabled: state.loading || !state.path || state.path === '/',
            }, '上级'),
            h('button', {
              type: 'button', className: 'dad-btn dad-btn-primary', onClick: onPick,
              disabled: state.loading || !state.path,
            }, '选择当前目录'))))
    }

    // ---------- 主面板 ----------

    function Panel() {
      const [envs, setEnvs] = useState([])
      const [defProject, setDefProject] = useState('')
      const [lastBuild, setLastBuild] = useState({})
      const [loadError, setLoadError] = useState('')
      const [draft, setDraft] = useState(null)
      const [formOpen, setFormOpen] = useState(true)
      const [formMsg, setFormMsg] = useState(null)
      // 全局提示：导入等不依赖当前选中环境的操作也必须有可见反馈
      const [notice, setNotice] = useState(null)

      const [jdks, setJdks] = useState([])
      const [jdkOpen, setJdkOpen] = useState(false)
      const jdkRef = useRef(null)

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

      const logRef = useRef(null)
      const esRef = useRef(null)
      const importRef = useRef(null)
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
          setDefProject((d && d.defaultProjectPath) || '')
          setLastBuild((d && d.lastBuild) || {})
          setDraft((prev) => {
            if (prev) {
              const match = list.find((e) => e.id === prev.id)
              if (match) return normalizeEnv(match)
            }
            return list.length ? normalizeEnv(list[0]) : null
          })
        }).catch((error) => { if (!cancelled) setLoadError(error.message || String(error)) })
        return () => { cancelled = true }
      }, [])

      // 全局提示 6 秒后自动消失
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

      // JDK 下拉：点击空白处关闭
      useEffect(() => {
        if (!jdkOpen) return undefined
        function onDocDown(ev) {
          const el = jdkRef.current
          if (el && !el.contains(ev.target)) setJdkOpen(false)
        }
        document.addEventListener('mousedown', onDocDown)
        return () => document.removeEventListener('mousedown', onDocDown)
      }, [jdkOpen])

      // ---------- 环境操作 ----------

      function selectEnv(env) {
        setDraft(normalizeEnv(env))
        setSelected([])
        setFormMsg(null)
      }
      function addEnv() {
        const env = {
          id: newEnvId(envs), name: '新环境', note: '', group: '',
          projectPath: defProject, jdkHome: '', expTime: '',
          ssh: { host: '', port: 22, user: 'root', password: '', options: '' },
          modules: [],
        }
        setDraft(env)
        setSelected([])
        setFormOpen(true)
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

      // 导出当前环境列表（与 envs.json 同构，可直接用于「导入」；含 SSH 密码）
      function exportConfig() {
        if (!envs.length) return
        const d = new Date()
        const date = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
        const blob = new Blob([JSON.stringify(envs, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = 'envs-' + date + '.json'
        document.body.appendChild(a)
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
        setNotice({ text: '已导出 ' + envs.length + ' 个环境（含 SSH 密码，请妥善保管）', kind: 'ok' })
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
      function patchSsh(patch) {
        setDraft((prev) => (prev ? { ...prev, ssh: { ...prev.ssh, ...patch } } : prev))
      }
      function patchModule(index, field, value) {
        setDraft((prev) => {
          if (!prev) return prev
          const modules = prev.modules.map((m, i) => (i === index ? { ...m, [field]: value } : m))
          return { ...prev, modules }
        })
      }
      function addModule() {
        setDraft((prev) => (prev ? { ...prev, modules: prev.modules.concat([makeModule(prev.modules)]) } : prev))
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
            return { ...prev, modules: prev.modules.filter((_m, i) => i !== index) }
          }),
        })
      }

      function saveEnv() {
        if (!draft) return
        const envIdValue = (draft.id || '').trim()
        if (!envIdValue) { setFormMsg({ text: 'ID 不能为空', kind: 'err' }); return }
        if (isNew && envs.some((e) => e.id === envIdValue)) {
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
          expTime: draft.expTime || '',
          ssh: {
            host: (draft.ssh.host || '').trim(),
            port: Number(draft.ssh.port) || 22,
            user: (draft.ssh.user || '').trim() || 'root',
            password: draft.ssh.password || '',
            options: (draft.ssh.options || '').trim(),
          },
          modules: draft.modules.map((m) => ({
            id: (m.id || '').trim(),
            name: (m.name || '').trim() || '新模块',
            kind: m.kind === 'server' ? 'server' : 'front',
            enabled: !!m.enabled,
            gradleTask: (m.gradleTask || '').trim(),
            key: (m.key || '').trim(),
            extraArgs: (m.extraArgs || '').trim(),
            localPath: (m.localPath || '').trim(),
            remotePath: (m.remotePath || '').trim(),
            postCommand: (m.postCommand || '').trim(),
            healthCheckUrl: (m.healthCheckUrl || '').trim(),
            frontEnv: m.frontEnv || '',
          })),
        }
        rpc('saveEnv', env).then((d) => {
          const list = Array.isArray(d && d.envs) ? d.envs : []
          setEnvs(list)
          const saved = list.find((x) => x.id === env.id) || env
          setDraft(normalizeEnv(saved))
          setFormOpen(false)
          setFormMsg({ text: (d && d.warning) || '已保存', kind: (d && d.warning) ? 'warn' : 'ok' })
        }).catch((error) => {
          setFormMsg({ text: (error.message || String(error)), kind: 'err' })
        })
      }

      // ---------- 路径浏览 ----------

      function loadBrowse(path, hidden) {
        setBrowse((prev) => ({
          path: prev ? prev.path : '',
          parent: prev ? prev.parent : '',
          dirs: prev ? prev.dirs : [],
          worktrees: prev ? prev.worktrees : [],
          hidden: !!hidden, loading: true, error: '',
        }))
        const args = {}
        if (path) args.path = path
        if (hidden) args.hidden = true
        rpc('browse', args).then((d) => {
          setBrowse({
            path: (d && d.path) || '',
            parent: (d && d.parent) || parentPath((d && d.path) || ''),
            dirs: Array.isArray(d && d.dirs) ? d.dirs : [],
            worktrees: Array.isArray(d && d.worktrees) ? d.worktrees : [],
            hidden: !!hidden, loading: false, error: '',
          })
        }).catch((error) => {
          setBrowse((prev) => ({
            path: prev ? prev.path : '',
            parent: prev ? prev.parent : '',
            dirs: [], worktrees: [],
            hidden: !!hidden, loading: false,
            error: error.message || String(error),
          }))
        })
      }
      function openBrowse() {
        if (!draft) return
        loadBrowse((draft.projectPath || '').trim(), false)
      }
      function navigateBrowse(target) {
        if (!browse) return
        loadBrowse(joinPath(browse.path, target), browse.hidden)
      }
      function browseUp() {
        if (!browse) return
        loadBrowse(browse.parent || parentPath(browse.path), browse.hidden)
      }
      function browsePick() {
        if (!browse || !browse.path) return
        patchEnv({ projectPath: browse.path })
        setBrowse(null)
      }
      function browseToggleHidden(hidden) {
        if (!browse) return
        loadBrowse(browse.path, hidden)
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
          const exp = m.kind === 'server' && env.expTime ? ' -PexpTime=' + env.expTime : ''
          lines.push('')
          lines.push('[' + (m.name || m.id) + ']')
          lines.push('  构建: gradlew ' + m.gradleTask + (m.key ? ' -Pkey=' + m.key : '') + (m.extraArgs ? ' ' + m.extraArgs : '') + exp)
          lines.push('  rsync: ' + m.localPath + ' → ' + env.ssh.user + '@' + env.ssh.host + ':' + m.remotePath)
          if (m.postCommand) lines.push('  ssh: ' + m.postCommand)
        }
        return lines.join('\n')
      }

      function requestDeploy() {
        if (!draft || !selected.length) return
        if (isNew) { setDeployState({ running: false, text: '请先保存环境再执行部署', kind: 'err' }); return }
        if (!draft.ssh.host || !draft.ssh.user) {
          setDeployState({ running: false, text: '该环境 SSH 配置不完整，请先保存 SSH 配置', kind: 'err' })
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
      const selSsh = draft && draft.ssh ? draft.ssh : {}
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
          onExport: exportConfig,
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
                    h('span', { className: 'dad-kindtag' }, KIND_LABEL[m.kind] || '模块'),
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
            onToggle: () => setFormOpen((v) => !v),
            onPatch: patchEnv, onPatchSsh: patchSsh, onPatchModule: patchModule,
            onAddModule: addModule, onDeleteModule: askDeleteModule,
            onSave: saveEnv, onDelete: deleteCurrentEnv, onBrowse: openBrowse,
            jdks, jdkOpen, jdkRef, onJdkFocus: openJdk, onJdkPick: pickJdk,
          })),
        confirmState ? h(ConfirmDialog, { state: confirmState, onClose: () => setConfirmState(null) }) : null,
        browse ? h(BrowseModal, {
          state: browse, onClose: () => setBrowse(null),
          onNavigate: navigateBrowse, onUp: browseUp, onPick: browsePick,
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
      '.dad-sec{padding:12px 14px;margin-bottom:10px;border-radius:var(--dsw-radius-lg);min-width:0;background:var(--dsw-alias-bg-module-platform)}',
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
      '.dad-mcard{position:relative;min-width:0;padding:10px 12px;margin-bottom:10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-2)}',
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
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: 'deploy', label: '部署', order: 45,
        }, Icon))
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: 'deploy',
        }, Panel))
      },
    }
  },
})
