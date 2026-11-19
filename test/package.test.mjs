import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)

test('published files and exports cover every public runtime entry', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  for (const entry of ['.', './client', './prompt', './enhance']) {
    assert.ok(pkg.exports[entry], `missing export: ${entry}`)
  }
  for (const entry of ['index.js', 'enhance.js', 'client.js', 'prompt.js', 'cordis.patch.yml']) {
    assert.ok(pkg.files.includes(entry), `published files omit ${entry}`)
  }
})

test('package identity and local loader identity remain stable', async () => {
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
  const host = await import(new URL('index.js', root))
  const patch = await readFile(new URL('cordis.patch.yml', root), 'utf8')
  const client = await readFile(new URL('client.js', root), 'utf8')
  assert.equal(pkg.name, '@local/dsh-prompt-enhance')
  assert.equal(host.name, pkg.name)
  assert.match(patch, /id: prompt-enhance/)
  assert.ok(patch.includes("name: '@local/dsh-prompt-enhance'"))
  assert.ok(client.includes("id: '@local/dsh-prompt-enhance'"))
})
