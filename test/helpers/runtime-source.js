'use strict'

// Some tests assert on the runtime's source text, evaluate pieces of it, or
// compile an instrumented copy. Parts of runtime.js (and quarry-job.js) live in
// modules of their own (scripts/extract-runtime-block.js): there each use of a
// binding of the old closure is written rt.<name>, and the source file reads
// their values back as <instance>.<name> behind a block of accessors.
//
// runtimeSource() undoes that move in text: every moved block is put back
// where its accessor block stands, without the prefixes. The result is one
// file that reads, and runs, as the code did before it was split, so those
// tests keep describing the behaviour rather than the file layout. The split
// modules themselves are exercised by every test that loads the real runtime.
const fs = require('node:fs')
const path = require('node:path')
const src = path.resolve(__dirname, '..', '..', 'src')
// Comment lines, the accessor block, then the one-line wrappers of a moved part.
const WIRING = /((?:^[ \t]*\/\/[^\n]*\n){0,3})^([ \t]*)const (\w+) = require\('(\.\.?\/[\w./-]+)'\)\.(\w+)\(\{\n(?:^\2  get [^\n]*\n)+^\2\}\)\n((?:^\2function \w+ \(\.\.\.args\) \{ return \3\.\w+\(\.\.\.args\) \}\n)*)/m
const unix = text => text.split('\r\n').join('\n')

// Source files are addressed by base name; each name exists once under src/.
function sourceFile (name) {
  const found = []
  ;(function walk (directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(directory, entry.name))
      else if (entry.name === name) found.push(path.join(directory, entry.name))
    }
  })(src)
  if (found.length !== 1) throw new Error(`${name} is ${found.length ? 'not unique' : 'missing'} under src/`)
  return found[0]
}

// Stages of a large function live in modules of their own too
// (scripts/extract-stage.js): the function calls them one after another and
// hands each the same accessor object for its locals. inlineStages() puts the
// stages back between those calls: st.<name> becomes <name>, `return { value: x }`
// becomes `return x`, and `return { flow: 'continue' }` becomes `continue`.
// A variable that a stage declares for later stages stays declared before the
// first stage and is assigned where it was declared; everything else reads as
// it did before the move.
const STAGE_REQUIRE = /^const \{ (\w+) \} = require\('(\.\/[\w./-]+)'\)\n/gm
const STAGE_HEADER = '// A stage of '
function stageBody (file, name) {
  const ts = require('typescript')
  const text = unix(fs.readFileSync(file, 'utf8'))
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true)
  const fn = sf.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name)
  if (!fn) throw new Error(`${path.basename(file)} does not declare the stage ${name}`)
  const state = fn.parameters.at(-1).name.text, edits = [], declared = new Set()
  const isFunction = node => ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)
  ;(function visit (node, depth) {
    if (depth === 0 && ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression) && node.expression.properties.length === 1 && ts.isPropertyAssignment(node.expression.properties[0])) {
      const property = node.expression.properties[0], value = property.initializer
      if (property.name.getText(sf) === 'value') edits.push({ pos: node.getStart(sf), end: node.expression.getEnd(), text: value.getText(sf) === 'undefined' ? 'return' : `return ${text.slice(value.getStart(sf), value.getEnd())}`, inner: [value.getStart(sf), value.getEnd()] })
      if (property.name.getText(sf) === 'flow' && ts.isStringLiteral(value)) edits.push({ pos: node.getStart(sf), end: node.expression.getEnd(), text: value.text })
    }
    ts.forEachChild(node, child => visit(child, depth + (isFunction(node) && node !== fn ? 1 : 0)))
  })(fn, 0)
  const open = fn.body.getStart(sf) + 1, close = fn.body.getEnd() - 1
  let body = text.slice(open, close)
  for (const edit of edits.sort((a, b) => b.pos - a.pos)) body = body.slice(0, edit.pos - open) + edit.text + body.slice(edit.end - open)
  // `st.x = x` only hands a constant or a function of the stage to later stages: written
  // after the declaration (`…; st.x = x`, or ` st.x = x;` where the statement ended in a
  // semicolon), or on a line of its own at the top for a function.
  const handed = (whole, name) => { declared.add(name); return '' }
  body = body.replace(new RegExp(`; ${state}\\.(\\w+) = \\1\\b(?!\\.)`, 'g'), handed).replace(new RegExp(` ${state}\\.(\\w+) = \\1;`, 'g'), handed).replace(new RegExp(`^[ \\t]*${state}\\.(\\w+) = \\1\\n`, 'gm'), handed)
  body = body.replace(/^\n/, '').replace(/\n[ \t]*\n*$/, '\n')
  return { state, declared, body: body.replace(new RegExp(`\\b(\\w+): ${state}\\.\\1(?=\\s*[,}])`, 'g'), '$1').replace(new RegExp(`\\b${state}\\.`, 'g'), '') }
}
function inlineStages (source, directory) {
  let text = unix(source)
  const stages = new Map()
  text = text.replace(STAGE_REQUIRE, (line, name, relative) => {
    const file = path.resolve(directory, `${relative}.js`)
    if (!fs.existsSync(file) || !unix(fs.readFileSync(file, 'utf8')).includes(STAGE_HEADER)) return line
    stages.set(name, stageBody(file, name)); return ''
  })
  if (!stages.size) return text
  const declared = new Set([...stages.values()].flatMap(stage => [...stage.declared]))
  // The accessor object of a block: keep only the declaration of variables that stages assign.
  text = text.replace(/^([ \t]*)\/\/ The stages called in this block live in modules of their own \(scripts\/extract-stage\.js\)\.\n\1\/\/ `\w+` reads and writes this function's locals at the moment of use\.\n(?:\1let ([^\n]+)\n)?\1const \w+ = \{\n(?:\1  get [^\n]*\n)*\1\}\n/gm, (whole, pad, lets) => {
    const kept = (lets ?? '').split(', ').filter(name => name && !declared.has(name))
    return kept.length ? `${pad}let ${kept.join(', ')}\n` : ''
  })
  // Each call, with the lines that act on what it returned.
  text = text.replace(/^([ \t]*)(?:const (\w+) = )?(?:await )?(\w+)\((?:rt, )?\w+\)\n((?:\1if \(\w+ && 'value' in \w+\) return \w+\.value\n|\1if \(\w+\?\.flow === '[\w ]+'\) [\w ]+\n)*)/gm, (whole, pad, result, name) => stages.has(name) ? stages.get(name).body : whole)
  return text
}

function movedBody (file, factory) {
  const text = inlineStages(fs.readFileSync(file, 'utf8'), path.dirname(file))
  const start = text.indexOf(`function ${factory} (rt) {\n`), end = text.lastIndexOf('\n  return {\n')
  if (start < 0 || end < start) throw new Error(`${path.basename(file)} does not have the layout written by extract-runtime-block.js`)
  return text.slice(start + `function ${factory} (rt) {\n`.length, end + 1)
    .replace(/\b(\w+): rt\.\1(?=\s*[,}])/g, '$1') // a shorthand property the move had to spell out (not `name: rt.name.x`)
    .replace(/\brt\./g, '')
}

// Puts every moved part of a source text back in place. `directory` is where
// that source file lives; its parts are required relative to it.
function flattenText (source, directory = src) {
  let text = inlineStages(source, directory)
  const instances = []
  for (let match; (match = WIRING.exec(text));) {
    instances.push(match[3])
    text = text.slice(0, match.index) + movedBody(path.resolve(directory, `${match[4]}.js`), match[5]) + text.slice(match.index + match[0].length)
  }
  if (instances.length) text = text.replace(new RegExp(`\\b(\\w+): (?:${instances.join('|')})\\.\\1(?=\\s*[,}])`, 'g'), '$1').replace(new RegExp(`\\b(?:${instances.join('|')})\\.(?=[A-Za-z_$])`, 'g'), '')
  return text
}
function flattenedSource (name) { const file = sourceFile(name); return flattenText(fs.readFileSync(file, 'utf8'), path.dirname(file)) }
const runtimeSource = () => flattenedSource('runtime.js')
// For tests that accept a staged runtime file through an environment variable.
const runtimeSourceOr = staged => staged ? fs.readFileSync(staged, 'utf8') : runtimeSource()

module.exports = { runtimeSource, runtimeSourceOr, flattenedSource, flattenText, sourceFile, inlineStages }
