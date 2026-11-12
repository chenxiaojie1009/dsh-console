/**
 * dsh-console host half.
 *
 * Mounts the serial/SSH console engine, the /api/device-console route family
 * used by the browser panel, the console_* agent tools, and a system-prompt
 * section that teaches the model the workflow. The browser half (./client)
 * renders the 设备控制台 panel, its sidebar entry and the live transcript.
 */
import { ConsoleHub } from './host/hub.js'
import { ConsoleEngine } from './host/engine.js'
import { makeRoutes } from './host/routes.js'
import { makeTools } from './host/tools.js'

/** Stable cordis plugin name. */
export const name = 'dsh-console'

/** Services required before the console surfaces can mount. */
export const inject = ['webServer', 'tools', 'systemPrompt']

/** Tool names the guidance section describes. */
const CONSOLE_TOOL_NAMES = [
  'console_status',
  'console_serial_connect',
  'console_ssh_connect',
  'console_exec',
  'console_note',
  'console_send',
  'console_read',
  'console_disconnect',
]

/** Model-facing announcement: the console plugin, its tools and its rules. */
export const CONSOLE_GUIDANCE = `本机已安装「设备控制台」插件（DSH 串口/SSH 调试台）：侧边栏底部有「设备控制台」入口。面板左侧是「需求 / 待确认命令」（需求由插件内模型直接生成命令，不经过聊天），右侧是实时终端，显示命令、中文注释、设备输出和输出解读；用户可随时点「暂停」中断你当前的设备操作。

工具：
- console_status：查看当前连接（串口/SSH）、是否被暂停、可用串口、已配置 SSH 主机、最近输出。
- console_serial_connect：连接串口设备（不需要密码，port/波特率可省略）。
- console_ssh_connect：请求用户在面板输入密码连接 SSH。密码只能由用户在面板输入，你绝不能索要、猜测或在聊天里传递密码。
- console_exec：在已连接设备上提交并执行一条命令。必须传 note（简短中文注释，说明这条命令做什么），它会显示在面板命令行旁边。
- console_note：给刚执行完的命令输出补一条中文解读，显示在面板对应输出的下面（只展示，不向设备发送数据）。
- console_send：发送原始输入（Ctrl+C、方向键、单独回车等），支持 \\r \\n \\x03 转义。
- console_read：读取终端缓冲区（命令、注释、输出、输出解读）。
- console_disconnect：断开连接。

工作规则：
1. 用户提出串口或 SSH 调试需求时先调用 console_status。未连接时：串口用 console_serial_connect 直接连接；SSH 用 console_ssh_connect 请求用户在面板输入密码（等待上限默认 90 秒），不要试图自己获取密码。
2. 每次 console_exec 都必须写 note，一句话中文说明目的（例如「查看网卡配置」「读取设备版本号」）；不要写空注释或不相关的注释。
3. 「执行前确认」默认开启：console_exec 会返回 status=awaiting-confirmation，表示命令已进入面板待确认区、还没有发到设备。此时不要重复提交同一条命令，也不要调用 console_note，可以在聊天里告诉用户「命令已给出，请在面板点执行」。
4. 用户点「执行」后，插件会自动生成输出解读；如果用户还在对话里要求你继续分析，用 console_read 读记录后再回答。
5. 面板左侧的需求由插件内模型直接处理，不经过聊天；只有用户直接在聊天或工具调用里找你时，你才参与设备操作。
6. 命令要小而可验证：先给一条、等确认执行和解读，再决定下一步；不要把多条命令用 && 堆在一起，除非用户明确要求。
7. 若 console_exec 返回 status 为 paused，说明用户按了暂停：立即停止，不要重试、不要继续下一条命令，等待用户新的指令；用户恢复后按新需求继续。
8. 设备输出可能为空或超时，如实说明，绝不编造输出或猜测设备状态。
9. 本机（DSH 所在电脑）上的文件和命令仍用本地工具（read/write/pwsh 等）；设备控制台只用于串口设备或 SSH 目标机。
10. 面板里也可能出现用户手动输入的命令，不要重复执行或擅自续做。
11. console_ssh_connect 超时或失败时，提醒用户打开左侧「设备控制台」面板，选择主机并输入密码后点「连接」。`

/**
 * Mount the console engine, routes, tools and guidance.
 * @param {object} ctx host plugin context.
 */
export function apply(ctx) {
  const hub = new ConsoleHub()
  const engine = new ConsoleEngine({ hub })
  /**
   * Session-controller calls require an AbortSignal; this one is owned by the
   * plugin lifetime and cancelled when the plugin unloads.
   */
  const lifecycle = new AbortController()

  /**
   * The agent that initiated the current console operation, used to record
   * which session the pause button should cancel.
   * @returns {object|undefined} initiating agent.
   */
  const getInitiator = () => {
    try {
      const agents = ctx.get('agents')
      return agents?.currentInitiator?.()
    } catch {
      return undefined
    }
  }

  engine.cancelAgentTurn = sessionId => {
    try {
      const sessionController = ctx.get('sessionController')
      if (sessionController && typeof sessionController.cancel === 'function') {
        sessionController.cancel({ sessionId })
      }
    } catch (error) {
      console.warn('[dsh-console] 取消当前会话失败：', error)
    }
  }

  /**
   * Resolve the model route used by the panel's requirement and explanation
   * features: the profile's default selection, else the first routable model.
   * @param {object} llm llm service.
   * @returns {Promise<{provider:string,model:string}>} a concrete route.
   */
  const resolveModelSelection = async llm => {
    try {
      const defaultModel = ctx.get('agentDefaultModel')
      const current = defaultModel?.currentSelection?.()
      if (current && typeof current.provider === 'string' && typeof current.model === 'string') {
        return { provider: current.provider, model: current.model }
      }
    } catch {
      // Fall through to provider discovery.
    }
    const providers = typeof llm.listProviders === 'function' ? llm.listProviders() : []
    for (const provider of providers) {
      const models = await llm.listModels(provider.id)
      if (Array.isArray(models) && models.length > 0) return { provider: provider.id, model: models[0].id }
    }
    throw new Error('没有可用的模型：请在 DSH 的「设置 → 模型」里登录/选择一个模型后重试。')
  }

  /**
   * One model completion for the panel, so requirement → commands → output
   * explanation happens inside the plugin without involving a chat session.
   * @param {string} system system prompt.
   * @param {string} user user text.
   * @returns {Promise<string>} completion text.
   */
  engine.complete = async (system, user) => {
    const llm = ctx.get('llm')
    if (llm === undefined || typeof llm.stream !== 'function') {
      throw new Error('模型服务不可用：请在 DSH 里配置一个模型。')
    }
    const selection = await resolveModelSelection(llm)
    let text = ''
    const stream = llm.stream({
      provider: selection.provider,
      model: selection.model,
      system,
      temperature: 0.2,
      maxTokens: 900,
      messages: [{ role: 'user', content: [{ type: 'text', text: String(user ?? '') }] }],
      signal: lifecycle.signal,
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
        throw new Error(chunk.reason.failure?.message || '模型调用失败')
      }
    }
    return text
  }

  ctx.effect(() => () => {
    lifecycle.abort()
    void engine.dispose()
  }, 'dsh-console: engine')

  ctx.effect(
    () => {
      const disposers = makeRoutes({ engine }).map(route => ctx.webServer.register(route))
      return () => {
        for (const dispose of disposers) dispose()
      }
    },
    'dsh-console: routes',
  )

  ctx.effect(
    () => {
      const disposers = makeTools(engine, { getInitiator }).map(tool => ctx.tools.register(tool))
      return () => {
        for (const dispose of disposers) dispose()
      }
    },
    'dsh-console: tools',
  )

  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: 'plugin:dsh-console',
        order: 155,
        // The guidance names the console_* tools, so it renders only while at
        // least one of them is visible to the rendering scope: a restriction
        // that removes them must take the guidance with it.
        text: context => {
          const tools = ctx.tools
          for (const toolName of CONSOLE_TOOL_NAMES) {
            try {
              if (tools.get(toolName, context?.scope) !== undefined) return CONSOLE_GUIDANCE
            } catch {
              return CONSOLE_GUIDANCE
            }
          }
          return ''
        },
      }),
    'dsh-console: prompt',
  )
}
