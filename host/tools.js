/**
 * Agent tools for the device console.
 *
 * Every tool routes through the same engine the web panel uses, so the GUI and
 * the model operate one connection. The tools never accept SSH passwords: for
 * SSH the model asks the panel to connect (console_ssh_connect), and the user
 * types the credentials there.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

/**
 * One text content block.
 * @param {string} value text.
 * @returns {Array<{type:'text', text:string}>} content blocks.
 */
function text(value) {
  return [{ type: 'text', text: value }]
}

/**
 * Render a list of strings as bullet lines.
 * @param {string[]} rows rows.
 * @param {string} empty text when empty.
 * @returns {string} rendered text.
 */
function bullets(rows, empty) {
  return rows.length === 0 ? empty : rows.map(row => '- ' + row).join('\n')
}

/**
 * Render one console status value.
 * @param {object} value status value.
 * @returns {string} rendered text.
 */
function renderStatus(value) {
  const lines = []
  lines.push(value.connected ? `连接状态：已连接（${value.kind}）` : '连接状态：未连接')
  if (value.connected) lines.push(`设备：${value.label}`)
  lines.push(`交换机厂商：${value.vendor}${value.vendorSource === 'auto' ? '（自动识别）' : value.vendorSource === 'manual' ? '（手动选择）' : ''}`)
  lines.push(`暂停状态：${value.paused ? '已暂停（用户要求停下）' : '运行中'}`)
  if (value.pending !== '') lines.push(`待处理：${value.pending}`)
  lines.push('')
  lines.push('串口设备：')
  lines.push(bullets(value.ports, '  （未检测到串口）'))
  lines.push('')
  lines.push('已配置 SSH 主机：')
  lines.push(bullets(value.hosts, '  （无已配置主机，可在面板手动输入）'))
  if (value.recent !== '') {
    lines.push('')
    lines.push('最近输出：')
    lines.push(value.recent)
  }
  return lines.join('\n')
}

/**
 * Render one exec value.
 * @param {object} value exec value.
 * @returns {string} rendered text.
 */
function renderExec(value) {
  const statusText = {
    completed: '已完成',
    timeout: '等待输出超时（命令可能无回显或仍在运行）',
    paused: '用户已暂停，操作被中断',
    aborted: '调用被取消',
    'awaiting-confirmation': '已提交到面板待确认区，等待用户点「执行」',
  }[value.status] ?? value.status
  const lines = [
    `状态：${statusText}`,
    `命令：${value.command}`,
    `注释：${value.note === '' ? '（未提供）' : value.note}`,
    `耗时：${value.durationMs} ms`,
    '',
    '输出：',
    value.output === '' ? '（无输出）' : value.output,
  ]
  if (value.status === 'awaiting-confirmation') {
    lines.push('')
    lines.push('命令还没有发到设备：用户在面板点「执行」后才会发送，届时真实输出会作为新消息发给你，再调用 console_note 解读。')
  }
  return lines.join('\n')
}

/**
 * Build every console tool.
 * @param {import('./engine.js').ConsoleEngine} engine console engine.
 * @param {object} helpers host helpers.
 * @param {() => object|undefined} helpers.getInitiator returns the initiating agent.
 * @returns {Array<object>} tool definitions.
 */
export function makeTools(engine, helpers) {
  const remember = () => {
    try {
      engine.rememberAgent(helpers.getInitiator?.())
    } catch {
      // The agent lookup is best-effort.
    }
  }

  const statusTool = defineTool({
    name: 'console_status',
    description:
      '查看「设备控制台」的连接状态：当前是串口还是 SSH、设备名、是否被用户暂停、可用的串口与已配置的 SSH 主机，以及最近一段终端输出。操作设备前先调用它了解是否已连接。',
    parameters: {
      recent: {
        type: 'integer',
        description: '要返回的最近终端条目数量，默认 12，最大 50。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          connected: { type: 'boolean', required: true },
          kind: { type: 'string', required: true, enum: ['none', 'serial', 'ssh'] },
          label: { type: 'string', required: true },
          vendor: { type: 'string', required: true },
          vendorId: { type: 'string', required: true },
          vendorSource: { type: 'string', required: true },
          paused: { type: 'boolean', required: true },
          pending: { type: 'string', required: true },
          ports: { type: 'array', items: { type: 'string' }, required: true },
          hosts: { type: 'array', items: { type: 'string' }, required: true },
          recent: { type: 'string', required: true },
        },
      },
      render: (_args, value) => text(renderStatus(value)),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      remember()
      const ports = await engine.listPorts()
      const hosts = await engine.listHosts()
      const session = engine.hub.session
      const recent = typeof args.recent === 'number' ? args.recent : 12
      const vendor = engine.vendorInfo()
      return {
        connected: engine.connected,
        kind: session?.kind ?? 'none',
        label: session?.label ?? '',
        vendor: vendor.label,
        vendorId: vendor.id,
        vendorSource: vendor.source ?? '',
        paused: engine.hub.paused,
        pending: engine.hub.pending === null ? '' : `等待用户连接 SSH ${engine.hub.pending.username}@${engine.hub.pending.host}`,
        ports: ports.map(port => `${port.path}${port.manufacturer ? ` (${port.manufacturer})` : ''}`),
        hosts: hosts.map(host => `${host.alias} → ${host.user}@${host.host}:${host.port}${host.hasSavedPassword ? ' [已保存密码]' : ''}`),
        recent: engine.hub.renderTail(Math.max(1, Math.min(recent, 50))),
      }
    },
  })

  const serialConnectTool = defineTool({
    name: 'console_serial_connect',
    description:
      '连接串口设备（无需密码）。port 可省略：只检测到唯一串口时自动选择。默认 115200 8N1。连接成功后用户在「设备控制台」面板会看到绿色的已连接标志。',
    parameters: {
      port: { type: 'string', description: '串口路径，如 COM3；省略则自动选择唯一串口。' },
      baudRate: { type: 'integer', description: '波特率，默认 115200。' },
      dataBits: { type: 'integer', description: '数据位，默认 8。' },
      stopBits: { type: 'integer', description: '停止位，默认 1。' },
      parity: { type: 'string', enum: ['none', 'even', 'odd'], description: '校验位，默认 none。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          label: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => text(value.message),
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      remember()
      const status = await engine.connectSerial({
        port: args.port,
        baudRate: args.baudRate,
        dataBits: args.dataBits,
        stopBits: args.stopBits,
        parity: args.parity,
      })
      return {
        ok: true,
        label: status.session?.label ?? '',
        message: `串口已连接：${status.session?.label ?? ''}。你现在可以用 console_exec 执行命令；每条命令请附带 note 说明它的作用。`,
      }
    },
  })

  const sshConnectTool = defineTool({
    name: 'console_ssh_connect',
    description:
      '让用户在「设备控制台」面板连接 SSH 主机。密码只能由用户输入：调用后终端面板会出现等待输入的连接请求，用户输入密码点击连接后本工具返回成功。只提供主机，不要索要或传递密码。等待上限默认 90 秒。',
    parameters: {
      alias: { type: 'string', description: '已配置主机别名（console_status 的 hosts 列表里有）。' },
      host: { type: 'string', description: '主机地址；用 alias 时可省略。' },
      port: { type: 'integer', description: 'SSH 端口，默认 22。' },
      username: { type: 'string', description: '用户名；用 alias 时可省略。' },
      waitMs: { type: 'integer', description: '等待用户输入密码的最长时间（毫秒），默认 90000。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          status: { type: 'string', required: true },
          label: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => text(value.message),
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      remember()
      const result = await engine.requestSshConnect({
        alias: args.alias,
        host: args.host,
        port: args.port,
        username: args.username,
        waitMs: args.waitMs,
        signal: exec?.signal,
      })
      if (result.status === 'connected') {
        return {
          ok: true,
          status: 'connected',
          label: result.session?.label ?? '',
          message: `SSH 已连接：${result.session?.label ?? ''}。现在可以用 console_exec 执行命令，每条命令请附带 note。`,
        }
      }
      return {
        ok: false,
        status: result.status,
        label: '',
        message: result.message ?? 'SSH 尚未连接。',
      }
    },
  })

  const execTool = defineTool({
    name: 'console_exec',
    description:
      '在已连接的串口或 SSH 设备上执行一条命令，并等待设备输出安静下来后返回输出。用户在「设备控制台」面板能实时看到这条命令和你写的 note 注释。必须传 note：用一句简短中文说明这条命令要做什么、为什么执行，用户靠它理解命令含义。执行完成后请调用 console_note，给这次输出写一句中文解读，让用户看懂输出含义。若「执行前确认」开启，本工具只把命令提交到面板待确认区（status=awaiting-confirmation），用户点「执行」后才会真正发送；此时不要重复提交，也不要调用 console_note。等待期间用户点「暂停」会中断本次执行，返回值 status 为 paused。',
    parameters: {
      command: { type: 'string', required: true, description: '要发送给设备的完整命令（不需要带换行）。' },
      note: { type: 'string', required: true, description: '命令的中文注释，显示在面板命令行旁边，例如「查看当前目录下文件」。' },
      waitMs: { type: 'integer', description: '最长等待毫秒数，默认 8000，最大 120000。' },
      idleMs: { type: 'integer', description: '输出安静多久算完成，默认 500 毫秒。' },
      lineEnding: { type: 'string', enum: ['crlf', 'lf', 'cr', 'none'], description: '行尾符：串口默认 crlf，SSH 默认 cr。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          status: { type: 'string', required: true },
          command: { type: 'string', required: true },
          note: { type: 'string', required: true },
          output: { type: 'string', required: true },
          durationMs: { type: 'number', required: true },
        },
      },
      render: (_args, value) => text(renderExec(value)),
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      remember()
      const result = await engine.exec({
        command: args.command,
        note: args.note,
        waitMs: args.waitMs,
        idleMs: args.idleMs,
        lineEnding: args.lineEnding,
        signal: exec?.signal,
      })
      return {
        ok: result.ok === true,
        status: typeof result.status === 'string' ? result.status : 'unknown',
        command: typeof result.command === 'string' ? result.command : String(args.command ?? ''),
        note: typeof result.note === 'string' ? result.note : String(args.note ?? ''),
        output: typeof result.output === 'string' ? result.output : '',
        durationMs: typeof result.durationMs === 'number' ? result.durationMs : 0,
      }
    },
  })

  const noteTool = defineTool({
    name: 'console_note',
    description:
      '给刚执行完的命令输出补一条中文解读，显示在「设备控制台」面板对应输出的下面，让用户看懂输出含义（关键结论、数值含义、异常提示）。每次 console_exec 之后都应调用一次：例如输出是 df -h，就写「根分区 63G，已用 21%，剩 48G」。本工具只做展示，不会向设备发送任何数据，也不影响命令执行。',
    parameters: {
      text: { type: 'string', required: true, description: '对输出的中文解读，一句话说清结论或含义。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          seq: { type: 'integer', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => text('已添加输出解读：' + value.text),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      remember()
      const note = engine.addNote(args.text)
      return { ok: true, seq: note.seq, text: note.text }
    },
  })

  const vendorTool = defineTool({
    name: 'console_vendor',
    description:
      '查看或设置当前连接的交换机厂商。不给 vendor 时返回当前厂商和可选项（huawei/h3c/cisco/ruijie/tplink/juniper/mikrotik）；给 vendor 时手动设定厂商（设为 auto 或空字符串则恢复自动识别）。设定厂商后，所有命令必须使用该厂商的语法，禁止混用其他厂商命令。',
    parameters: {
      vendor: { type: 'string', description: '厂商 id：huawei / h3c / cisco / ruijie / tplink / juniper / mikrotik；传 auto 或留空恢复自动识别。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          vendor: { type: 'string', required: true },
          vendorId: { type: 'string', required: true },
          vendorSource: { type: 'string', required: true },
          vendors: { type: 'array', items: { type: 'string' }, required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => text(value.message),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      remember()
      if (args.vendor !== undefined && String(args.vendor) !== '') {
        engine.setVendor(String(args.vendor))
      }
      const vendor = engine.vendorInfo()
      const options = engine.listVendorOptions().map(row => row.id + '=' + row.label).join(' / ')
      return {
        vendor: vendor.label,
        vendorId: vendor.id,
        vendorSource: vendor.source ?? '',
        vendors: engine.listVendorOptions().map(row => row.id),
        message:
          `当前厂商：${vendor.label}` +
          (vendor.source ? `（${vendor.source === 'auto' ? '自动识别' : '手动选择'}）` : '') +
          `\n可选：${options}`,
      }
    },
  })

  const sendTool = defineTool({
    name: 'console_send',
    description:
      '向设备发送原始输入（不自动追加回车），用于 Ctrl+C、方向键、单独回车、密码输入等交互场景。data 支持 C 风格转义：\\r、\\n、\\t、\\x03 等。面板会显示发送的原始数据和你写的 note。',
    parameters: {
      data: { type: 'string', required: true, description: '要发送的数据，支持 \\r \\n \\x03 等转义。' },
      note: { type: 'string', required: true, description: '这次发送的中文说明，例如「发送 Ctrl+C 中断当前程序」。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          status: { type: 'string', required: true },
          data: { type: 'string', required: true },
          note: { type: 'string', required: true },
        },
      },
      render: (_args, value) => text(`已发送：${value.data}\n注释：${value.note}`),
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      remember()
      const result = await engine.send({
        data: args.data,
        note: args.note,
        echo: false,
        escape: true,
      })
      return {
        ok: result.ok === true,
        status: typeof result.status === 'string' ? result.status : 'unknown',
        data: typeof result.data === 'string' ? result.data : '',
        note: typeof result.note === 'string' ? result.note : String(args.note ?? ''),
      }
    },
  })

  const readTool = defineTool({
    name: 'console_read',
    description:
      '读取设备控制台缓冲区中的终端记录（命令、注释、输出）。用于查看在 console_exec 之后陆续到达的输出，或回顾之前执行的命令。',
    parameters: {
      sinceSeq: { type: 'integer', description: '只返回序号大于它的条目；0 表示全部缓冲区。' },
      limit: { type: 'integer', description: '最多返回多少条，默认 200。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          connected: { type: 'boolean', required: true },
          label: { type: 'string', required: true },
          paused: { type: 'boolean', required: true },
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                seq: { type: 'integer', required: true },
                time: { type: 'number', required: true },
                kind: { type: 'string', required: true },
                text: { type: 'string', required: true },
                note: { type: 'string' },
              },
            },
          },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => text(value.text === '' ? '（缓冲区为空）' : value.text),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      remember()
      const result = engine.read({ sinceSeq: args.sinceSeq, limit: args.limit })
      return {
        connected: result.connected,
        label: result.session?.label ?? '',
        paused: result.paused,
        entries: result.entries.map(entry => {
          const row = { seq: entry.seq, time: entry.time, kind: entry.kind, text: entry.text }
          if (typeof entry.note === 'string' && entry.note !== '') row.note = entry.note
          return row
        }),
        text: result.text,
      }
    },
  })

  const disconnectTool = defineTool({
    name: 'console_disconnect',
    description: '断开当前的串口或 SSH 连接，并通知面板。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => text(value.message),
    },
    isConcurrencySafe: () => false,
    async execute() {
      remember()
      await engine.disconnect(false)
      return { ok: true, message: '已断开设备连接。' }
    },
  })

  return [statusTool, serialConnectTool, sshConnectTool, execTool, noteTool, sendTool, readTool, disconnectTool, vendorTool]
}
