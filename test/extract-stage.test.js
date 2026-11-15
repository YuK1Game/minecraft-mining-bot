'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { extractStage } = require('../scripts/extract-stage')

// A procedure with the shapes the tool must keep: early returns, awaits, a loop the
// stage continues and breaks, locals it reads and writes, and declarations later code uses.
const source = `'use strict'
function createWorker (rt) {
  async function work (input, { limit = 3 } = {}) {
    let total = 0, log = [], value = 0
    const note = text => { log.push(text) }
    items: for (const item of input) {
      note('item ' + item)
      for (const digit of String(item)) { if (digit === '7') continue items; if (digit === '8') break items; inner: for (;;) { break inner } }
      if (item < 0) continue
      if (item === 99) break
      value = value + item
      const doubled = await rt.double(item)
      let seen = 0, label = 'n' + item
      const { half, tag = 'none' } = { half: item / 2 }; const twice = half * 4; let extra = 1; extra += twice
      function describe () { return label + ':' + seen + ':' + total }
      seen++
      if (doubled > 100) return { early: doubled, log }
      total += doubled
      if (total > limit * 10) { note('over'); label = 'big' }
      switch (item) { case 1: note('one'); break; default: note('other') }
      for (let i = 0; i < 2; i++) { if (i === 1) break; seen += i }
      seen += half
      note(describe() + ':' + tag)
      label += '!'
      note(describe() + twice + extra)
    }
    return { total, log, value }
  }
  return { work }
}
module.exports = { createWorker }
`
const lines = source.split('\n')
const lineOf = text => lines.findIndex(line => line.includes(text)) + 1

async function run (file, input) {
  delete require.cache[require.resolve(file)]
  const calls = []
  const worker = require(file).createWorker({ double: async value => { calls.push(value); return value * 2 } })
  return { result: await worker.work(input), calls }
}

test('a stage moved out of a loop keeps returns, continue, break and the locals later code uses', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-stage-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const original = path.join(directory, 'original.js'), split = path.join(directory, 'worker.js')
  fs.writeFileSync(original, source)
  const { moduleText, sourceText, summary } = extractStage({ file: split, text: source, startLine: lineOf("for (const digit of String(item))"), endLine: lineOf('for (let i = 0; i < 2; i++)'), moduleName: 'worker-stage', functionName: 'stage' })
  fs.writeFileSync(split, sourceText); fs.writeFileSync(path.join(directory, 'worker-stage.js'), moduleText)
  assert.equal(summary.async, true); assert.equal(summary.returns, true); assert.deepEqual(summary.flows.sort(), ['break', 'break items', 'continue', 'continue items'])
  assert.deepEqual(summary.declared, { seen: 'variable', label: 'variable', half: 'constant', tag: 'constant', twice: 'constant', extra: 'variable', describe: 'function' })
  assert.match(moduleText, /switch \(st\.item\) \{ case 1: st\.note\('one'\); break; default:/, 'a break of a switch inside the stage stays a break')
  assert.match(moduleText, /if \(i === 1\) break/, 'a break of a loop inside the stage stays a break')
  assert.match(moduleText, /inner: for \(;;\) \{ break inner \}/, 'a jump to a label inside the stage stays as written')
  for (const input of [[1, 2, 3], [-1, 4, 99, 5], [1, 60, 2], [], [20, -3, 7, 99], [99], [3, 3, 3, 3, 3], [1, 17, 2], [2, 28, 3], [71, 5, 18, 6]]) {
    assert.deepEqual(await run(split, input), await run(original, input), JSON.stringify(input))
  }
})

test('the tool refuses a range it cannot move exactly', () => {
  const file = path.join(os.tmpdir(), 'extract-stage-refusal.js')
  const refuse = (text, a, b, pattern) => assert.throws(() => extractStage({ file, text, startLine: a, endLine: b, moduleName: 'm', functionName: 'f' }), pattern)
  refuse('function f () {\n  const a = 1\n  return a +\n    2\n}\n', 3, 3, /whole statements/)
  refuse('function f () {\n  const x = await g()\n  return x\n}\n', 2, 2, /not async/)
  refuse('function f () {\n  const x = this.y\n  return x\n}\n', 2, 2, /this\/arguments/)
  refuse('function f () {\n  g()\n  function g () {}\n  return 1\n}\n', 3, 3, /used before it/)
  refuse('function f () {\n  let [a] = [1]\n  a++\n  return a\n}\n', 2, 2, /declared by a pattern/)
  refuse('function f (st) {\n  const x = st\n  return x\n}\n', 2, 2, /name st/)
})
