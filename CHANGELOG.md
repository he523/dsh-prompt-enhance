# Changelog

## 1.3.0

- Architecture: extracted the shared enhancement lifecycle into `enhance.js` and its small `createEnhancer()` interface. Input short-circuiting, model routing, the single LLM completion, bounded stream collection, cancellation/timeout and finalisation now live behind one Host-independent core; `index.js` retains tool registration, configuration and the Web transport adapter.
- Host hardening: non-integer values returned by `connection.requestRejection` now fail closed with 403 instead of reaching the HTTP response layer. Existing fixed envelopes, route precedence, same-origin trust checks and body/output limits remain unchanged.
- Client hardening: cancellation now uses the live in-flight controller rather than waiting for a React render, so an immediate second click cannot send a duplicate request. Draft revisions invalidate stale results even when the user edits and then restores the original text while waiting.
- Client validation: malformed, missing or blank successful results preserve the draft and enter a retryable failure state; late responses after unmount remain inert.
- Packaging and tests: `enhance.js` is exported and included in published files. Added focused core and package-surface suites; the full behaviour matrix now covers 42 tests across prompt, core, Host, Composer and packaging.

## 1.2.0

- UI: the composer button is now **icon-only**. The visible 「增强 / 增强中… / 恢复原文 / 增强失败」 label is gone; the state text lives in `aria-label` and the failure reason in `title`, so nothing is lost for screen readers or for the test contract that asserts `aria-label === '恢复原文'`.
- UI: shape now matches the host composer buttons — 28×28, borderless, `border-radius: 999px`, transparent background, hover `--dsw-alias-interactive-bg-hover-solid`, `display: grid; place-items: center`, 16×16 inline SVG. Closest neighbour is the host `.add` button in `conversation.input.right`; `--dsw-alias-icon-primary` does not exist in DSH, so the icon inherits `currentColor` from `--dsw-alias-label-secondary` / `--dsw-alias-brand-primary` / `--dsw-alias-state-error-primary`.
- UI: four icon states — four-point star (idle), spinning ring (enhancing), circular arrow (restore available), warning triangle (failed). The spin uses SVG `<animateTransform>` rather than an injected `@keyframes`, so the plugin still adds no `<style>` element and no DOM side effects.
- Behaviour: while a request is in flight the button is **no longer disabled**; clicking it cancels (aborts the in-flight fetch, returns to idle, draft untouched), matching WorkBuddy's `cancellable` branch. A superseded request can never win: responses are ignored when `controllerRef.current !== controller`.
- Behaviour: `onMouseDown` calls `preventDefault()` so pressing the button keeps focus in the editor (the host does the same via `keepFocus`).
- Tests: two new cases — cancelling mid-flight leaves the draft intact and a late response never lands; and the rendered tree contains no text node at all, only a single `svg` child.

## 1.1.1
- Fix (robustness): a non-status return from `connection.requestRejection` had no defined meaning. The old `rejection !== undefined` test passed it straight to `res.writeHead`, which threw `ERR_HTTP_INVALID_STATUS_CODE` and surfaced as a misleading `500 {"code":"unknown","error":"Invalid status code: 0"}` rather than a rejection. Now only `undefined`/`null` means admitted, a numeric status in `100..599` is forwarded, and any other value is coerced to a fail-closed `403`.
- Fix: `sendJson` no longer throws `ERR_STREAM_WRITE_AFTER_END` when the response is already ended or destroyed; the 405 branch and the terminal `catch` use the same guard.
- Fix: `readBody` settles exactly once, so an oversized body that triggers `destroy()` can no longer double-reject on the late `error` event.
- Perf: streamed deltas are collected in an array and joined once, instead of quadratically concatenating strings up to the 64 KiB cap.
- Client: `draftRef` is synced in an effect instead of during render; `onClick` reads the latest draft/actions through refs so the handler no longer rebuilds on every keystroke; button style is memoised.
- Fix: the configured `provider`/`model` never took effect. `resolveRoute` consulted the current default model first, and that selector is almost always populated, so the documented order (tool `model` → plugin config → default model) was inverted in practice. Config now wins, as the README always said.
- Fix: a `model` argument was split on every `/`, so an id like `openrouter/meta-llama/llama-3-70b` silently routed to the non-existent model `meta-llama` and dropped the rest. It now splits on the first slash only.
- Fix: an already-aborted caller signal never reached the completion. `addEventListener('abort')` cannot fire for a signal that is aborted before it is attached, so an interrupted tool call still hit the model. The aborted state is now checked synchronously after subscribing.
- Tests: the fail-closed case now covers a missing connection service, a gate that throws, and `0` / `false` / `NaN` returns.

## 1.1.0

- Composer button in `conversation.input.right`: enhance / enhancing / restore-original / failed states, per-session reset, in-flight request cancelled on unmount.
- Host route `POST /prompt-enhance` for the button, sharing one pipeline with the tool; trust delegated to `connection.requestRejection` with fail-closed rejection.
- Rewritten instruction text: same rules as before (language matching, prompt-only output, no answering, ~800-character target), original wording; no verbatim third-party text.

## 1.0.0

- `enhance_prompt` tool: single non-agentic completion, result envelope `{ success, text, code?, error? }` with `empty_input` / `llm_unavailable` / `llm_error` / `unknown`.
- Post-processing: trim, strip one wrapping quote pair, empty result becomes `llm_error`.
- Optional `model` override (`model-id` or `provider/model-id`), falling back to plugin config and the current default model.
- Unit tests for the pure pipeline (`node test/prompt.test.mjs`).
