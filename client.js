/**
 * dsh-console browser half.
 *
 * Registers the sidebar entry (with a live connection dot) and the 设备控制台
 * main-panel page: serial/SSH connect forms, a live transcript where every
 * agent command carries its Chinese annotation, a manual input row, and the
 * pause/resume control that cancels the running DSH turn.
 */
window.__ModuleLoader__.load({
  id: 'dsh-console',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    /** Locale namespace owned by this plugin. */
    const NS = 'dsh-console'
    /** Panel id shared by the sidebar row and the main-slot occupant. */
    const PANEL_ID = 'device-console'
    /** Host route family served by the node half. */
    const API = '/api/device-console'
    /** Client-side transcript cap. */
    const MAX_ENTRIES = 3000

    /** Surface copy; zh is the key source, en mirrors it. */
    const DICT_ZH = {
      'entry.label': '设备控制台',
      'entry.tooltip': '串口 / SSH 调试面板',
      'panel.title': '设备控制台',
      'panel.subtitle': '串口与 SSH 调试：DSH 执行的每条命令都会显示在这里，并附带中文注释。',
      'status.connected': '已连接',
      'status.disconnected': '未连接',
      'status.connecting': '连接中…',
      'status.paused': '已暂停',
      'tab.serial': '串口',
      'tab.ssh': 'SSH',
      'serial.port': '串口',
      'serial.baud': '波特率',
      'serial.refresh': '刷新',
      'serial.empty': '未检测到串口设备',
      'ssh.host': '主机',
      'ssh.port': '端口',
      'ssh.user': '用户名',
      'ssh.password': '密码',
      'ssh.useSaved': '使用已保存的密码',
      'ssh.manual': '手动输入主机',
      'ssh.pick': '已配置主机',
      'ssh.privateKey': '使用私钥（可选）',
      'ssh.privateKeyPath': '私钥路径',
      'ssh.passphrase': '私钥口令',
      'ssh.passwordHint': '密码只在本机内存中用于本次连接，不会写入会话记录。',
      'btn.connect': '连接',
      'btn.disconnect': '断开',
      'btn.pause': '暂停 DSH',
      'btn.resume': '继续',
      'btn.send': '发送',
      'btn.clear': '清屏',
      'btn.ctrlC': 'Ctrl+C',
      'btn.enter': '回车',
      'btn.space': '空格',
      'input.placeholder': '直接向设备发送命令，回车发送',
      'pending.title': 'DSH 请求连接 SSH',
      'pending.body': '请在下面输入密码并点击「连接」，连接成功后 DSH 会自动继续。',
      'pending.cancel': '拒绝连接',
      'notice.paused': '已暂停：DSH 当前操作已中断。修改需求后点「继续」，再让 DSH 按新要求操作。',
      'notice.resumed': '已恢复：DSH 可以继续操作设备了。',
      'notice.connected': '连接成功。',
      'notice.connectFailed': '连接失败：',
      'notice.disconnected': '已断开连接。',
      'notice.pendingTimeout': 'SSH 尚未连接：请在上方输入密码并点「连接」。',
      'term.empty': '暂无输出。连接串口或 SSH 后，DSH 执行的命令、中文注释和设备输出会实时出现在这里。',
      'term.autoscroll': '自动滚动',
      'term.note': '注释',
      'term.explain': '解读',
      'term.requirement': '需求',
      'term.suggestion': '建议',
      'ask.title': '告诉 DSH 你想做什么',
      'ask.placeholder': '例如：看看 NAS 内存还剩多少 / 查看串口设备支持哪些命令',
      'ask.button': '让 DSH 给出命令',
      'ask.hint': '不用记命令：写清目的，回车提交（Shift+回车换行），插件内模型会给出命令；命令要你点「执行」才发到设备，执行后自动生成中文解读。',
      'ask.sent': '命令已生成，请在「待确认命令」里点「执行」。',
      'ask.empty': '请先写需求。',
      'confirm.label': '执行前确认',
      'pending.title': '待确认命令',
      'pending.run': '执行',
      'pending.cancel': '取消',
      'pending.ran': '命令已执行，输出和 DSH 的解读会出现在右侧终端。',
      'pending.cancelled': '已取消该命令。',
      'side.hint': '不知道命令也没关系：写需求让 DSH 给命令。也可以直接在右侧终端输入框手打命令（手打命令会立即发送）。',
      'busy': '处理中…',
      'error': '错误：',
    }
    const DICT_EN = {
      'entry.label': 'Device console',
      'entry.tooltip': 'Serial / SSH console',
      'panel.title': 'Device console',
      'panel.subtitle': 'Serial and SSH debugging: every command DSH runs appears here with a Chinese annotation.',
      'status.connected': 'Connected',
      'status.disconnected': 'Disconnected',
      'status.connecting': 'Connecting…',
      'status.paused': 'Paused',
      'tab.serial': 'Serial',
      'tab.ssh': 'SSH',
      'serial.port': 'Port',
      'serial.baud': 'Baud rate',
      'serial.refresh': 'Refresh',
      'serial.empty': 'No serial device detected',
      'ssh.host': 'Host',
      'ssh.port': 'Port',
      'ssh.user': 'User',
      'ssh.password': 'Password',
      'ssh.useSaved': 'Use saved password',
      'ssh.manual': 'Enter manually',
      'ssh.pick': 'Configured host',
      'ssh.privateKey': 'Use a private key (optional)',
      'ssh.privateKeyPath': 'Private key path',
      'ssh.passphrase': 'Key passphrase',
      'ssh.passwordHint': 'The password is used from memory for this connection only; it is never written to the session log.',
      'btn.connect': 'Connect',
      'btn.disconnect': 'Disconnect',
      'btn.pause': 'Pause DSH',
      'btn.resume': 'Resume',
      'btn.send': 'Send',
      'btn.clear': 'Clear',
      'btn.ctrlC': 'Ctrl+C',
      'btn.enter': 'Enter',
      'btn.space': 'Space',
      'input.placeholder': 'Send a command to the device (Enter to send)',
      'pending.title': 'DSH requests an SSH connection',
      'pending.body': 'Enter the password below and click Connect; DSH continues automatically after the connection succeeds.',
      'pending.cancel': 'Decline',
      'notice.paused': 'Paused: the running DSH operation was interrupted. Change your request, click Resume, then ask DSH to continue.',
      'notice.resumed': 'Resumed: DSH can operate the device again.',
      'notice.connected': 'Connected.',
      'notice.connectFailed': 'Connection failed: ',
      'notice.disconnected': 'Disconnected.',
      'notice.pendingTimeout': 'SSH is not connected: enter the password above and click Connect.',
      'term.empty': 'No output yet. Once a serial device or SSH host is connected, commands, annotations and device output appear here live.',
      'term.autoscroll': 'Auto scroll',
      'term.note': 'Note',
      'term.explain': 'Explanation',
      'term.requirement': 'Request',
      'term.suggestion': 'Suggestion',
      'ask.title': 'Tell DSH what you want',
      'ask.placeholder': 'For example: how much memory is left on the NAS?',
      'ask.button': 'Ask DSH for commands',
      'ask.hint': 'You do not need to know commands: describe the goal and the plugin model proposes commands (no chat involved). Nothing reaches the device until you click Run, and an explanation appears after execution.',
      'ask.sent': 'Request sent to DSH; its commands will appear under Pending commands.',
      'ask.empty': 'Write a request first.',
      'confirm.label': 'Confirm before execution',
      'pending.title': 'Pending commands',
      'pending.run': 'Run',
      'pending.cancel': 'Cancel',
      'pending.ran': 'Command executed; output and DSH explanation appear in the terminal.',
      'pending.cancelled': 'Command cancelled.',
      'side.hint': 'Describe the goal instead of typing commands. You can still type a command into the terminal input (typed commands are sent immediately).',
      'busy': 'Working…',
      'error': 'Error: ',
    }

    /** Styles injected by the page component (removed with it). */
    const CSS = `
.dc-page{display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;padding:14px 18px;gap:10px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px}
.dc-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dc-title{font-size:16px;font-weight:600}
.dc-sub{color:var(--dsw-alias-label-secondary);font-size:12px;flex:1;min-width:220px}
.dc-pill{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:2px 10px;font-size:12px;background:var(--dsw-alias-bg-layer-1);max-width:100%}
.dc-pill span.dc-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dc-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}
.dc-dot.on{background:var(--dsw-alias-state-success-primary)}
.dc-dot.warn{background:var(--dsw-alias-state-warn-primary)}
.dc-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dc-btn{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);border-radius:7px;padding:5px 12px;cursor:pointer;font-size:12px;line-height:18px}
.dc-btn:hover{border-color:var(--dsw-alias-border-l2)}
.dc-btn:disabled{opacity:.5;cursor:default}
.dc-btn.primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-bg-base)}
.dc-btn.warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.dc-btn.ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
.dc-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px;display:flex;flex-direction:column;gap:10px}
.dc-tabs{display:flex;gap:6px}
.dc-tab{border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:7px;padding:4px 12px;cursor:pointer;font-size:12px}
.dc-tab.active{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1)}
.dc-row{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}
.dc-field{display:flex;flex-direction:column;gap:4px;min-width:120px}
.dc-field.grow{flex:1}
.dc-field label{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dc-input,.dc-select{border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:5px 8px;font-size:12px;min-height:20px;box-sizing:border-box;width:100%}
.dc-check{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dc-hint{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dc-hint.warn{color:var(--dsw-alias-state-warn-primary)}
.dc-banner{border:1px solid var(--dsw-alias-state-warn-primary);border-radius:8px;padding:8px 10px;background:var(--dsw-alias-bg-layer-2);display:flex;flex-direction:column;gap:4px}
.dc-banner strong{color:var(--dsw-alias-state-warn-primary);font-size:12px}
.dc-banner .dc-hint{font-size:12px}
.dc-term{flex:1;min-height:160px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);padding:10px 12px;font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;font-size:12.5px;line-height:1.55}
.dc-body{display:grid;grid-template-columns:minmax(250px,340px) minmax(0,1fr);gap:10px;flex:1;min-height:0}
.dc-side{display:flex;flex-direction:column;gap:8px;min-height:0;overflow:auto}
.dc-main{display:flex;flex-direction:column;gap:8px;min-height:0}
.dc-askcard{display:flex;flex-direction:column;gap:6px}
.dc-ask-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dc-textarea{width:100%;box-sizing:border-box;min-height:64px;resize:vertical;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:6px 8px;font-size:12px;font-family:inherit;line-height:1.5}
.dc-pending-card{border-color:var(--dsw-alias-state-warn-primary)}
.dc-pending-head{font-size:12px;font-weight:600;color:var(--dsw-alias-state-warn-primary);margin-bottom:4px}
.dc-pending-row{border-top:1px dashed var(--dsw-alias-border-l1);padding:6px 0;display:flex;flex-direction:column;gap:3px}
.dc-pending-row:first-of-type{border-top:none}
.dc-pending-cmd{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12.5px;color:var(--dsw-alias-label-primary);word-break:break-word}
.dc-pending-note{font-size:12px;color:var(--dsw-alias-state-success-primary);font-style:italic;word-break:break-word}
.dc-actions{display:flex;gap:6px;margin-top:2px}
.dc-req{color:var(--dsw-alias-brand-primary);font-style:italic}
.dc-sugg{color:var(--dsw-alias-brand-primary);font-style:italic;opacity:.9}
@media (max-width: 860px){
  .dc-body{grid-template-columns:1fr;overflow:auto}
  .dc-side{order:2;overflow:visible}
  .dc-main{order:1;min-height:320px}
}
.dc-line{white-space:pre-wrap;word-break:break-word}
.dc-cmd{color:var(--dsw-alias-label-primary);margin-top:6px}
.dc-cmd .dc-prompt{color:var(--dsw-alias-brand-primary);font-weight:700}
.dc-note{color:var(--dsw-alias-state-success-primary);font-style:italic}
.dc-expl{color:var(--dsw-alias-state-success-primary);font-style:italic;margin:2px 0 4px 12px}
.dc-expl .dc-expl-tag{font-style:normal;font-weight:600;margin-right:6px;opacity:.9}
.dc-out{color:var(--dsw-alias-label-primary);opacity:.92}
.dc-sys{color:var(--dsw-alias-label-secondary);font-style:italic}
.dc-err{color:var(--dsw-alias-state-error-primary)}
.dc-empty{color:var(--dsw-alias-label-secondary);font-style:italic}
.dc-inputrow{display:flex;gap:8px;align-items:center}
.dc-inputrow .dc-input{flex:1}
.dc-notice{border-radius:8px;padding:6px 10px;font-size:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.dc-notice.error{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dc-notice.ok{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.dc-notice.warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
details.dc-adv{border-top:1px dashed var(--dsw-alias-border-l1);padding-top:8px}
details.dc-adv summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary)}
`

    /**
     * Merge newly polled entries into the transcript.
     * @param {Array<object>} previous entries already rendered.
     * @param {Array<object>} incoming freshly polled entries.
     * @returns {Array<object>} merged entries.
     */
    function mergeEntries(previous, incoming) {
      if (!Array.isArray(incoming) || incoming.length === 0) return previous
      const known = previous.length === 0 ? 0 : previous[previous.length - 1].seq
      const fresh = incoming.filter(entry => entry.seq > known)
      if (fresh.length === 0) return previous
      const merged = previous.concat(fresh)
      return merged.length > MAX_ENTRIES ? merged.slice(merged.length - MAX_ENTRIES) : merged
    }

    /**
     * One console API call.
     * @param {string} path path under the API base.
     * @param {object} [init] fetch init.
     * @returns {Promise<object>} parsed JSON body.
     */
    async function request(path, init) {
      const response = await fetch(API + path, {
        cache: 'no-store',
        ...init,
        headers: { 'content-type': 'application/json' },
      })
      const raw = await response.text()
      let data
      try {
        data = raw === '' ? {} : JSON.parse(raw)
      } catch {
        data = { error: raw }
      }
      if (!response.ok) throw new Error(data && data.error ? String(data.error) : 'HTTP ' + response.status)
      return data
    }

    /**
     * Human-readable message for a thrown value.
     * @param {unknown} error thrown value.
     * @returns {string} message.
     */
    function messageOf(error) {
      if (error instanceof Error) return error.message
      return String(error)
    }

    /**
     * Poll the console state while mounted.
     * @returns {object} current view state.
     */
    function useConsoleState() {
      const [view, setView] = useState({
        session: null,
        paused: false,
        pending: null,
        entries: [],
        ports: [],
        portsError: null,
        sshHosts: [],
        error: null,
      })
      const seqRef = useRef(0)
      useEffect(() => {
        let alive = true
        let timer = null
        const tick = async () => {
          try {
            const next = await request('/state?since=' + seqRef.current)
            if (!alive) return
            const lastSeq = typeof next.lastSeq === 'number' ? next.lastSeq : seqRef.current
            const reset = lastSeq < seqRef.current
            seqRef.current = lastSeq
            setView(prev => ({
              ...prev,
              ...next,
              errors: undefined,
              entries: reset ? (next.entries || []) : mergeEntries(prev.entries, next.entries),
              error: null,
            }))
          } catch (error) {
            if (!alive) return
            setView(prev => ({ ...prev, error: messageOf(error) }))
          } finally {
            if (alive) timer = setTimeout(tick, 550)
          }
        }
        tick()
        return () => {
          alive = false
          if (timer !== null) clearTimeout(timer)
        }
      }, [])
      return view
    }

    /**
     * The sidebar row glyph with a live connection dot.
     * @param {{size?: number, active?: boolean}} props shell icon props.
     * @returns {React.ReactElement} glyph.
     */
    function ConsoleIcon(props) {
      const size = typeof props?.size === 'number' && props.size > 0 ? props.size : 16
      const [state, setState] = useState({ connected: false, paused: false })
      useEffect(() => {
        let alive = true
        let timer = null
        const tick = async () => {
          try {
            const next = await request('/state?history=0&since=' + Number.MAX_SAFE_INTEGER)
            if (!alive) return
            setState({ connected: next.session !== null, paused: next.paused === true })
          } catch {
            // The dot is advisory; a failed poll leaves the last value.
          } finally {
            if (alive) timer = setTimeout(tick, 4000)
          }
        }
        tick()
        return () => {
          alive = false
          if (timer !== null) clearTimeout(timer)
        }
      }, [])
      const dotColor = state.paused
        ? 'var(--dsw-alias-state-warn-primary)'
        : 'var(--dsw-alias-state-success-primary)'
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('rect', { x: 1.6, y: 2.4, width: 12.8, height: 11.2, rx: 1.8 }),
        h('path', { d: 'M4.2 5.4l2.6 2.6-2.6 2.6' }),
        h('path', { d: 'M8.4 10.6h3.4' }),
        h('circle', { cx: 13.4, cy: 2.6, r: 2.1, fill: dotColor, stroke: 'none', opacity: state.connected ? 1 : 0.25 }),
      )
    }

    /**
     * The main-panel console page.
     * @returns {React.ReactElement} page.
     */
    function ConsolePage() {
      const view = useConsoleState()
      const t = ConsolePage.__translate
      const [tab, setTab] = useState('serial')
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)
      const [input, setInput] = useState('')
      const [autoScroll, setAutoScroll] = useState(true)
      const [askText, setAskText] = useState('')
      const [askBusy, setAskBusy] = useState(false)
      const [pendingBusyId, setPendingBusyId] = useState(null)
      const [serialForm, setSerialForm] = useState({ port: '', baudRate: '115200' })
      const [sshForm, setSshForm] = useState({
        alias: '',
        host: '',
        port: '22',
        username: '',
        password: '',
        useSaved: true,
        privateKeyPath: '',
        passphrase: '',
      })
      const termRef = useRef(null)
      const passwordRef = useRef(null)

      const connected = view.session !== null
      const sessionKind = view.session ? view.session.kind : 'none'
      const selectedHost = view.sshHosts.find(host => host.alias === sshForm.alias)
      const canUseSaved = Boolean(selectedHost && selectedHost.hasSavedPassword)

      /** Run one panel action with busy/notice handling. */
      const run = useCallback(async action => {
        setBusy(true)
        setNotice(null)
        try {
          await action()
        } catch (error) {
          setNotice({ kind: 'error', text: t('notice.connectFailed') + messageOf(error) })
        } finally {
          setBusy(false)
        }
      }, [t])

      // Default selectors once lists arrive from the host.
      useEffect(() => {
        if (serialForm.port === '' && view.ports.length > 0) {
          setSerialForm(prev => ({ ...prev, port: view.ports[0].path }))
        }
      }, [view.ports, serialForm.port])

      useEffect(() => {
        if (sshForm.host === '' && view.sshHosts.length > 0) {
          const first = view.sshHosts[0]
          setSshForm(prev => ({
            ...prev,
            alias: first.alias,
            host: first.host,
            port: String(first.port),
            username: first.user,
            useSaved: true,
          }))
        }
      }, [view.sshHosts, sshForm.host])

      // A pending host request switches to the SSH form and focuses the password.
      const pendingKey = view.pending ? view.pending.requestedAt : 0
      useEffect(() => {
        if (!view.pending) return
        setTab('ssh')
        setSshForm(prev => ({
          ...prev,
          alias: view.pending.alias || prev.alias,
          host: view.pending.host,
          port: String(view.pending.port),
          username: view.pending.username,
        }))
        setTimeout(() => {
          if (passwordRef.current) passwordRef.current.focus()
        }, 80)
      }, [pendingKey])

      // Follow the tail while the user has not scrolled away.
      useEffect(() => {
        if (autoScroll && termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight
      }, [view.entries.length, autoScroll])

      const connectSerial = useCallback(() => {
        void run(async () => {
          await request('/connect', {
            method: 'POST',
            body: JSON.stringify({
              kind: 'serial',
              port: serialForm.port,
              baudRate: Number(serialForm.baudRate),
            }),
          })
          setNotice({ kind: 'ok', text: t('notice.connected') })
        })
      }, [run, serialForm, t])

      const connectSsh = useCallback(() => {
        void run(async () => {
          await request('/connect', {
            method: 'POST',
            body: JSON.stringify({
              kind: 'ssh',
              alias: sshForm.alias,
              host: sshForm.host,
              port: Number(sshForm.port),
              username: sshForm.username,
              password: sshForm.password,
              useSavedPassword: sshForm.useSaved && canUseSaved,
              privateKeyPath: sshForm.privateKeyPath,
              passphrase: sshForm.passphrase,
            }),
          })
          setNotice({ kind: 'ok', text: t('notice.connected') })
          setSshForm(prev => ({ ...prev, password: '' }))
        })
      }, [run, sshForm, canUseSaved, t])

      const disconnect = useCallback(() => {
        void run(async () => {
          await request('/disconnect', { method: 'POST', body: '{}' })
          setNotice({ kind: 'warn', text: t('notice.disconnected') })
        })
      }, [run, t])

      const togglePause = useCallback(() => {
        const nextPaused = !view.paused
        void run(async () => {
          await request('/pause', { method: 'POST', body: JSON.stringify({ paused: nextPaused }) })
          setNotice({ kind: 'warn', text: nextPaused ? t('notice.paused') : t('notice.resumed') })
        })
      }, [run, view.paused, t])

      const sendInput = useCallback(() => {
        const data = input
        if (data === '') return
        setInput('')
        void run(async () => {
          await request('/send', {
            method: 'POST',
            body: JSON.stringify({
              data,
              echo: true,
              lineEnding: sessionKind === 'serial' ? 'crlf' : 'cr',
            }),
          })
        })
      }, [input, run, sessionKind])

      const sendCtrlC = useCallback(() => {
        void run(async () => {
          await request('/send', {
            method: 'POST',
            body: JSON.stringify({ data: '\\u0003', escape: true, echo: false, note: '面板发送 Ctrl+C' }),
          })
        })
      }, [run])

      /** Send one bare key (Enter / Space) to the device. */
      const sendKey = useCallback(
        (data, display, note) => {
          void run(async () => {
            await request('/send', {
              method: 'POST',
              body: JSON.stringify({ data, escape: true, echo: false, display, note }),
            })
          })
        },
        [run],
      )

      const sendEnter = useCallback(() => sendKey('\\r', '回车 (Enter)', '面板发送回车'), [sendKey])

      const sendSpace = useCallback(() => sendKey(' ', '空格 (Space)', '面板发送空格'), [sendKey])

      const clearTranscript = useCallback(() => {
        void run(async () => {
          await request('/clear', { method: 'POST', body: '{}' })
        })
      }, [run])

      const cancelPending = useCallback(() => {
        void run(async () => {
          await request('/cancel-ssh', { method: 'POST', body: '{}' })
        })
      }, [run])

      /** Send the panel requirement to DSH and wait for its commands. */
      const askDsh = useCallback(() => {
        const text = askText.trim()
        if (text === '') {
          setNotice({ kind: 'warn', text: t('ask.empty') })
          return
        }
        setAskBusy(true)
        setNotice(null)
        request('/ask', { method: 'POST', body: JSON.stringify({ text }) })
          .then(response => {
            setAskText('')
            const count = Array.isArray(response.suggestions) ? response.suggestions.length : 0
            setNotice({
              kind: count > 0 ? 'ok' : 'warn',
              text: response.message || t('ask.sent'),
            })
          })
          .catch(error => setNotice({ kind: 'error', text: t('error') + messageOf(error) }))
          .finally(() => setAskBusy(false))
      }, [askText, t])

      /** Execute one pending command the user confirmed. */
      const runPending = useCallback(
        id => {
          setPendingBusyId(id)
          setNotice(null)
          request('/pending/execute', { method: 'POST', body: JSON.stringify({ id }) })
            .then(() => setNotice({ kind: 'ok', text: t('pending.ran') }))
            .catch(error => setNotice({ kind: 'error', text: t('error') + messageOf(error) }))
            .finally(() => setPendingBusyId(null))
        },
        [t],
      )

      /** Cancel one pending command. */
      const cancelPendingExec = useCallback(
        id => {
          setPendingBusyId(id)
          setNotice(null)
          request('/pending/cancel', { method: 'POST', body: JSON.stringify({ id }) })
            .then(() => setNotice({ kind: 'warn', text: t('pending.cancelled') }))
            .catch(error => setNotice({ kind: 'error', text: t('error') + messageOf(error) }))
            .finally(() => setPendingBusyId(null))
        },
        [t],
      )

      /** Toggle the confirm-before-send gate. */
      const toggleConfirmMode = useCallback(enabled => {
        request('/confirm-mode', { method: 'POST', body: JSON.stringify({ enabled }) }).catch(error =>
          setNotice({ kind: 'error', text: t('error') + messageOf(error) }),
        )
      }, [t])

      /** One tab button. */
      const tabButton = (key, label) =>
        h(
          'button',
          {
            type: 'button',
            key,
            className: 'dc-tab' + (tab === key ? ' active' : ''),
            onClick: () => setTab(key),
          },
          label,
        )

      /** Serial connect form. */
      const serialFormView = h(
        'div',
        { className: 'dc-row' },
        h(
          'div',
          { className: 'dc-field grow' },
          h('label', null, t('serial.port')),
          h(
            'select',
            {
              className: 'dc-select',
              value: serialForm.port,
              onChange: event => setSerialForm(prev => ({ ...prev, port: event.target.value })),
            },
            view.ports.length === 0
              ? h('option', { value: '' }, t('serial.empty'))
              : view.ports.map(port => h('option', { key: port.path, value: port.path }, port.path + (port.manufacturer ? ' · ' + port.manufacturer : ''))),
          ),
        ),
        h(
          'div',
          { className: 'dc-field' },
          h('label', null, t('serial.baud')),
          h(
            'select',
            {
              className: 'dc-select',
              value: serialForm.baudRate,
              onChange: event => setSerialForm(prev => ({ ...prev, baudRate: event.target.value })),
            },
            ['9600', '19200', '38400', '57600', '115200', '230400', '460800', '921600'].map(rate =>
              h('option', { key: rate, value: rate }, rate),
            ),
          ),
        ),
        h(
          'button',
          { type: 'button', className: 'dc-btn primary', disabled: busy, onClick: connectSerial },
          t('btn.connect'),
        ),
        h('div', { className: 'dc-hint' }, view.portsError ? t('error') + view.portsError : ''),
      )

      /** SSH connect form. */
      const sshFormView = h(
        'div',
        { className: 'dc-row' },
        h(
          'div',
          { className: 'dc-field' },
          h('label', null, t('ssh.pick')),
          h(
            'select',
            {
              className: 'dc-select',
              value: sshForm.alias,
              onChange: event => {
                const alias = event.target.value
                const host = view.sshHosts.find(row => row.alias === alias)
                setSshForm(prev => ({
                  ...prev,
                  alias,
                  host: host ? host.host : prev.host,
                  port: host ? String(host.port) : prev.port,
                  username: host ? host.user : prev.username,
                  useSaved: true,
                }))
              },
            },
            h('option', { value: '' }, t('ssh.manual')),
            view.sshHosts.map(host => h('option', { key: host.alias, value: host.alias }, host.alias + ' → ' + host.user + '@' + host.host)),
          ),
        ),
        h(
          'div',
          { className: 'dc-field grow' },
          h('label', null, t('ssh.host')),
          h('input', {
            className: 'dc-input',
            value: sshForm.host,
            placeholder: '192.168.1.10',
            onChange: event => setSshForm(prev => ({ ...prev, host: event.target.value })),
          }),
        ),
        h(
          'div',
          { className: 'dc-field' },
          h('label', null, t('ssh.port')),
          h('input', {
            className: 'dc-input',
            value: sshForm.port,
            onChange: event => setSshForm(prev => ({ ...prev, port: event.target.value })),
          }),
        ),
        h(
          'div',
          { className: 'dc-field' },
          h('label', null, t('ssh.user')),
          h('input', {
            className: 'dc-input',
            value: sshForm.username,
            onChange: event => setSshForm(prev => ({ ...prev, username: event.target.value })),
          }),
        ),
        h(
          'div',
          { className: 'dc-field grow' },
          h('label', null, t('ssh.password')),
          h('input', {
            ref: passwordRef,
            className: 'dc-input',
            type: 'password',
            value: sshForm.password,
            placeholder: canUseSaved ? '••••••（留空则用已保存密码）' : '',
            onChange: event => setSshForm(prev => ({ ...prev, password: event.target.value })),
            onKeyDown: event => {
              if (event.key === 'Enter') connectSsh()
            },
          }),
        ),
        canUseSaved
          ? h(
              'label',
              { className: 'dc-check' },
              h('input', {
                type: 'checkbox',
                checked: sshForm.useSaved,
                onChange: event => setSshForm(prev => ({ ...prev, useSaved: event.target.checked })),
              }),
              t('ssh.useSaved'),
            )
          : null,
        h(
          'button',
          { type: 'button', className: 'dc-btn primary', disabled: busy, onClick: connectSsh },
          t('btn.connect'),
        ),
        h(
          'details',
          { className: 'dc-adv' },
          h('summary', null, t('ssh.privateKey')),
          h(
            'div',
            { className: 'dc-row', style: { marginTop: '8px' } },
            h(
              'div',
              { className: 'dc-field grow' },
              h('label', null, t('ssh.privateKeyPath')),
              h('input', {
                className: 'dc-input',
                value: sshForm.privateKeyPath,
                placeholder: 'C:\\\\Users\\\\me\\\\.ssh\\\\id_ed25519',
                onChange: event => setSshForm(prev => ({ ...prev, privateKeyPath: event.target.value })),
              }),
            ),
            h(
              'div',
              { className: 'dc-field' },
              h('label', null, t('ssh.passphrase')),
              h('input', {
                className: 'dc-input',
                type: 'password',
                value: sshForm.passphrase,
                onChange: event => setSshForm(prev => ({ ...prev, passphrase: event.target.value })),
              }),
            ),
          ),
        ),
        h('div', { className: 'dc-hint' }, t('ssh.passwordHint')),
      )

      /** Connection card shown while disconnected. */
      const connectCard = h(
        'div',
        { className: 'dc-card' },
        view.pending
          ? h(
              'div',
              { className: 'dc-banner' },
              h('strong', null, t('pending.title') + '：' + view.pending.username + '@' + view.pending.host + ':' + view.pending.port),
              h('div', { className: 'dc-hint' }, t('pending.body')),
              h(
                'div',
                { style: { display: 'flex', gap: '8px' } },
                h('button', { type: 'button', className: 'dc-btn warn', onClick: cancelPending }, t('pending.cancel')),
              ),
            )
          : null,
        h('div', { className: 'dc-tabs' }, tabButton('serial', t('tab.serial')), tabButton('ssh', t('tab.ssh'))),
        tab === 'serial' ? serialFormView : sshFormView,
      )

      /** One transcript entry. */
      const renderEntry = entry => {
        if (entry.kind === 'command') {
          return h(
            'div',
            { key: entry.seq, className: 'dc-line dc-cmd' },
            h('span', { className: 'dc-prompt' }, '› '),
            h('span', null, entry.text),
            entry.note ? h('span', { className: 'dc-note' }, '   // ' + entry.note) : null,
          )
        }
        if (entry.kind === 'output') {
          return h('div', { key: entry.seq, className: 'dc-line dc-out' }, entry.text)
        }
        if (entry.kind === 'note') {
          return h(
            'div',
            { key: entry.seq, className: 'dc-line dc-expl' },
            h('span', { className: 'dc-expl-tag' }, t('term.explain') + '：'),
            h('span', null, entry.text),
          )
        }
        if (entry.kind === 'requirement') {
          return h(
            'div',
            { key: entry.seq, className: 'dc-line dc-req' },
            t('term.requirement') + '：' + entry.text,
          )
        }
        if (entry.kind === 'suggestion') {
          return h(
            'div',
            { key: entry.seq, className: 'dc-line dc-sugg' },
            t('term.suggestion') + '：' + entry.text,
          )
        }
        return h(
          'div',
          { key: entry.seq, className: 'dc-line ' + (entry.kind === 'error' ? 'dc-err' : 'dc-sys') },
          entry.text,
        )
      }

      const kindLabel = sessionKind === 'serial' ? t('tab.serial') : sessionKind === 'ssh' ? t('tab.ssh') : ''

      /** Commands the agent proposed and the user has not answered yet. */
      const pendingExecs = Array.isArray(view.pendingExecs) ? view.pendingExecs : []
      const pendingList =
        pendingExecs.length === 0
          ? null
          : h(
              'div',
              { className: 'dc-card dc-pending-card' },
              h('div', { className: 'dc-pending-head' }, t('pending.title')),
              pendingExecs.map(item =>
                h(
                  'div',
                  { key: item.id, className: 'dc-pending-row' },
                  h('div', { className: 'dc-pending-cmd' }, '› ' + item.command),
                  item.note ? h('div', { className: 'dc-pending-note' }, '// ' + item.note) : null,
                  h(
                    'div',
                    { className: 'dc-actions' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dc-btn primary',
                        disabled: pendingBusyId !== null,
                        onClick: () => runPending(item.id),
                      },
                      pendingBusyId === item.id ? t('busy') : t('pending.run'),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dc-btn',
                        disabled: pendingBusyId !== null,
                        onClick: () => cancelPendingExec(item.id),
                      },
                      t('pending.cancel'),
                    ),
                  ),
                ),
              ),
            )

      return h(
        'div',
        { className: 'dc-page' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'dc-head' },
          h('div', { className: 'dc-title' }, t('panel.title')),
          h(
            'div',
            { className: 'dc-pill' },
            h('span', { className: 'dc-dot' + (connected ? ' on' : '') + (view.paused ? ' warn' : '') }),
            h('span', { className: 'dc-label' }, connected ? t('status.connected') + ' · ' + kindLabel + ' · ' + view.session.label : t('status.disconnected')),
          ),
          view.paused ? h('div', { className: 'dc-pill' }, h('span', { className: 'dc-dot warn' }), h('span', null, t('status.paused'))) : null,
          h('div', { className: 'dc-sub' }, t('panel.subtitle')),
          h(
            'div',
            { className: 'dc-toolbar' },
            h(
              'label',
              { className: 'dc-check' },
              h('input', {
                type: 'checkbox',
                checked: view.confirmMode !== false,
                onChange: event => toggleConfirmMode(event.target.checked),
              }),
              t('confirm.label'),
            ),
            h(
              'label',
              { className: 'dc-check' },
              h('input', { type: 'checkbox', checked: autoScroll, onChange: event => setAutoScroll(event.target.checked) }),
              t('term.autoscroll'),
            ),
            h(
              'button',
              { type: 'button', className: 'dc-btn ' + (view.paused ? 'ok' : 'warn'), disabled: busy, onClick: togglePause },
              view.paused ? t('btn.resume') : t('btn.pause'),
            ),
            connected
              ? h('button', { type: 'button', className: 'dc-btn', disabled: busy, onClick: disconnect }, t('btn.disconnect'))
              : null,
          ),
        ),
        connected ? null : connectCard,
        h(
          'div',
          { className: 'dc-body' },
          h(
            'div',
            { className: 'dc-side' },
            h(
              'div',
              { className: 'dc-card dc-askcard' },
              h('div', { className: 'dc-ask-title' }, t('ask.title')),
              h('textarea', {
                className: 'dc-textarea',
                value: askText,
                placeholder: t('ask.placeholder'),
                onChange: event => setAskText(event.target.value),
                onKeyDown: event => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent?.isComposing) {
                    event.preventDefault()
                    askDsh()
                  }
                },
              }),
              h(
                'div',
                { className: 'dc-actions' },
                h(
                  'button',
                  { type: 'button', className: 'dc-btn primary', disabled: askBusy, onClick: askDsh },
                  askBusy ? t('busy') : t('ask.button'),
                ),
              ),
              h('div', { className: 'dc-hint' }, t('ask.hint')),
            ),
            pendingList,
            h('div', { className: 'dc-hint' }, t('side.hint')),
          ),
          h(
            'div',
            { className: 'dc-main' },
            h(
              'div',
              {
                className: 'dc-term',
                ref: termRef,
                onScroll: event => {
                  const node = event.currentTarget
                  const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 24
                  if (atBottom !== autoScroll) setAutoScroll(atBottom)
                },
              },
              view.entries.length === 0
                ? h('div', { className: 'dc-empty' }, t('term.empty'))
                : view.entries.map(renderEntry),
            ),
            h(
              'div',
              { className: 'dc-inputrow' },
              h('input', {
                className: 'dc-input',
                value: input,
                placeholder: t('input.placeholder'),
                disabled: !connected || busy,
                onChange: event => setInput(event.target.value),
                onKeyDown: event => {
                  if (event.key === 'Enter' && !event.nativeEvent?.isComposing && !event.isComposing) sendInput()
                },
              }),
              h('button', { type: 'button', className: 'dc-btn primary', disabled: !connected || busy || input === '', onClick: sendInput }, t('btn.send')),
              h('button', { type: 'button', className: 'dc-btn', disabled: !connected || busy, onClick: sendCtrlC }, t('btn.ctrlC')),
              h('button', { type: 'button', className: 'dc-btn', disabled: !connected || busy, onClick: sendEnter, title: '发送一个回车键' }, t('btn.enter')),
              h('button', { type: 'button', className: 'dc-btn', disabled: !connected || busy, onClick: sendSpace, title: '发送一个空格键' }, t('btn.space')),
              h('button', { type: 'button', className: 'dc-btn', disabled: busy, onClick: clearTranscript }, t('btn.clear')),
            ),
            notice
              ? h('div', { className: 'dc-notice ' + (notice.kind === 'error' ? 'error' : notice.kind === 'ok' ? 'ok' : 'warn') }, notice.text)
              : view.error
                ? h('div', { className: 'dc-notice error' }, t('error') + view.error)
                : null,
            busy ? h('div', { className: 'dc-hint' }, t('busy')) : null,
          ),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        let t = key => key
        try {
          ctx.effect(() => ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN }), 'dsh-console: locale')
          t = ctx.locale.bind(NS)
        } catch (error) {
          console.warn('[dsh-console] locale registration failed:', error)
        }
        ConsolePage.__translate = key => {
          try {
            const translated = t(key)
            return typeof translated === 'string' && translated !== '' ? translated : key
          } catch {
            return key
          }
        }
        ctx.effect(() => {
          const slots = ctx.slots
          const disposers = []
          try {
            disposers.push(
              slots.inject('sidebar.panellist', () =>
                slots.register(
                  {
                    name: 'sidebar.panellist',
                    id: PANEL_ID,
                    order: 55,
                    label: () => ConsolePage.__translate('entry.label'),
                  },
                  ConsoleIcon,
                ),
              ),
            )
            disposers.push(slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, ConsolePage)))
          } catch (error) {
            console.warn('[dsh-console] slot registration failed:', error)
          }
          return () => {
            for (const dispose of disposers) {
              try {
                dispose()
              } catch {
                // ignore
              }
            }
          }
        }, 'dsh-console: slots')
      },
    }
  },
})
