'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const contracts = require('../src/runtime/runtime-port-contracts')
const { bindRuntimePorts } = require('../src/runtime/runtime-ports')

const root = path.resolve(__dirname, '..')
// Include each helper that receives the same narrowed rt object. Their writes
// need the caller's authority just as much as writes in the factory itself.
const sources = {
  safety: ['src/runtime/idle-safety-runtime.js', ...fs.readdirSync(path.join(root, 'src/runtime/idle-escape')).filter(file => file.endsWith('.js')).map(file => `src/runtime/idle-escape/${file}`)],
  userControl: ['src/runtime/user-control-runtime.js'],
  operations: ['src/runtime/runtime-operations.js', 'src/modes/dragon-ports.js', 'src/modes/mining/mine-placement-audit.js', 'src/modes/mining/mine-runtime-observe.js'],
  travel: ['src/runtime/long-travel-runtime.js', 'src/travel/player-travel-crafting.js']
}

function isWriteTarget (node) {
  let current = node, parent = node.parent
  while (parent && (
    ts.isParenthesizedExpression(parent) ||
    ts.isPropertyAssignment(parent) && parent.initializer === current ||
    ts.isArrayLiteralExpression(parent) || ts.isObjectLiteralExpression(parent) ||
    ts.isSpreadAssignment(parent) || ts.isSpreadElement(parent)
  )) { current = parent; parent = current.parent }
  if (!parent) return false
  if (ts.isBinaryExpression(parent)) return parent.left === current && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) return [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(parent.operator)
  if (ts.isForInStatement(parent) || ts.isForOfStatement(parent)) return parent.initializer === current
  return false
}

function runtimeWrites (text, filename = 'port-writes.js') {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  assert.equal(source.parseDiagnostics.length, 0, `${filename}: the port audit must parse every statement`)
  const writes = new Set()
  function visit (node) {
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && ts.isIdentifier(node.expression) && node.expression.text === 'rt' && isWriteTarget(node)) {
      const key = ts.isPropertyAccessExpression(node) ? node.name.text : ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : null
      assert.notEqual(key, null, `${filename}: declare a static Runtime port for this write: ${node.getText(source)}`)
      writes.add(key)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return [...writes].sort()
}

test('Runtime write audit recognizes updates, all compound assignments and destructured targets', () => {
  const compounds = ['=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '^=', '|=', '&&=', '||=', '??=']
  const text = compounds.map((operator, i) => `rt.compound${i} ${operator} 1;`).join('\n') + `
    ++rt.prefixUp; --rt.prefixDown; rt.postfixUp++; rt.postfixDown--;
    rt['literal'] = 1;
    ({ key: rt.object, nested: [rt.array], ...rt.restObject } = source);
    [rt.first, , ...rt.restArray] = source;
    ({ key: rt.defaulted = fallback } = source);
    for (rt.iteration of values) {}
    for (rt.property in source) {}
    rt.host.shared.counter++; rt.controller.state = {};
    const reads = [rt.read, { key: rt.anotherRead }, ++unrelated];
    const computed = { [rt.readKey]: unrelated };
    // ++rt.comment; rt.comment = 1
    const string = 'rt.string += 1';
  `
  assert.deepEqual(runtimeWrites(text), [...compounds.map((_, i) => `compound${i}`), 'prefixUp', 'prefixDown', 'postfixUp', 'postfixDown', 'literal', 'object', 'array', 'restObject', 'first', 'restArray', 'defaulted', 'iteration', 'property'].sort())
  assert.throws(() => runtimeWrites('rt[key]++'), /declare a static Runtime port/)
})

for (const [name, files] of Object.entries(sources)) test(`Runtime ${name} write authority matches its production assignments`, () => {
  const actual = [...new Set(files.flatMap(file => runtimeWrites(fs.readFileSync(path.join(root, file), 'utf8'), file)))].sort()
  assert.deepEqual([...contracts[name].writable].sort(), actual, 'every actual write needs authority, and no unused replacement authority should remain')
  let closureWrites = 0
  const values = Object.fromEntries(actual.map(key => [key, 0])), bindings = {}
  for (const key of actual) Object.defineProperty(bindings, key, { get: () => values[key], set: value => { closureWrites++; values[key] = value } })
  const rt = bindRuntimePorts(bindings, name)
  for (const key of actual) {
    assert.equal(Reflect.set(rt, key, 1), true, `${name}.${key} must forward its production writes`)
    assert.equal(values[key], 1)
  }
  assert.equal(closureWrites, actual.length)
  for (const key of Object.values(contracts[name].groups).flat().filter(key => !actual.includes(key))) assert.equal(Reflect.set(rt, key, null), false, `${name}.${key} remains read-only`)
})
