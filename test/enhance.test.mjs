import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEnhancer } from '../enhance.js'

test('an oversized result closes the provider stream instead of abandoning it', async () => {
  let closed = false
  const enhance = createEnhancer({
    get(name) {
      if (name === 'llm') return {
        stream() {
          return {
            [Symbol.asyncIterator]() { return this },
            async next() { return { value: { type: 'text-delta', text: 'x'.repeat(65 * 1024) } } },
            async return() { closed = true; return { done: true } },
          }
        },
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
    },
  })
  const result = await enhance('做个上传')
  assert.equal(result.success, false)
  assert.equal(result.code, 'llm_error')
  assert.match(result.error, /too large/i)
  assert.equal(closed, true)
})

test('a provider that ignores abort cannot hold enhancement past the timeout', async () => {
  let requestSignal
  const enhance = createEnhancer({
    timeoutMs: 30,
    get(name) {
      if (name === 'llm') return {
        stream(request) {
          requestSignal = request.signal
          return (async function* () { await new Promise(() => {}) })()
        },
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
    },
  })
  const result = await enhance('做个上传')
  assert.equal(result.success, false)
  assert.equal(result.code, 'llm_error')
  assert.match(result.error, /timed out/i)
  assert.equal(requestSignal.aborted, true)
})

test('configured provider and model take precedence over the current default', async () => {
  let request
  const enhance = createEnhancer({
    provider: 'configured-provider',
    model: 'configured-model',
    get(name) {
      if (name === 'llm') return {
        stream(value) {
          request = value
          return (async function* () { yield { type: 'text-delta', text: 'ok' } })()
        },
      }
      if (name === 'agentDefaultModel') throw new Error('configured route must short-circuit default selection')
    },
  })
  assert.deepEqual(await enhance('做个上传'), { success: true, text: 'ok' })
  assert.equal(request.provider, 'configured-provider')
  assert.equal(request.model, 'configured-model')
})

test('an explicit provider route preserves slash-containing model ids', async () => {
  const calls = []
  const enhance = createEnhancer({
    provider: 'configured-provider',
    model: 'configured-model',
    get(name) {
      if (name === 'llm') return {
        stream(request) {
          calls.push(request)
          return (async function* () {
            yield { type: 'text-delta', text: '"增强后的提示词"' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        },
      }
      throw new Error('route selection must not use the default model')
    },
  })
  const result = await enhance('做个上传', 'openrouter/meta-llama/llama-3-70b')
  assert.deepEqual(result, { success: true, text: '增强后的提示词' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].provider, 'openrouter')
  assert.equal(calls[0].model, 'meta-llama/llama-3-70b')
  assert.equal(calls[0].messages.length, 1)
  assert.equal(calls[0].messages[0].role, 'user')
  assert.match(calls[0].messages[0].content[0].text, /做个上传/)
})

test('a provider finish error keeps the llm_error envelope', async () => {
  const enhance = createEnhancer({
    get(name) {
      if (name === 'llm') return {
        stream() {
          return (async function* () {
            yield { type: 'text-delta', text: 'partial output must not leak' }
            yield { type: 'finish', reason: { kind: 'error', failure: { message: 'provider failed' } } }
          })()
        },
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
    },
  })
  assert.deepEqual(await enhance('做个上传'), {
    success: false,
    text: '',
    code: 'llm_error',
    error: 'provider failed',
  })
})

test('an unavailable LLM fails closed before route selection', async () => {
  const enhance = createEnhancer({ get: () => undefined })
  assert.deepEqual(await enhance('做个上传'), {
    success: false,
    text: '',
    code: 'llm_unavailable',
    error: 'LLM service is not available',
  })
})

test('empty input fails without resolving services or starting a completion', async () => {
  const enhance = createEnhancer({
    get() { throw new Error('services must not be resolved') },
  })
  const result = await enhance('  \n  ')
  assert.deepEqual(result, { success: false, text: '', code: 'empty_input', error: 'Empty input' })
})
