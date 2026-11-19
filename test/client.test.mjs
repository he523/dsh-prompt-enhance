/**
 * Client-half behaviour tests for dsh-prompt-enhance.
 *
 * The two things a user can actually lose are covered here: a draft typed in
 * one session, and a draft typed while a request is in flight. Both are
 * observable through the component's public surface — the button's
 * `data-prompt-enhance` phase and the draft it writes back — so the tests drive
 * render, click and response and assert on those, never on internals.
 *
 * Run with `npm test` (node --test, no dependencies).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const CLIENT_SRC = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** Let queued microtasks and the scheduled re-render run. */
async function settle() {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

/** Structural comparison for hook dependency arrays. */
function sameDeps(a, b) {
  if (!a || !b || a.length !== b.length) return false
  return a.every((value, index) => Object.is(value, b[index]))
}

/**
 * A minimal hooks runtime: enough of React to mount one component, re-render it
 * with new props, run and clean up effects, and flush the state updates that
 * effects and promise callbacks schedule.
 */
function createRuntime() {
  const stateSlots = []
  const refSlots = []
  const memoSlots = []
  const effectSlots = []
  let cursor = 0
  let pendingEffects = []
  let scheduled = false
  let flushing = false
  let dirty = false
  let props = {}
  let Component
  let tree

  function schedule() {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (!flushing) flush()
    })
  }

  const React = {
    createElement: (type, elementProps, ...children) => ({ type, props: elementProps ?? {}, children }),
    useState(initial) {
      const index = cursor++
      if (!(index in stateSlots)) stateSlots[index] = { value: typeof initial === 'function' ? initial() : initial }
      return [stateSlots[index].value, (next) => {
        const value = typeof next === 'function' ? next(stateSlots[index].value) : next
        if (Object.is(value, stateSlots[index].value)) return
        stateSlots[index].value = value
        dirty = true
        schedule()
      }]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in refSlots)) refSlots[index] = { current: initial }
      return refSlots[index]
    },
    useMemo(factory, deps) {
      const index = cursor++
      const previous = memoSlots[index]
      if (previous && sameDeps(previous.deps, deps)) return previous.value
      const value = factory()
      memoSlots[index] = { value, deps }
      return value
    },
    useCallback(fn, deps) {
      return React.useMemo(() => fn, deps)
    },
    useEffect(fn, deps) {
      pendingEffects.push({ index: cursor++, fn, deps })
    },
  }

  function commit(effects) {
    for (const effect of effects) {
      const previous = effectSlots[effect.index]
      if (previous && sameDeps(previous.deps, effect.deps)) continue
      if (previous && typeof previous.cleanup === 'function') previous.cleanup()
      const cleanup = effect.fn()
      effectSlots[effect.index] = { deps: effect.deps, cleanup }
    }
  }

  function flush() {
    if (flushing) return
    flushing = true
    let guard = 0
    do {
      dirty = false
      cursor = 0
      pendingEffects = []
      tree = Component(props)
      commit(pendingEffects)
    } while (dirty && (guard += 1) < 25)
    flushing = false
  }

  return {
    React,
    mount(component, initialProps) {
      Component = component
      props = initialProps
      flush()
      return tree
    },
    update(nextProps) {
      props = { ...props, ...nextProps }
      dirty = true
      flush()
    },
    current: () => tree,
    flush,
    unmount() {
      for (const effect of effectSlots) {
        if (effect && typeof effect.cleanup === 'function') effect.cleanup()
      }
    },
  }
}

/**
 * Load client.js against stubs and return the registered button.
 * @returns the runtime, the captured fetch calls and a setter for the draft.
 */
function loadButton() {
  let captured
  const fetchCalls = []
  const responders = []
  const sandbox = {
    console,
    AbortController,
    fetch: (url, options) => {
      fetchCalls.push({ url, options })
      return new Promise((resolve, reject) => { responders.push({ resolve, reject }) })
    },
    window: { __ModuleLoader__: { load: (config) => { captured = config } } },
  }
  vm.runInNewContext(CLIENT_SRC, sandbox, { filename: 'client.js' })
  assert.ok(captured, 'client.js must call window.__ModuleLoader__.load')

  const runtime = createRuntime()
  const exports = captured.factory((name) => {
    if (name === 'react') return runtime.React
    throw new Error(`unexpected require: ${name}`)
  })
  let Button
  const ctx = {
    get: () => undefined,
    slots: {
      inject: (slot, fn) => { fn(); return () => {} },
      register: (config, component) => { Button = component; return () => {} },
    },
  }
  exports.apply(ctx)
  assert.equal(typeof Button, 'function', 'the slot component is registered')
  return { runtime, Button, fetchCalls, respond: (value, index = responders.length - 1) => responders[index].resolve(value) }
}

const okResponse = (text) => ({ ok: true, status: 200, json: async () => ({ success: true, text }) })

test('a response from the previous session never lands in the new session draft', async () => {
  const { runtime, Button, respond } = loadButton()
  let draft = 'old session prompt'
  const useInput = (select) => select({ draft })
  const inputActions = { setDraft: (value) => { draft = value } }

  runtime.mount(Button, { sessionId: 'A', useInput, inputActions })
  runtime.current().props.onClick()
  await settle()
  assert.equal(runtime.current().props['data-prompt-enhance'], 'running')

  draft = 'new session draft'
  runtime.update({ sessionId: 'B', useInput, inputActions })
  await settle()
  assert.equal(runtime.current().props['data-prompt-enhance'], 'idle',
    'switching sessions returns the button to idle')

  respond(okResponse('ENHANCED OLD'))
  await settle()

  assert.equal(draft, 'new session draft', 'the new session draft is not overwritten')
  assert.equal(runtime.current().props['data-prompt-enhance'], 'idle',
    'a late response must not report success for the new session')
})

test('a successful response never replaces text the user typed while waiting', async () => {
  const { runtime, Button, respond } = loadButton()
  let draft = 'original prompt'
  const useInput = (select) => select({ draft })
  const inputActions = { setDraft: (value) => { draft = value } }

  runtime.mount(Button, { sessionId: 'A', useInput, inputActions })
  runtime.current().props.onClick()
  await settle()

  draft = 'edited while waiting'
  runtime.update({ useInput, inputActions })
  await settle()

  respond(okResponse('ENHANCED'))
  await settle()

  assert.equal(draft, 'edited while waiting', 'typing during the request wins')
  assert.notEqual(runtime.current().props['data-prompt-enhance'], 'done',
    'the button must not claim the result replaced the draft')
})

test('editing while waiting invalidates the result even if the draft is later restored', async () => {
  const { runtime, Button, respond } = loadButton()
  let draft = 'original prompt'
  const useInput = (select) => select({ draft })
  const inputActions = { setDraft: (value) => { draft = value } }

  runtime.mount(Button, { sessionId: 'A', useInput, inputActions })
  runtime.current().props.onClick()
  await settle()

  draft = 'temporary user edit'
  runtime.update({ useInput, inputActions })
  draft = 'original prompt'
  runtime.update({ useInput, inputActions })
  await settle()

  respond(okResponse('STALE ENHANCEMENT'))
  await settle()

  assert.equal(draft, 'original prompt', 'the user-controlled draft stays untouched')
  assert.equal(runtime.current().props['data-prompt-enhance'], 'idle',
    'the stale result must not become a restore state')
})

test('a successful response without text preserves the draft and can be retried', async () => {
  const { runtime, Button, fetchCalls, respond } = loadButton()
  let draft = 'keep this prompt'
  const useInput = (select) => select({ draft })
  const inputActions = { setDraft: (value) => { draft = value } }

  runtime.mount(Button, { sessionId: 'A', useInput, inputActions })
  runtime.current().props.onClick()
  await settle()
  respond({ ok: true, status: 200, json: async () => ({ success: true }) })
  await settle()

  assert.equal(draft, 'keep this prompt')
  assert.equal(runtime.current().props['data-prompt-enhance'], 'error')
  runtime.current().props.onClick()
  await settle()
  assert.equal(fetchCalls.length, 2, 'a malformed result leaves a retryable failure')
})

test('an empty successful result is retryable instead of becoming a false restore state', async () => {
  const { runtime, Button, respond } = loadButton()
  let draft = 'make this prompt better'
  const useInput = (select) => select({ draft })
  const inputActions = { setDraft: (value) => { draft = value } }

  runtime.mount(Button, { sessionId: 'A', useInput, inputActions })
  runtime.current().props.onClick()
  await settle()
  respond(okResponse(''))
  await settle()

  assert.equal(draft, 'make this prompt better', 'an empty result must not erase the draft')
  assert.equal(runtime.current().props['data-prompt-enhance'], 'error', 'an empty result is a failure')

  runtime.current().props.onClick()
  await settle()
  assert.equal(runtime.current().props['data-prompt-enhance'], 'running', 'the next click retries')
})

test('a failed request can be retried and its stale response cannot replace the retry', async () => {
  const { runtime, Button, fetchCalls, respond } = loadButton()
  let draft = 'retry this prompt'
  const useInput = (select) => select({ draft })
  const inputActions = { setDraft: (value) => { draft = value } }

  runtime.mount(Button, { sessionId: 'A', useInput, inputActions })
  runtime.current().props.onClick()
  await settle()
  respond({ ok: false, status: 503, json: async () => ({ error: 'temporary failure' }) })
  await settle()
  assert.equal(runtime.current().props['data-prompt-enhance'], 'error')

  runtime.current().props.onClick()
  await settle()
  assert.equal(fetchCalls.length, 2, 'clicking the failure state starts a new request')
  respond(okResponse('RETRY SUCCEEDED'), 1)
  await settle()
  assert.equal(draft, 'RETRY SUCCEEDED')
  assert.equal(runtime.current().props['data-prompt-enhance'], 'done')

  respond(okResponse('STALE FAILURE RESPONSE'), 0)
  await settle()
  assert.equal(draft, 'RETRY SUCCEEDED', 'the failed request cannot overwrite its replacement')
})

test('the happy path still replaces the draft and offers a restore', async () => {
  const { runtime, Button, fetchCalls, respond } = loadButton()
  let draft = 'make it better'
  const useInput = (select) => select({ draft })
  const inputActions = { setDraft: (value) => { draft = value } }

  runtime.mount(Button, { sessionId: 'A', useInput, inputActions })
  runtime.current().props.onClick()
  await settle()

  assert.equal(fetchCalls.length, 1)
  assert.equal(fetchCalls[0].url, '/prompt-enhance')
  assert.equal(fetchCalls[0].options.method, 'POST')

  respond(okResponse('A clearer prompt'))
  await settle()

  assert.equal(draft, 'A clearer prompt', 'the enhanced text replaces the draft')
  assert.equal(runtime.current().props['data-prompt-enhance'], 'done')
  assert.equal(runtime.current().props['aria-label'], '恢复原文')

  runtime.current().props.onClick()
  await settle()
  assert.equal(draft, 'make it better', 'restore puts the original back')
  assert.equal(runtime.current().props['data-prompt-enhance'], 'idle')
})

test('an immediate second click cancels before React rerenders and ignores its response', async () => {
  const { runtime, Button, fetchCalls, respond } = loadButton()
  let draft = 'cancel immediately'
  const useInput = (select) => select({ draft })
  const inputActions = { setDraft: (value) => { draft = value } }

  runtime.mount(Button, { sessionId: 'A', useInput, inputActions })
  const click = runtime.current().props.onClick
  click()
  click()
  await settle()

  assert.equal(fetchCalls.length, 1, 'the second click cancels instead of sending a duplicate')
  assert.equal(fetchCalls[0].options.signal.aborted, true)
  assert.equal(runtime.current().props['data-prompt-enhance'], 'idle')
  respond(okResponse('LATE RESULT'))
  await settle()
  assert.equal(draft, 'cancel immediately')
  assert.equal(runtime.current().props['data-prompt-enhance'], 'idle')
})

test('an edited draft is cancelled even when the running state has not rerendered', async () => {
  const { runtime, Button, fetchCalls, respond } = loadButton()
  let draft = 'first prompt'
  const useInput = (select) => select({ draft })
  const inputActions = { setDraft: (value) => { draft = value } }

  runtime.mount(Button, { sessionId: 'A', useInput, inputActions })
  const click = runtime.current().props.onClick
  click()
  draft = 'second prompt'
  runtime.update({ useInput, inputActions })
  click()
  await settle()

  assert.equal(fetchCalls.length, 1, 'the click cancels the request for the old draft')
  assert.equal(fetchCalls[0].options.signal.aborted, true, 'the old request is aborted')
  assert.equal(runtime.current().props['data-prompt-enhance'], 'idle')
  respond(okResponse('FIRST RESULT'), 0)
  await settle()
  assert.equal(draft, 'second prompt', 'the old response cannot overwrite the edited draft')
  assert.equal(runtime.current().props['data-prompt-enhance'], 'idle')
})

test('a second click while enhancing cancels the request and keeps the draft', async () => {
  const { runtime, Button, fetchCalls, respond } = loadButton()
  let draft = 'cancel me'
  const useInput = (select) => select({ draft })
  const inputActions = { setDraft: (value) => { draft = value } }

  runtime.mount(Button, { sessionId: 'A', useInput, inputActions })
  runtime.current().props.onClick()
  await settle()
  assert.equal(runtime.current().props['data-prompt-enhance'], 'running')
  assert.equal(runtime.current().props.disabled, false, 'the button stays clickable while enhancing')

  runtime.current().props.onClick()
  await settle()
  assert.equal(fetchCalls[0].options.signal.aborted, true, 'the in-flight request is aborted')
  assert.equal(runtime.current().props['data-prompt-enhance'], 'idle', 'cancelling returns to idle')
  assert.equal(draft, 'cancel me', 'cancelling leaves the draft untouched')

  respond(okResponse('LATE RESULT'))
  await settle()
  assert.equal(draft, 'cancel me', 'a cancelled response never lands')
  assert.equal(runtime.current().props['data-prompt-enhance'], 'idle')
})

test('a response arriving after unmount does not write state or the draft', async () => {
  const { runtime, Button, respond } = loadButton()
  let draft = 'original prompt'
  const useInput = (select) => select({ draft })
  const inputActions = { setDraft: (value) => { draft = value } }

  runtime.mount(Button, { sessionId: 'A', useInput, inputActions })
  runtime.current().props.onClick()
  await settle()
  runtime.unmount()

  respond(okResponse('LATE ENHANCEMENT'))
  await settle()

  assert.equal(draft, 'original prompt', 'an unmounted request must not write the draft')
})

test('the button renders an icon only, with no visible text node', async () => {
  const { runtime, Button } = loadButton()
  let draft = 'make it better'
  const useInput = (select) => select({ draft })
  const inputActions = { setDraft: (value) => { draft = value } }

  runtime.mount(Button, { sessionId: 'A', useInput, inputActions })
  await settle()

  const texts = []
  const walk = (node) => {
    for (const child of node.children ?? []) {
      if (typeof child === 'string' || typeof child === 'number') texts.push(String(child))
      else if (child) walk(child)
    }
  }
  walk(runtime.current())
  assert.deepEqual(texts, [], 'the button must not paint any visible text')
  assert.equal(runtime.current().children.length, 1, 'exactly one child, the icon')
  assert.equal(runtime.current().children[0].type, 'svg')
  assert.equal(runtime.current().props['aria-label'], '增强')
  assert.match(runtime.current().props.title, /增强提示词/)
})
