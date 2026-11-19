import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import * as host from '../index.js'

function makeContext(options = {}) {
  const { stream, config } = options
  const tools = []
  const routes = []
  const calls = []
  const connection = Object.hasOwn(options, 'rejection') ? options.rejection : { requestRejection: () => undefined }
  const ctx = {
    tools: { register(tool) { tools.push(tool) } },
    get(name) {
      if (name === 'connection') return connection
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) }
      if (name === 'llm') return { stream(request) { calls.push(request); return stream() } }
      return undefined
    },
    inject(names, callback) {
      assert.deepEqual(names, ['webServer'])
      callback({ webServer: { register(route) { routes.push(route) } } })
    },
  }
  host.apply(ctx, config ?? {})
  return { tools, routes, calls }
}

async function post(route, payload, headers = {}) {
  const req = new EventEmitter()
  req.method = 'POST'
  req.headers = headers
  const body = Buffer.from(JSON.stringify(payload))
  return await new Promise((resolve, reject) => {
    const res = {
      writableEnded: false,
      destroyed: false,
      headersSent: false,
      writeHead(status, responseHeaders) { this.status = status; this.headersSent = true; this.responseHeaders = responseHeaders },
      end(text) { this.writableEnded = true; resolve({ status: this.status, body: JSON.parse(text) }) },
      destroy() { this.destroyed = true; reject(new Error('response destroyed')) },
    }
    route.handler(req, res)
    process.nextTick(() => { req.emit('data', body); req.emit('end') })
  })
}

/** 一个永远不产出、也无视 abort 的提供方流：模拟挂死的 provider。 */
function hungStream() {
  return (async function* () {
    await new Promise(() => {})
  })()
}

/** 用给定的 res 替身发起一次请求，返回「路由何时作答」的 Promise。 */
function postWith(route, payload, res, afterBody) {
  const req = new EventEmitter()
  req.method = 'POST'
  req.headers = { host: '127.0.0.1:52976' }
  const writableEnded = res.writableEnded ?? false
  const destroyed = res.destroyed ?? false
  const answered = new Promise((resolve) => {
    res.writeHead = function (status, headers) {
      this.status = status
      this.headersSent = true
      this.responseHeaders = headers
    }
    res.end = function (text) {
      this.writableEnded = true
      if (!writableEnded) resolve({ status: this.status, body: JSON.parse(text) })
    }
    res.destroy = function () {
      this.destroyed = true
      if (!destroyed) resolve(undefined)
    }
  })
  route.handler(req, res)
  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify(payload)))
    req.emit('end')
    afterBody?.()
  })
  return answered
}

const NOT_YET = Symbol('no answer')
function within(promise, ms = 2000) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(NOT_YET), ms))])
}

test('a provider that ignores the abort signal cannot hold the route past the timeout', async () => {
  const f = makeContext({ config: { timeoutMs: 40 }, stream: hungStream })
  const outcome = await within(post(f.routes[0], { text: '做个上传' }))
  assert.notEqual(outcome, NOT_YET, 'the route must answer even when the model stream never settles')
  assert.equal(outcome.status, 200)
  assert.equal(outcome.body.success, false)
  assert.equal(outcome.body.code, 'llm_error')
  assert.match(outcome.body.error, /timed out/i)
})

test('a browser that walks away cancels the model call instead of leaking it', async () => {
  const f = makeContext({ config: { timeoutMs: 60_000 }, stream: hungStream })
  const res = new EventEmitter()
  res.writeHead = function (status) { this.status = status; this.headersSent = true }
  res.end = function () { this.ended = true }
  res.destroy = function () {}
  postWith(f.routes[0], { text: '做个上传' }, res, () => setTimeout(() => res.emit('close'), 10))
  // 断开后模型请求必须被取消，否则会为一个没人等待的响应继续消耗额度。
  const deadline = Date.now() + 2000
  while (!f.calls[0]?.signal.aborted && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  assert.equal(f.calls[0].signal.aborted, true, 'the model call must be aborted when the client disconnects')
  assert.equal(res.ended, undefined, 'a disconnected client must not receive a response body')
})

test('a provider that streams without end cannot produce an unbounded result', async () => {
  const f = makeContext({
    config: { timeoutMs: 60_000 },
    stream: async function* () {
      for (;;) yield { type: 'text-delta', text: 'x'.repeat(4096) }
    },
  })
  const outcome = await within(post(f.routes[0], { text: '做个上传' }), 4000)
  assert.notEqual(outcome, NOT_YET, 'an endless stream must not run until the timeout')
  assert.equal(outcome.status, 200)
  assert.equal(outcome.body.success, false)
  assert.equal(outcome.body.code, 'llm_error')
  assert.match(outcome.body.error, /too large/i)
})

test('local package and historical loader identities stay aligned', async () => {
  const pkg = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const patch = await (await import('node:fs/promises')).readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const client = await (await import('node:fs/promises')).readFile(new URL('../client.js', import.meta.url), 'utf8')
  assert.equal(host.name, '@local/dsh-prompt-enhance')
  assert.equal(pkg.name, '@local/dsh-prompt-enhance')
  assert.match(patch, /id: prompt-enhance/)
  assert.ok(patch.includes("name: '@local/dsh-prompt-enhance'"))
  assert.ok(client.includes("id: '@local/dsh-prompt-enhance'"))
})

test('enhance_prompt and the composer route perform a real stubbed enhancement', async () => {
  const seen = []
  const f = makeContext({ stream: async function* () {
    yield { type: 'text-delta', text: '“请实现带错误处理的文件上传。”' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } })
  assert.equal(f.tools.length, 1)
  assert.equal(f.tools[0].name, 'enhance_prompt')
  assert.equal(f.routes.length, 1)
  assert.equal(f.routes[0].path, '/prompt-enhance')
  const result = await post(f.routes[0], { text: '做个上传' }, { host: '127.0.0.1:52976' })
  assert.deepEqual(result, { status: 200, body: { success: true, text: '请实现带错误处理的文件上传。' } })
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].provider, 'test-provider')
  assert.equal(f.calls[0].model, 'test-model')
  assert.equal(f.calls[0].messages[0].role, 'user')
  assert.ok(f.calls[0].messages[0].content[0].text.includes('做个上传'))
  const toolResult = await f.tools[0].execute({ text: '' }, {})
  assert.equal(toolResult.code, 'empty_input')
  assert.equal(f.calls.length, 1, 'empty tool input must not consume an LLM request')
  void seen
})

test('the composer route fails closed before reading input or calling the model', async () => {
  for (const rejection of [undefined, { requestRejection: () => { throw new Error('bad gate') } }, { requestRejection: () => 403 }, { requestRejection: () => 0 }, { requestRejection: () => false }, { requestRejection: () => Number.NaN }]) {
    const f = makeContext({ rejection, stream: async function* () { throw new Error('must not be called') } })
    const result = await post(f.routes[0], { text: 'must not leave the trust boundary' })
    assert.equal(result.status, 403)
    assert.equal(result.body.code, 'forbidden')
    assert.equal(f.calls.length, 0)
  }
})

test('a non-integer rejection status fails closed instead of reaching HTTP response handling', async () => {
  const f = makeContext({
    rejection: { requestRejection: () => 200.5 },
    stream: async function* () { throw new Error('must not be called') },
  })
  const result = await post(f.routes[0], { text: 'must not leave the trust boundary' })
  assert.equal(result.status, 403)
  assert.equal(result.body.code, 'forbidden')
  assert.equal(f.calls.length, 0)
})

test('a model id that contains slashes keeps every segment', async () => {
  const f = makeContext({
    stream: async function* () {
      yield { type: 'text-delta', text: 'ok' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  await f.tools[0].execute({ text: '做个上传', model: 'openrouter/meta-llama/llama-3-70b' }, {})
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].provider, 'openrouter')
  assert.equal(f.calls[0].model, 'meta-llama/llama-3-70b', 'only the first slash separates provider from model')
})

test('configured provider and model win over the current default model', async () => {
  const f = makeContext({
    config: { provider: 'pinned-provider', model: 'pinned-model' },
    stream: async function* () {
      yield { type: 'text-delta', text: 'ok' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  await f.tools[0].execute({ text: '做个上传' }, {})
  assert.equal(f.calls[0].provider, 'pinned-provider')
  assert.equal(f.calls[0].model, 'pinned-model')
})

test('a signal that is already aborted never reaches the model', async () => {
  const f = makeContext({
    stream: async function* () {
      yield { type: 'text-delta', text: 'must not be seen' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })
  const controller = new AbortController()
  controller.abort()
  const result = await f.tools[0].execute({ text: '做个上传' }, { signal: controller.signal })
  assert.equal(result.success, false)
  assert.equal(result.code, 'llm_error')
  assert.match(result.error, /aborted/i)
})

test('a host without an llm service degrades to llm_unavailable', async () => {
  const tools = []
  const ctx = {
    tools: { register(tool) { tools.push(tool) } },
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      return undefined
    },
    inject() {},
  }
  host.apply(ctx, {})
  const result = await tools[0].execute({ text: '做个上传' }, {})
  assert.deepEqual(result, { success: false, text: '', code: 'llm_unavailable', error: 'LLM service is not available' })
})
