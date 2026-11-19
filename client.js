/**
 * dsh-prompt-enhance 的 Web 客户端：输入框右侧的「增强提示词」按钮。
 *
 * 形态对齐 WorkBuddy 输入框同名按钮：**只显示一枚 16px 图标**，界面上不出现任何
 * 可见文字；状态名与失败原因全部走 title / aria-label（原生 tooltip 与读屏器）。
 *
 *   空闲   → 点 = 把当前草稿发给 Host 增强，成功后整段替换草稿并记住原文；
 *   增强中 → 点 = 取消本次增强（中止在途请求，草稿原样保留）；
 *   成功后 → 图标换成环形箭头，点 = 还原成点击前的原文（草稿被改过则自动回空闲）；
 *   失败   → 图标变警告色，title 显示原因，再点即重试。
 *
 * 与 Host 的唯一通道是同源 POST /prompt-enhance（见 index.js）。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-prompt-enhance',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const API = '/prompt-enhance'
    const SLOT = 'conversation.input.right'
    const NS = 'prompt-enhance'

    // 界面里没有文字，这些词条只用于 title / aria-label。
    const ZH = {
      enhance: '增强',
      enhancing: '增强中…',
      cancel: '取消增强',
      revert: '恢复原文',
      failed: '增强失败',
      empty: '先输入内容再增强',
      hint: '增强提示词：把当前草稿改写成更清晰具体的提示词',
    }
    const EN = {
      enhance: 'Enhance',
      enhancing: 'Enhancing…',
      cancel: 'Cancel enhancement',
      revert: 'Restore original',
      failed: 'Enhance failed',
      empty: 'Type something first',
      hint: 'Enhance prompt: rewrite the current draft into a clearer, more specific prompt',
    }

    const noInput = (selector) => selector({ draft: '' })

    /** 语言文案：优先走 Client locale；服务缺席时回落中文。 */
    function translator(ctx) {
      const fallback = (key) => ZH[key] ?? key
      try {
        const locale = ctx.get ? ctx.get('locale') : undefined
        if (locale) {
          locale.register?.(NS, 'zh', ZH)
          locale.register?.(NS, 'en', EN)
        }
        const bound = locale?.bind?.(NS)
        if (typeof bound === 'function') {
          return (key) => {
            try {
              const value = bound(key)
              if (typeof value === 'string' && value !== '' && value !== key) return value
            } catch {}
            return fallback(key)
          }
        }
      } catch {}
      return fallback
    }

    const stroke = {
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.7,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }

    /** 16×16 图标：只画图形，不含任何文字。颜色一律 currentColor，由按钮 style 决定。 */
    function glyph(state) {
      const box = {
        viewBox: '0 0 16 16',
        width: 16,
        height: 16,
        'aria-hidden': 'true',
        focusable: 'false',
        style: { display: 'block', flex: 'none' },
      }
      if (state === 'running') {
        // 环形进度：底环 + 旋转弧。旋转用 SVG 自带 animateTransform，
        // 不引入 @keyframes，因此无需向 document 注入样式表。
        return h(
          'svg',
          box,
          h('circle', { cx: 8, cy: 8, r: 5.6, ...stroke, strokeOpacity: 0.25 }),
          h(
            'path',
            { d: 'M8 2.4a5.6 5.6 0 0 1 5.6 5.6', ...stroke },
            h('animateTransform', {
              attributeName: 'transform',
              type: 'rotate',
              from: '0 8 8',
              to: '360 8 8',
              dur: '0.9s',
              repeatCount: 'indefinite',
            }),
          ),
        )
      }
      if (state === 'revert') {
        // 逆时针环形箭头 = 还原。
        return h(
          'svg',
          box,
          h('path', { d: 'M13 8a5 5 0 1 1-1.6-3.7', ...stroke }),
          h('path', { d: 'M11.7 1.9v2.9H8.8', ...stroke }),
        )
      }
      if (state === 'error') {
        return h(
          'svg',
          box,
          h('path', { d: 'M8 2.6 14.2 13.4H1.8Z', ...stroke, strokeWidth: 1.5 }),
          h('path', { d: 'M8 6.4v3.2', ...stroke }),
          h('circle', { cx: 8, cy: 11.6, r: 0.95, fill: 'currentColor', stroke: 'none' }),
        )
      }
      // 空闲：一大一小两颗四角星（火花），指代「改写 / 提亮」。
      // 单颗四角星在 16px 下会被看成加号，与输入框左侧的「+ 附件」混淆，故用双星。
      return h(
        'svg',
        box,
        h('path', {
          d: 'M6.6 4.2 7.65 8.35 11.8 9.4 7.65 10.45 6.6 14.6 5.55 10.45 1.4 9.4 5.55 8.35Z',
          fill: 'currentColor',
          fillOpacity: 0.9,
          stroke: 'none',
        }),
        h('path', {
          d: 'M12.3 1.3 12.85 3.45 15 4 12.85 4.55 12.3 6.7 11.75 4.55 9.6 4 11.75 3.45Z',
          fill: 'currentColor',
          fillOpacity: 0.6,
          stroke: 'none',
        }),
      )
    }

    function makeEnhanceButton(t) {
      return function EnhanceButton(props) {
        const useInput = typeof props.useInput === 'function' ? props.useInput : noInput
        const draft = useInput((state) => (state && typeof state.draft === 'string' ? state.draft : '')) || ''
        const inputActions = props.inputActions
        const sessionId = props.sessionId

        // idle | running | done | error
        const [phase, setPhase] = useState('idle')
        const [original, setOriginal] = useState('')
        const [enhanced, setEnhanced] = useState('')
        const [error, setError] = useState('')
        const [hover, setHover] = useState(false)
        const controllerRef = useRef(null)
        // 在途请求期间用户可能继续打字：结果只有在草稿仍是发起时那段文本时
        // 才允许落盘，否则会把用户刚敲进去的内容冲掉。
        const draftRef = useRef(draft)
        const draftRevisionRef = useRef(0)

        // 同时记录草稿版本：等待中即使用户改回原文字，也不能再落旧响应。
        useEffect(() => {
          if (draftRef.current !== draft) draftRevisionRef.current += 1
          draftRef.current = draft
        }, [draft])

        // 每个会话有独立草稿：切换会话即回到空闲，并取消上一会话的在途请求，
        // 否则旧响应会把新会话的草稿覆盖掉。
        useEffect(() => {
          const inflight = controllerRef.current
          if (inflight) {
            controllerRef.current = null
            inflight.abort()
          }
          setPhase('idle')
          setOriginal('')
          setEnhanced('')
          setError('')
        }, [sessionId])

        // 卸载时取消在途请求。
        useEffect(() => () => {
          const controller = controllerRef.current
          if (controller) controller.abort()
        }, [])

        const busy = phase === 'running'
        const canRevert = phase === 'done' && enhanced !== '' && draft === enhanced
        // 增强中按钮依然可点（点 = 取消），所以 busy 不计入 disabled。
        const disabled = !busy && !canRevert && draft.trim() === ''

        // 用 ref 保存最新 inputActions，避免 onClick 因每次按键而重建。
        // 草稿本身复用上面的 draftRef：它在 effect 里同步，点击时已经是最新值。
        const actionsRef = useRef(inputActions)
        useEffect(() => {
          actionsRef.current = inputActions
        }, [inputActions])

        const onClick = useCallback(() => {
          // 增强中 → 取消：作废在途请求。草稿从未被提前写过，取消即原文保持不变。
          if (controllerRef.current) {
            const inflight = controllerRef.current
            controllerRef.current = null
            if (inflight) inflight.abort()
            setPhase('idle')
            setError('')
            return
          }
          if (canRevert) {
            if (typeof actionsRef.current?.setDraft === 'function') actionsRef.current.setDraft(original)
            setPhase('idle')
            setError('')
            return
          }
          if (typeof actionsRef.current?.setDraft !== 'function') return
          // 上一个请求若仍存活（异常路径），先作废，避免两个响应抢同一段草稿。
          const stale = controllerRef.current
          if (stale) {
            controllerRef.current = null
            stale.abort()
          }
          const text = draftRef.current
          const draftRevision = draftRevisionRef.current
          const controller = new AbortController()
          controllerRef.current = controller
          setPhase('running')
          setError('')
          fetch(API, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text }),
            signal: controller.signal,
          })
            .then(async (response) => {
              const data = await response.json().catch(() => ({}))
              // 会话已经切走、被取消，或已被更新的请求取代：结果属于旧上下文。
              if (controller.signal.aborted || controllerRef.current !== controller) return
              if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
              if (!data || data.success !== true) {
                const failure = new Error((data && data.error) || 'enhance failed')
                failure.code = data && data.code
                throw failure
              }
              // 等待期间用户改过草稿：以用户输入为准，结果丢弃并回到空闲。
              if (draftRef.current !== text || draftRevisionRef.current !== draftRevision) {
                setPhase('idle')
                return
              }
              if (typeof data.text !== 'string' || data.text.trim() === '') {
                throw new Error('enhance returned empty text')
              }
              actionsRef.current.setDraft(data.text)
              setOriginal(text)
              setEnhanced(data.text)
              setPhase('done')
            })
            .catch((reason) => {
              if (controller.signal.aborted || controllerRef.current !== controller) return
              setError(reason && reason.message ? reason.message : 'enhance failed')
              setPhase('error')
            })
            .finally(() => {
              if (controllerRef.current === controller) controllerRef.current = null
            })
        }, [busy, canRevert, original])

        // 界面没有文字：label 只进 aria-label，title 是唯一可见的解释（原生 tooltip）。
        const label = busy ? t('cancel') : canRevert ? t('revert') : phase === 'error' ? t('failed') : t('enhance')
        const title = phase === 'error' && error !== ''
          ? error
          : disabled
            ? t('empty')
            : phase === 'idle'
              ? t('hint')
              : label

        // 28×28 圆形无边框图标按钮：尺寸与 hover 底色对齐宿主 composer 自带的
        // `.add` 按钮（hover 用 --dsw-alias-interactive-bg-hover-solid）。
        const style = useMemo(() => ({
          display: 'grid',
          placeItems: 'center',
          flex: 'none',
          width: 28,
          height: 28,
          padding: 0,
          border: 'none',
          borderRadius: 999,
          background: hover && !disabled ? 'var(--dsw-alias-interactive-bg-hover-solid)' : 'transparent',
          color: canRevert
            ? 'var(--dsw-alias-brand-primary)'
            : phase === 'error'
              ? 'var(--dsw-alias-state-error-primary)'
              : 'var(--dsw-alias-label-secondary)',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          transition: 'background-color .15s ease, color .15s ease, opacity .15s ease',
        }), [canRevert, hover, disabled, phase])

        const state = busy ? 'running' : canRevert ? 'revert' : phase === 'error' ? 'error' : 'idle'

        return h(
          'button',
          {
            type: 'button',
            'data-prompt-enhance': phase,
            'aria-label': label,
            'aria-busy': busy ? 'true' : undefined,
            title,
            disabled,
            style,
            // 与宿主 composer 的 keepFocus 同理：按下时不让焦点离开编辑框。
            onMouseDown: (event) => {
              if (event && typeof event.preventDefault === 'function') event.preventDefault()
            },
            onClick,
            onMouseEnter: () => setHover(true),
            onMouseLeave: () => setHover(false),
          },
          glyph(state),
        )
      }
    }

    function apply(ctx) {
      const t = translator(ctx)
      const EnhanceButton = makeEnhanceButton(t)
      try {
        ctx.slots.inject(SLOT, () =>
          ctx.slots.register({ name: SLOT, id: 'prompt-enhance', order: 20 }, EnhanceButton),
        )
      } catch (error) {
        console.warn('[prompt-enhance] composer button unavailable:', error)
      }
    }

    return { inject: ['slots'], apply }
  },
})
