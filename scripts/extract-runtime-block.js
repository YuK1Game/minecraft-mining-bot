'use strict'

// Moves a run of whole statements out of the closure in src/runtime.js into a
// module of its own without changing what the code does. long-travel-runtime.js
// was produced this way (2026-11-15).
//
//   node scripts/extract-runtime-block.js <startLine> <endLine> <module> <factory> <instance> [--apply]
//   e.g. 7911 8625 long-travel-runtime createLongTravelRuntime travelRuntime
//
// From the syntax tree (the TypeScript compiler that ships in node_modules as a
// dependency of a dependency; nothing is installed for this):
// - an identifier in the range that resolves to a binding declared outside it
//   becomes rt.<name>; runtime.js passes one accessor per such binding, with a
//   setter where the range assigns to it, so every read and write still reaches
//   the runtime's own variable at that moment;
// - `require` in the range becomes rt.require, the runtime's own require, so
//   hot reload tracking and test overrides of modules keep working;
// - a function the range declares and other runtime code calls stays callable
//   through a hoisted one-line wrapper; a value it declares is read (and, where
//   outside code assigns to it, written) as <instance>.<name>.
// Without --apply nothing is written to src/; both results go to the system
// temp folder and the summary is printed. Afterwards: npm run check, the tests
// of that feature, npm run test:review and a full-suite failure comparison, and
// lower src/runtime.js in scripts/size-budget.json.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const ts = require('typescript')
const root = path.resolve(__dirname, '..'), file = path.join(root, 'src', 'runtime.js').replaceAll('\\', '/')
const [a, b] = [Number(process.argv[2]), Number(process.argv[3])], [moduleName, factory, instance] = process.argv.slice(4, 7)
if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < a || ![moduleName, factory, instance].every(name => /^[A-Za-z][\w-]*$/.test(name ?? ''))) {
  console.error('usage: node scripts/extract-runtime-block.js <startLine> <endLine> <module> <factory> <instance> [--apply]'); process.exit(2)
}
const apply = process.argv.includes('--apply')
const text = fs.readFileSync(file, 'utf8'), nl = text.includes('\r\n') ? '\r\n' : '\n'
const program = ts.createProgram([file], { allowJs: true, checkJs: false, noEmit: true, target: ts.ScriptTarget.ESNext, noResolve: true, types: [], lib: [] })
const sf = program.getSourceFile(file), checker = program.getTypeChecker()
if (sf.text !== text) throw new Error('The parsed text differs from the file')
const starts = sf.getLineStarts(), from = starts[a - 1], to = starts[b] ?? text.length
const inside = node => node.getStart(sf) >= from && node.getStart(sf) < to
const inner = [], outer = [], bindings = new Map(), returned = new Map()
function isWrite (id) {
  const p = id.parent
  if (ts.isBinaryExpression(p) && p.left === id && p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && p.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return true
  return (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(p.operator)
}
function visit (node) {
  if (ts.isIdentifier(node)) {
    const p = node.parent
    const isName = (ts.isPropertyAccessExpression(p) && p.name === node) || (ts.isPropertyAssignment(p) && p.name === node) || (ts.isMethodDeclaration(p) && p.name === node) || (ts.isBindingElement(p) && p.propertyName === node)
    if (!isName) {
      const shorthand = ts.isShorthandPropertyAssignment(p)
      const symbol = shorthand ? checker.getShorthandAssignmentValueSymbol(p) : checker.getSymbolAtLocation(node)
      const declaration = symbol?.declarations?.[0]
      if (!declaration && node.text === 'require' && inside(node)) { bindings.set('require', bindings.get('require') ?? { write: false }); inner.push({ pos: node.getStart(sf), end: node.getEnd(), text: 'rt.require' }) }
      if (declaration && declaration.getSourceFile() === sf) {
        const declaredIn = inside(declaration), usedIn = inside(node)
        if (usedIn && !declaredIn) {
          const entry = bindings.get(node.text) ?? { write: false }; if (isWrite(node)) entry.write = true; bindings.set(node.text, entry)
          inner.push({ pos: node.getStart(sf), end: node.getEnd(), text: shorthand ? `${node.text}: rt.${node.text}` : `rt.${node.text}` })
        }
        if (!usedIn && declaredIn) {
          const kind = ts.isFunctionDeclaration(declaration) ? 'function' : 'value'
          if (isWrite(node) && kind === 'function') throw new Error(`${node.text} is a function of the range that outside code assigns to`)
          returned.set(node.text, isWrite(node) || returned.get(node.text) === 'assigned' ? 'assigned' : kind)
          if (kind !== 'function') outer.push({ pos: node.getStart(sf), end: node.getEnd(), text: shorthand ? `${node.text}: ${instance}.${node.text}` : `${instance}.${node.text}` })
        }
      }
    }
  }
  ts.forEachChild(node, visit)
}
visit(sf)
// The range must be whole statements of one block.
const first = from + text.slice(from).search(/\S/)
let container = null
;(function find (node) { if (ts.isBlock(node) && node.statements.some(statement => statement.getStart(sf) === first)) container = node; ts.forEachChild(node, find) })(sf)
const covered = container?.statements.filter(inside) ?? []
if (!covered.length || covered.at(-1).getEnd() > to || container.statements.some(statement => !inside(statement) && statement.getStart(sf) < to && statement.getEnd() > from)) throw new Error('The line range must cover whole statements of one block')
const splice = (source, base, edits) => edits.sort((x, y) => y.pos - x.pos).reduce((result, edit) => result.slice(0, edit.pos - base) + edit.text + result.slice(edit.end - base), source)
const names = [...bindings].sort((x, y) => x[0].localeCompare(y[0])), back = [...returned]
const moduleText = [
  "'use strict'", '',
  `// Moved out of runtime.js unchanged by scripts/extract-runtime-block.js.`,
  '// `rt` exposes the runtime closure bindings this code uses; each read or write',
  "// of rt.<name> reads or writes the runtime's own variable at that moment.",
  "// Modules are loaded through rt.require, the runtime's own require.", '',
  `function ${factory} (rt) {`,
  splice(text.slice(from, to), from, inner).replace(/(\r?\n)+$/, ''),
  '  return {',
  ...back.map(([name, kind], i) => `    ${kind === 'function' ? name : `get ${name} () { return ${name} }${kind === 'assigned' ? `, set ${name} (value) { ${name} = value }` : ''}`}${i < back.length - 1 ? ',' : ''}`),
  '  }', '}', '',
  `module.exports = { ${factory} }`, ''
].join(nl)
const wiring = [
  `  // This part lives in ${moduleName}.js. It reads and writes these bindings of`,
  '  // this closure through accessors, so each use sees the current value exactly',
  '  // as the code did when it was written here.',
  `  const ${instance} = require('./${moduleName}').${factory}({`,
  ...names.map(([name, entry]) => `    get ${name} () { return ${name} },${entry.write ? ` set ${name} (value) { ${name} = value },` : ''}`).map((line, i, all) => i === all.length - 1 ? line.replace(/,$/, '') : line),
  '  })',
  ...back.filter(([, kind]) => kind === 'function').map(([name]) => `  function ${name} (...args) { return ${instance}.${name}(...args) }`), ''
].join(nl)
const runtimeText = splice(text.slice(0, from), 0, outer.filter(edit => edit.pos < from)) + wiring + splice(text.slice(to), to, outer.filter(edit => edit.pos >= to))
const out = apply ? path.join(root, 'src') : fs.mkdtempSync(path.join(os.tmpdir(), 'extract-runtime-block-'))
fs.writeFileSync(path.join(out, `${moduleName}.js`), moduleText)
fs.writeFileSync(path.join(out, 'runtime.js'), runtimeText)
console.log(JSON.stringify({ written: out, statements: covered.length, bindings: names.length, assigned: names.filter(([, entry]) => entry.write).map(([name]) => name), returned: back, edits: { inside: inner.length, outside: outer.length }, runtimeBytes: { before: text.length, after: runtimeText.length }, moduleBytes: moduleText.length }, null, 1))
