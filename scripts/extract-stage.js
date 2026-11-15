'use strict'

// Moves a run of whole statements out of the middle of a large function into a
// function of its own in a new module, without changing what the code does.
// Where extract-runtime-block.js moves declarations out of a closure, this one
// moves a stage of a procedure: the range may await, return, and break or
// continue a loop that encloses it.
//
//   node scripts/extract-stage.js <startLine> <endLine> <module> <function> --file=src/x.js [--dir=sub] [--as=st] [--root=<checkout>] [--apply]
//
// From the syntax tree (the TypeScript compiler that ships in node_modules):
// - a local of the enclosing functions that the range uses becomes st.<name>;
//   the caller passes one accessor per such local (with a setter where it can
//   be assigned), so every read and write reaches the caller's own variable;
// - a binding named `rt` is passed through as the first argument unchanged;
// - `require`, `__dirname` and `__filename` become st.require and so on;
// - `return x` in the range becomes `return { value: x }` and the caller returns
//   that value; `break`/`continue` of a loop outside the range become
//   `return { flow }` and the caller breaks or continues;
// - a variable the range declares and later code uses is declared by the caller
//   before the call: a constant is copied to it once it is initialised, a
//   variable that can be reassigned is read and written as st.<name> throughout.
// Without --apply both results go to the system temp folder. Afterwards run
// npm run check and the tests of that feature, then a full-suite comparison.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const ts = require('typescript')

function extractStage ({ file, text, startLine, endLine, moduleName, functionName, subdirectory = '', stateName = 'st' }) {
  const nl = text.includes('\r\n') ? '\r\n' : '\n', sourceName = path.basename(file)
  const host = ts.createCompilerHost({ allowJs: true }), read = host.readFile
  host.readFile = name => path.resolve(name) === path.resolve(file) ? text : read(name)
  const program = ts.createProgram([file], { allowJs: true, checkJs: false, noEmit: true, target: ts.ScriptTarget.ESNext, noResolve: true, types: [], lib: [] }, host)
  const sf = program.getSourceFile(file), checker = program.getTypeChecker()
  if (sf.text !== text) throw new Error('The parsed text differs from the given text')
  const starts = sf.getLineStarts(), from = starts[startLine - 1], to = starts[endLine] ?? text.length
  const lineOf = node => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
  const inside = node => node.getStart(sf) >= from && node.getStart(sf) < to
  const first = from + text.slice(from).search(/\S/)
  let container = null
  ;(function find (node) { if (ts.isBlock(node) && node.statements.some(statement => statement.getStart(sf) === first)) container = node; ts.forEachChild(node, find) })(sf)
  const covered = container?.statements.filter(inside) ?? []
  if (!covered.length || covered.at(-1).getEnd() > to || container.statements.some(statement => !inside(statement) && statement.getStart(sf) < to && statement.getEnd() > from)) throw new Error('The line range must cover whole statements of one block')
  const isFunction = node => ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node) || ts.isConstructorDeclaration(node)
  let enclosing = container
  while (enclosing && !isFunction(enclosing)) enclosing = enclosing.parent
  if (!enclosing) throw new Error('The range is not inside a function')
  const enclosingAsync = !!enclosing.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)

  const inner = [], bindings = new Map(), exported = new Map()
  let awaits = false, returns = false, usesRt = false
  const flows = new Set()
  const isWrite = id => {
    const p = id.parent
    if (ts.isBinaryExpression(p) && p.left === id && p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && p.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return true
    return (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(p.operator)
  }
  const declarationRoot = declaration => { let root = declaration; while (ts.isBindingElement(root) || ts.isObjectBindingPattern(root) || ts.isArrayBindingPattern(root)) root = root.parent; return root }
  const assignable = declaration => {
    const root = declarationRoot(declaration)
    if (ts.isParameter(root)) return true
    return ts.isVariableDeclaration(root) && !(ts.isVariableDeclarationList(root.parent) && root.parent.flags & ts.NodeFlags.Const)
  }
  // Statement-level control flow of the range. `loops` counts enclosing loops and
  // `switches` enclosing switch statements that are themselves inside the range.
  for (const statement of covered) (function flow (node, depth, plain, loops, switches) {
    if (depth === 0) {
      if (ts.isAwaitExpression(node) || ts.isForOfStatement(node) && node.awaitModifier) awaits = true
      if (ts.isYieldExpression(node)) throw new Error(`The range yields at line ${lineOf(node)}`)
      if (ts.isReturnStatement(node)) {
        returns = true
        if (node.expression) { inner.push({ pos: node.expression.getStart(sf), end: node.expression.getStart(sf), text: '{ value: ' }); inner.push({ pos: node.expression.getEnd(), end: node.expression.getEnd(), text: ' }' }) } else inner.push({ pos: node.getStart(sf) + 'return'.length, end: node.getStart(sf) + 'return'.length, text: ' { value: undefined }' })
      }
      if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
        // A label names its statement: the jump leaves the range when that statement is outside it.
        let target = null
        if (node.label) { for (let up = node.parent; up && !target; up = up.parent) if (ts.isLabeledStatement(up) && up.label.text === node.label.text) target = up }
        const escapes = node.label ? !target || !inside(target) : ts.isContinueStatement(node) ? loops === 0 : loops === 0 && switches === 0
        if (escapes) { const kind = `${ts.isBreakStatement(node) ? 'break' : 'continue'}${node.label ? ' ' + node.label.text : ''}`; flows.add(kind); inner.push({ pos: node.getStart(sf), end: node.getEnd(), text: `return { flow: '${kind}' }${text[node.getEnd() - 1] === ';' ? ';' : ''}` }) }
      }
    }
    if (plain === 0 && (node.kind === ts.SyntaxKind.ThisKeyword || ts.isIdentifier(node) && node.text === 'arguments')) throw new Error(`The range uses this/arguments of the enclosing function at line ${lineOf(node)}`)
    const fn = isFunction(node), loop = ts.isIterationStatement(node, false), sw = ts.isSwitchStatement(node)
    ts.forEachChild(node, child => flow(child, depth + (fn ? 1 : 0), plain + (fn && !ts.isArrowFunction(node) ? 1 : 0), fn ? 0 : loops + (loop ? 1 : 0), fn ? 0 : switches + (sw ? 1 : 0)))
  })(statement, 0, 0, 0, 0)
  if (awaits && !enclosingAsync) throw new Error('The range awaits but its function is not async')

  // Identifiers: locals of the caller used in the range, and declarations of the range used after it.
  const uses = []
  ;(function visit (node) {
    if (ts.isIdentifier(node)) {
      const p = node.parent
      const isName = (ts.isPropertyAccessExpression(p) && p.name === node) || (ts.isPropertyAssignment(p) && p.name === node) || (ts.isMethodDeclaration(p) && p.name === node) || (ts.isBindingElement(p) && p.propertyName === node) || ((ts.isBreakStatement(p) || ts.isContinueStatement(p) || ts.isLabeledStatement(p)) && p.label === node)
      if (!isName) {
        const shorthand = ts.isShorthandPropertyAssignment(p)
        const symbol = shorthand ? checker.getShorthandAssignmentValueSymbol(p) : checker.getSymbolAtLocation(node)
        const declaration = symbol?.declarations?.[0]
        if (node.text === stateName && inside(node)) throw new Error(`The range already uses the name ${stateName} at line ${lineOf(node)}; choose another with --as=<name>`)
        if (!declaration && ['require', '__dirname', '__filename'].includes(node.text) && inside(node)) uses.push({ node, name: node.text, shorthand, outer: true, write: false, assignable: false })
        if (declaration && declaration.getSourceFile() === sf) {
          const declaredIn = inside(declaration), usedIn = inside(node)
          if (usedIn && !declaredIn) {
            if (node.text === 'rt') usesRt = true
            else uses.push({ node, name: node.text, shorthand, outer: true, write: isWrite(node), assignable: assignable(declaration) })
          }
          if (declaredIn && !usedIn) {
            if (node.getStart(sf) < from) throw new Error(`${node.text} is declared in the range but used before it, at line ${lineOf(node)}`)
            const entry = exported.get(node.text) ?? { declaration, written: false }
            if (entry.declaration !== declaration) throw new Error(`Two declarations of ${node.text} in the range are used after it`)
            if (isWrite(node)) entry.written = true
            exported.set(node.text, entry)
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  })(sf)
  if (exported.has('rt') || bindings.has('rt')) throw new Error('The range declares rt')
  // Classify what the range hands to the code after it.
  const hoisted = [], after = []
  for (const [name, entry] of exported) {
    const declaration = entry.declaration, root = declarationRoot(declaration)
    if (ts.isFunctionDeclaration(declaration)) {
      if (!covered.includes(declaration)) throw new Error(`Function ${name} is used after the range but is not one of its statements`)
      entry.kind = 'function'; hoisted.push(name); continue
    }
    if (!ts.isVariableDeclaration(root) || !ts.isVariableDeclarationList(root.parent) || !ts.isVariableStatement(root.parent.parent) || !covered.includes(root.parent.parent)) throw new Error(`${name} is used after the range but is not declared by one of its statements (line ${lineOf(declaration)})`)
    const constant = !!(root.parent.flags & ts.NodeFlags.Const)
    if (constant && !entry.written) { entry.kind = 'constant'; after.push({ statement: root.parent.parent, name }) } else {
      if (!ts.isIdentifier(root.name)) throw new Error(`${name} can be reassigned and is declared by a pattern; declare it on its own (line ${lineOf(declaration)})`)
      entry.kind = 'variable'; entry.root = root
    }
  }
  // Uses inside the range of its own reassignable exports are st.<name> too.
  ;(function visit (node) {
    if (ts.isIdentifier(node) && inside(node)) {
      const p = node.parent
      const isName = (ts.isPropertyAccessExpression(p) && p.name === node) || (ts.isPropertyAssignment(p) && p.name === node) || (ts.isMethodDeclaration(p) && p.name === node) || (ts.isBindingElement(p) && p.propertyName === node)
      if (!isName) {
        const shorthand = ts.isShorthandPropertyAssignment(p)
        const symbol = shorthand ? checker.getShorthandAssignmentValueSymbol(p) : checker.getSymbolAtLocation(node)
        const declaration = symbol?.declarations?.[0], entry = exported.get(node.text)
        if (entry?.kind === 'variable' && declaration === entry.declaration && node !== entry.root.name) inner.push({ pos: node.getStart(sf), end: node.getEnd(), text: shorthand ? `${node.text}: ${stateName}.${node.text}` : `${stateName}.${node.text}` })
      }
    }
    ts.forEachChild(node, visit)
  })(sf)
  for (const use of uses) {
    const entry = bindings.get(use.name) ?? { write: false }
    if (use.write || use.assignable) entry.write = true
    bindings.set(use.name, entry)
    inner.push({ pos: use.node.getStart(sf), end: use.node.getEnd(), text: use.shorthand ? `${use.name}: ${stateName}.${use.name}` : `${stateName}.${use.name}` })
  }
  // Declarations of reassignable exports become assignments, one statement per declarator.
  const rewritten = new Set()
  for (const entry of exported.values()) {
    if (entry.kind !== 'variable') continue
    const list = entry.root.parent, statement = list.parent
    if (rewritten.has(statement)) continue
    rewritten.add(statement)
    const keyword = list.flags & ts.NodeFlags.Const ? 'const' : list.flags & ts.NodeFlags.Let ? 'let' : 'var'
    const declarations = list.declarations
    inner.push({ pos: statement.getStart(sf), end: declarations[0].getStart(sf), text: '' })
    declarations.forEach((declaration, index) => {
      const moved = ts.isIdentifier(declaration.name) && exported.get(declaration.name.text)?.kind === 'variable' && exported.get(declaration.name.text).root === declaration
      if (moved) {
        inner.push({ pos: declaration.name.getStart(sf), end: declaration.name.getEnd(), text: `${stateName}.${declaration.name.text}` })
        if (!declaration.initializer) inner.push({ pos: declaration.getEnd(), end: declaration.getEnd(), text: ' = undefined' })
      } else inner.push({ pos: declaration.getStart(sf), end: declaration.getStart(sf), text: `${keyword} ` })
      if (index < declarations.length - 1) inner.push({ pos: declaration.getEnd(), end: declarations[index + 1].getStart(sf), text: '; ' })
    })
  }
  const pad = /^[ \t]*/.exec(text.slice(starts[startLine - 1]))[0]
  const byStatement = new Map()
  for (const item of after) byStatement.set(item.statement, [...(byStatement.get(item.statement) ?? []), item.name])
  for (const [statement, names] of byStatement) inner.push({ pos: statement.getEnd(), end: statement.getEnd(), text: text[statement.getEnd() - 1] === ';' ? ` ${names.map(name => `${stateName}.${name} = ${name}`).join('; ')};` : `; ${names.map(name => `${stateName}.${name} = ${name}`).join('; ')}`, late: true })
  // Edits at one position: text that closes an expression goes before text appended after its statement.
  const splice = (source, base, edits) => edits.map((edit, order) => ({ ...edit, order })).sort((x, y) => y.pos - x.pos || y.end - x.end || (y.late ? 1 : 0) - (x.late ? 1 : 0) || y.order - x.order).reduce((result, edit) => result.slice(0, edit.pos - base) + edit.text + result.slice(edit.end - base), source)
  for (const edit of inner) for (const other of inner) if (edit !== other && edit.pos < other.pos && other.pos < edit.end) throw new Error('Internal: overlapping edits')
  const declared = [...exported.keys()]
  const names = [...new Set([...bindings.keys(), ...declared])].sort()
  const parameters = usesRt ? `rt, ${stateName}` : stateName
  const body = splice(text.slice(from, to), from, inner).replace(/(\r?\n)+$/, '')
  const moduleText = [
    "'use strict'", '',
    `// A stage of ${enclosing.name?.getText(sf) ?? 'a function'} in ${sourceName}, moved here unchanged by scripts/extract-stage.js.`,
    `// \`${stateName}\` exposes the locals of that function this stage uses; each read or write`,
    `// of ${stateName}.<name> reads or writes the caller's own variable at that moment.`,
    ...(returns || flows.size ? [`// It returns ${[returns ? '{ value } where the caller returns that value' : '', flows.size ? '{ flow } where the caller breaks or continues its loop' : ''].filter(Boolean).join(', ')}.`] : []), '',
    `${awaits ? 'async ' : ''}function ${functionName} (${parameters}) {`,
    ...hoisted.map(name => `${pad}${stateName}.${name} = ${name}`),
    body,
    '}', '',
    `module.exports = { ${functionName} }`, ''
  ].join(nl)
  const result = `${functionName}Result`, needsResult = returns || flows.size
  const call = `${awaits ? 'await ' : ''}require('./${subdirectory ? subdirectory + '/' : ''}${moduleName}').${functionName}(${usesRt ? 'rt, ' : ''}{`
  const wiring = [
    `${pad}// This stage lives in ${moduleName}.js. It reads and writes these locals through accessors.`,
    ...(declared.length ? [`${pad}let ${declared.join(', ')}`] : []),
    `${pad}${needsResult ? `const ${result} = ` : ''}${call}`,
    ...names.map(name => { const own = exported.has(name), write = own || bindings.get(name)?.write; return `${pad}  get ${name} () { return ${name} },${write ? ` set ${name} ($value) { ${name} = $value },` : ''}` }).map((line, i, all) => i === all.length - 1 ? line.replace(/,$/, '') : line),
    `${pad}})`,
    ...(returns ? [`${pad}if (${result} && 'value' in ${result}) return ${result}.value`] : []),
    ...[...flows].map(kind => `${pad}if (${result}?.flow === '${kind}') ${kind}`), ''
  ].join(nl)
  const sourceText = text.slice(0, from) + wiring + text.slice(to)
  return { moduleText, sourceText, summary: { statements: covered.length, locals: [...bindings.keys()].sort(), assigned: [...bindings].filter(([, entry]) => entry.write).map(([name]) => name).sort(), declared: Object.fromEntries([...exported].map(([name, entry]) => [name, entry.kind])), async: awaits, returns, flows: [...flows], bytes: { before: text.length, after: sourceText.length, module: moduleText.length } } }
}

// After several stages of one function have been moved, each call site carries its
// own block of accessors. This rewrites the file so that the stages called from one
// block share a single accessor object, and the modules are required at the top.
// Only text written by extractStage is touched.
function mergeStageWiring (text) {
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  let source = text.split('\r\n').join('\n')
  const WIRING = /^([ \t]*)\/\/ This stage lives in ([\w-]+)\.js\. It reads and writes these locals through accessors\.\n(?:\1let ([^\n]+)\n)?\1((?:const \w+ = )?(?:await )?)require\('(\.\/[\w./-]+)'\)\.(\w+)\((rt, )?\{\n((?:\1  get [^\n]*\n)*)\1\}\)\n((?:\1if \(\w+ && 'value' in \w+\) return \w+\.value\n|\1if \(\w+\?\.flow === '[\w ]+'\) [\w ]+\n)*)/gm
  const found = [...source.matchAll(WIRING)].map(match => ({ index: match.index, length: match[0].length, pad: match[1], lets: match[3] ? match[3].split(', ') : [], head: match[4], path: match[5], name: match[6], rt: !!match[7], accessors: match[8].split('\n').filter(Boolean).map(line => /get (\w+) \(\) \{ return \1 \}(, set \1 \(\$value\) \{ \1 = \$value \})?/.exec(line)).map(found => ({ name: found[1], write: !!found[2] })), tail: match[9] }))
  if (!found.length) return text
  const groups = []
  for (const item of found) {
    // The nearest earlier group at the same indentation that the text in between has not left.
    const stays = group => { const last = group.at(-1); return last.pad === item.pad && !source.slice(last.index + last.length, item.index).split('\n').some(line => line.trim() && /^[ \t]*/.exec(line)[0].length < item.pad.length) }
    const group = groups.findLast(stays)
    if (group) group.push(item); else groups.push([item])
  }
  const taken = new Set(source.match(/\bvars\d*_*\b/g) ?? [])
  const edits = []
  groups.forEach((group, index) => {
    let label = index ? `vars${index + 1}` : 'vars'
    while (taken.has(label)) label += '_'
    const pad = group[0].pad, names = new Map()
    for (const item of group) for (const accessor of item.accessors) names.set(accessor.name, names.get(accessor.name) || accessor.write)
    const lets = group.flatMap(item => item.lets)
    const sorted = [...names].sort(([a], [b]) => a.localeCompare(b))
    const shared = [
      `${pad}// The stages called in this block live in modules of their own (scripts/extract-stage.js).`,
      `${pad}// \`${label}\` reads and writes this function's locals at the moment of use.`,
      ...(lets.length ? [`${pad}let ${lets.join(', ')}`] : []),
      `${pad}const ${label} = {`,
      ...sorted.map(([name, write], i) => `${pad}  get ${name} () { return ${name} }${write ? `, set ${name} ($value) { ${name} = $value }` : ''}${i < sorted.length - 1 ? ',' : ''}`),
      `${pad}}`, ''
    ].join('\n')
    group.forEach((item, position) => edits.push({ pos: item.index, end: item.index + item.length, text: `${position ? '' : shared}${pad}${item.head}${item.name}(${item.rt ? 'rt, ' : ''}${label})\n${item.tail}` }))
  })
  for (const edit of edits.sort((a, b) => b.pos - a.pos)) source = source.slice(0, edit.pos) + edit.text + source.slice(edit.end)
  const requires = found.map(item => `const { ${item.name} } = require('${item.path}')`).join('\n') + '\n'
  const strict = /^'use strict'\n+/.exec(source)
  const at = strict ? strict[0].length : 0
  const comments = /^(?:\/\/[^\n]*\n)*\n?/.exec(source.slice(at))[0].length
  source = source.slice(0, at + comments) + requires + '\n' + source.slice(at + comments)
  return source.split('\n').join(nl)
}

if (require.main === module && process.argv.includes('--merge')) {
  const option = name => process.argv.find(argument => argument.startsWith(`--${name}=`))?.slice(name.length + 3)
  const file = path.resolve(option('root') ?? path.resolve(__dirname, '..'), option('file') ?? '')
  if (!option('file') || !fs.existsSync(file)) { console.error('usage: node scripts/extract-stage.js --merge --file=src/x.js [--root=<checkout>]'); process.exit(2) }
  const before = fs.readFileSync(file, 'utf8'), after = mergeStageWiring(before)
  fs.writeFileSync(file, after)
  console.log(JSON.stringify({ file, bytes: { before: before.length, after: after.length } }))
} else if (require.main === module) {
  const option = name => process.argv.find(argument => argument.startsWith(`--${name}=`))?.slice(name.length + 3)
  const root = path.resolve(option('root') ?? path.resolve(__dirname, '..'))
  const file = path.resolve(root, option('file') ?? '').replaceAll('\\', '/'), subdirectory = option('dir') ?? ''
  const [a, b] = [Number(process.argv[2]), Number(process.argv[3])], [moduleName, functionName] = process.argv.slice(4, 6)
  if (!option('file') || !fs.existsSync(file) || !Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < a || ![moduleName, functionName].every(name => /^[A-Za-z][\w-]*$/.test(name ?? '')) || !/^(?:[a-z][\w-]*(?:\/[a-z][\w-]*)*)?$/.test(subdirectory)) {
    console.error('usage: node scripts/extract-stage.js <startLine> <endLine> <module> <function> --file=src/x.js [--dir=sub] [--as=st] [--root=<checkout>] [--apply]'); process.exit(2)
  }
  const apply = process.argv.includes('--apply')
  const { moduleText, sourceText, summary } = extractStage({ file, text: fs.readFileSync(file, 'utf8'), startLine: a, endLine: b, moduleName, functionName, subdirectory, stateName: option('as') ?? 'st' })
  const out = apply ? path.dirname(file) : fs.mkdtempSync(path.join(os.tmpdir(), 'extract-stage-'))
  const moduleFile = path.join(out, apply ? subdirectory : '', `${moduleName}.js`)
  if (apply && fs.existsSync(moduleFile)) throw new Error(`${path.relative(root, moduleFile)} already exists`)
  fs.mkdirSync(path.dirname(moduleFile), { recursive: true })
  fs.writeFileSync(moduleFile, moduleText)
  fs.writeFileSync(path.join(out, path.basename(file)), sourceText)
  console.log(JSON.stringify({ written: out, ...summary }, null, 1))
}

module.exports = { extractStage, mergeStageWiring }
