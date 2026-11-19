import { createEnhancer } from './enhance.js'

export const name = '@local/dsh-prompt-enhance'
export const inject = ['tools']

const DEFAULT_TIMEOUT_MS = 60_000
const TOOL_TIMEOUT_MS = 90_000
const ROUTE_PATH = '/prompt-enhance'
const MAX_BODY_CHARS = 256 * 1024

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function readOptions(config) {
  const c = config && typeof config === 'object' ? config : {}
  const timeoutMs = Number(c.timeoutMs)
  return {
    provider: nonEmpty(c.provider),
    model: nonEmpty(c.model),
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error ?? '')
}

/** 同源信任检查：委派官方 connection.requestRejection，缺席/抛错一律 fail-closed 403。 */
function rejectRequest(ctx, req) {
  try {
    const connection = ctx.get?.('connection')
    const reject = connection?.requestRejection
    if (typeof reject !== 'function') return 403
    const value = reject.call(connection, { headers: req.headers })
    // undefined / null 是「放行」信号；合法的 HTTP 状态码表示拒绝。
    // 其余取值（0、false、NaN、非整数、对象…）统一 fail-closed，避免传入 writeHead。
    if (value === undefined || value === null) return undefined
    if (Number.isInteger(value) && value >= 100 && value < 600) return value
    return 403
  } catch {
    return 403
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      value()
    }
    req.on('data', (chunk) => {
      if (settled) return
      bytes += chunk.length
      if (bytes > MAX_BODY_CHARS) {
        finish(() => {
          reject(new Error('request body too large'))
          req.destroy()
        })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => finish(() => resolve(Buffer.concat(chunks).toString('utf8'))))
    req.on('error', (error) => finish(() => reject(error)))
  })
}

function sendJson(res, status, value) {
  if (res.writableEnded || res.destroyed) return
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function createRouteHandler(ctx, enhance) {
  return (req, res) => {
    ;(async () => {
      const rejection = rejectRequest(ctx, req)
      if (rejection !== undefined) {
        sendJson(res, rejection, { success: false, code: 'forbidden', error: 'request rejected' })
        return
      }
      if (req.method !== 'POST') {
        if (!res.writableEnded && !res.destroyed) {
          res.writeHead(405, { allow: 'POST' })
          res.end()
        }
        return
      }
      let payload
      try {
        const raw = await readBody(req)
        payload = raw === '' ? {} : JSON.parse(raw)
      } catch (error) {
        sendJson(res, 400, { success: false, code: 'bad_request', error: messageOf(error) })
        return
      }
      const text = payload && typeof payload.text === 'string' ? payload.text : ''
      const model = payload && typeof payload.model === 'string' ? payload.model : undefined
      // 浏览器断开时取消补全，避免为无人等待的响应继续消耗额度。
      const disconnect = new AbortController()
      const onClose = () => disconnect.abort()
      res.once?.('close', onClose)
      let envelope
      try {
        envelope = await enhance(text, model, disconnect.signal)
      } finally {
        res.off?.('close', onClose)
      }
      if (disconnect.signal.aborted) return
      sendJson(res, 200, envelope)
    })().catch((error) => {
      if (!res.headersSent) {
        sendJson(res, 500, { success: false, code: 'unknown', error: messageOf(error) })
      } else if (!res.writableEnded && !res.destroyed) {
        res.destroy()
      }
    })
  }
}

export function apply(ctx, config) {
  const enhance = createEnhancer({ get: (name) => ctx.get?.(name), ...readOptions(config) })

  ctx.tools.register({
    name: 'enhance_prompt',
    description:
      '把一段原始提示词改写为更清晰、更具体的提示词，并原样返回改写结果：保持输入语言，只产出提示词本身，不回答提示词里的请求。当用户要求增强/优化/润色提示词，或想把一句模糊需求整理成可直接发给模型的提示词时调用。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '需要被增强的原始提示词' },
        model: {
          type: 'string',
          description: '可选的模型路由，格式为 provider/model；缺省时使用当前会话模型',
        },
      },
      required: ['text'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          text: { type: 'string' },
          code: {
            type: 'string',
            enum: ['empty_input', 'llm_unavailable', 'llm_error', 'unknown'],
          },
          error: { type: 'string' },
        },
        required: ['success', 'text'],
      },
      render: (_args, value) => {
        if (value && value.success) return [{ type: 'text', text: value.text }]
        const code = value && value.code ? value.code : 'unknown'
        const detail = value && value.error ? value.error : 'unknown error'
        return [{ type: 'text', text: `[${code}] ${detail}` }]
      },
    },
    presentationMeta: (value) => {
      const success = Boolean(value && value.success)
      const meta = { success, chars: value && typeof value.text === 'string' ? value.text.length : 0 }
      if (!success && value && value.code) meta.code = value.code
      return meta
    },
    presentCall: () => ({ card: 'generic', title: '增强提示词', kind: 'other', content: [] }),
    presentResult: (value) => {
      const isError = !value || !value.success
      return {
        card: 'generic',
        title: isError ? '增强失败' : '提示词已增强',
        kind: 'other',
        content: [],
      }
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    async execute(args, exec) {
      const input = args && typeof args === 'object' ? args : {}
      return enhance(input.text, input.model, exec?.signal)
    },
  })

  ctx.inject(['webServer'], (c) => {
    const server = c.webServer
    if (!server || typeof server.register !== 'function') return
    server.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: createRouteHandler(ctx, enhance),
    })
  })
}
