// dsh-comm Client 半边单测：模拟 window.__ModuleLoader__ / React / ctx，验证右栏 tab 注册与 iframe。
import assert from 'node:assert/strict'

globalThis.window = {
  __DSH_COMM__: { base: '/comm', token: 'unit-token' },
  __ModuleLoader__: {
    load(spec) {
      globalThis.__spec = spec
    },
  },
}

await import('../lib/client.js')
const spec = globalThis.__spec
assert.equal(spec.id, 'dsh-comm')

const react = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props || {}), children } }
  },
  useRef() { return { current: null } },
  useState(initial) {
    const value = typeof initial === 'function' ? initial() : initial
    return [value, () => {}]
  },
  useEffect() { /* no-op in unit test */ },
}
const mod = spec.factory(() => react)
assert.equal(mod.name, 'dsh-comm')
assert.deepEqual(mod.inject, ['slots', 'sidebarRightTabs'])

const tabs = []
const seats = []
const ctx = {
  sidebarRightTabs: {
    register(definition) {
      tabs.push(definition)
      return () => {}
    },
  },
  slots: {
    inject(_name, factory) { return factory() },
    register(definition, component) {
      seats.push({ definition, component })
      return () => {}
    },
  },
  effect(fn) { return fn() },
}

mod.apply(ctx)

assert.equal(tabs.length, 1, 'one tab type')
assert.equal(tabs[0].id, 'dsh-comm')
assert.equal(tabs[0].kind, 'dsh-comm')
assert.equal(tabs[0].guide[0].id, 'dsh-comm:guide')
assert.equal(tabs[0].guide[0].order, 40)
assert.equal(tabs[0].guide[0].title(), '通信')

const bodySeat = seats.find((s) => s.definition.name === 'sidebar.right.pane.tab')
assert.ok(bodySeat, 'body seat registered')
assert.equal(bodySeat.definition.key, 'dsh-comm')
const frame = bodySeat.component({}).type({})
assert.equal(frame.type, 'iframe')
assert.match(frame.props.src, /\/comm\/ui\?token=unit-token/)

const titleSeat = seats.find((s) => s.definition.name === 'sidebar.right.pane.tab.title')
assert.ok(titleSeat, 'title seat registered')

// 没有注入配置时的降级
globalThis.window.__DSH_COMM__ = undefined
const fallback = bodySeat.component({}).type({})
assert.equal(fallback.type, 'div')
assert.match(String(fallback.props.children[0]), /未就绪/)

console.log('CLIENT TEST PASSED')
