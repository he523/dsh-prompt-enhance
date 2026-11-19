import { SYSTEM_PROMPT, buildUserPrompt, finalizeEnhanced } from './prompt.js'

const MAX_OUTPUT_CHARS = 64 * 1024
const ABORTED = Symbol('aborted')

const failure = (code, error) => ({ success: false, text: '', code, error })

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function resolveRoute(get, options, modelArg) {
  const spec = nonEmpty(modelArg)
  if (spec) {
    const slash = spec.indexOf('/')
    if (slash > 0 && slash < spec.length - 1) {
      const provider = spec.slice(0, slash).trim()
      const model = spec.slice(slash + 1).trim()
      if (provider && model) return { provider, model }
    }
  }
  if (options.provider && options.model) return { provider: options.provider, model: options.model }
  const selector = get?.('agentDefaultModel')
  const selected = selector?.currentSelection?.()
  if (selected && nonEmpty(selected.provider) && nonEmpty(selected.model)) {
    return { provider: selected.provider, model: selected.model }
  }
  return undefined
}

function abortedOnce(signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(ABORTED)
    signal?.addEventListener('abort', () => resolve(ABORTED), { once: true })
  })
}

async function releaseStream(stream) {
  try {
    if (typeof stream?.return === 'function') void Promise.resolve(stream.return()).catch(() => {})
  } catch {}
}

async function collectText(stream) {
  const parts = []
  let length = 0
  let failureMessage
  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      parts.push(chunk.text)
      length += chunk.text.length
      if (length > MAX_OUTPUT_CHARS) {
        failureMessage = `Enhanced result is too large (over ${MAX_OUTPUT_CHARS} characters)`
        parts.length = 0
        break
      }
      continue
    }
    if (chunk.type === 'finish') {
      const kind = chunk.reason?.kind
      if (kind === 'error') failureMessage = chunk.reason?.failure?.message || 'LLM completion failed'
      else if (kind === 'aborted') failureMessage = chunk.reason?.failure?.message || 'Request aborted'
    }
  }
  return { text: parts.join(''), failureMessage }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error ?? '')
}

export function createEnhancer({ get, provider, model, timeoutMs = 60_000 }) {
  const options = { provider, model, timeoutMs }
  return async function enhance(rawText, modelArg, signal) {
    const input = typeof rawText === 'string' ? rawText : ''
    if (input.trim() === '') return failure('empty_input', 'Empty input')
    const llm = get?.('llm')
    if (!llm || typeof llm.stream !== 'function') {
      return failure('llm_unavailable', 'LLM service is not available')
    }
    const route = resolveRoute(get, options, modelArg)
    if (!route) return failure('llm_unavailable', 'No model route is selected')
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
    const forwardAbort = () => controller.abort()
    signal?.addEventListener('abort', forwardAbort, { once: true })
    if (signal?.aborted) controller.abort()
    try {
      const stream = llm.stream({
        provider: route.provider,
        model: route.model,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: [{ type: 'text', text: buildUserPrompt(input) }] }],
        signal: controller.signal,
      })
      const collected = await Promise.race([collectText(stream), abortedOnce(controller.signal)])
      if (collected === ABORTED) {
        await releaseStream(stream)
        return timedOut
          ? failure('llm_error', `Request timed out after ${timeoutMs}ms`)
          : failure('llm_error', 'Request aborted')
      }
      if (collected.failureMessage) {
        return timedOut
          ? failure('llm_error', `Request timed out after ${timeoutMs}ms`)
          : failure('llm_error', collected.failureMessage)
      }
      const final = finalizeEnhanced(collected.text)
      return final.ok ? { success: true, text: final.text } : failure(final.code, final.error)
    } catch (error) {
      if (timedOut) return failure('llm_error', `Request timed out after ${timeoutMs}ms`)
      if (controller.signal.aborted) return failure('llm_error', 'Request aborted')
      return failure('unknown', messageOf(error) || 'prompt enhancement failed')
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', forwardAbort)
    }
  }
}
