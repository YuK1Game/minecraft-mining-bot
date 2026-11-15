'use strict'

// Some tests assert on the runtime's source text, evaluate pieces of it, or
// compile an instrumented copy. Parts of runtime.js now live in modules of
// their own (scripts/extract-runtime-block.js): there each use of a runtime
// binding is written rt.<name>, and runtime.js reads their values back as
// <instance>.<name> behind a block of accessors.
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
const WIRING = /((?:^[ \t]*\/\/[^\n]*\n){0,3})^([ \t]*)const (\w+) = require\('\.\/([\w-]+)'\)\.(\w+)\(\{\n(?:^\2  get [^\n]*\n)+^\2\}\)\n((?:^\2function \w+ \(\.\.\.args\) \{ return \3\.\w+\(\.\.\.args\) \}\n)*)/m

function movedBody (name, factory) {
  const text = fs.readFileSync(path.join(src, `${name}.js`), 'utf8').replace(/\r\n/g, '\n')
  const start = text.indexOf(`function ${factory} (rt) {\n`), end = text.lastIndexOf('\n  return {\n')
  if (start < 0 || end < start) throw new Error(`${name}.js does not have the layout written by extract-runtime-block.js`)
  return text.slice(start + `function ${factory} (rt) {\n`.length, end + 1)
    .replace(/\b(\w+): rt\.\1\b/g, '$1') // a shorthand property the move had to spell out
    .replace(/\brt\./g, '')
}

function runtimeSource () {
  let text = fs.readFileSync(path.join(src, 'runtime.js'), 'utf8').replace(/\r\n/g, '\n')
  const instances = []
  for (let match; (match = WIRING.exec(text));) {
    instances.push(match[3])
    text = text.slice(0, match.index) + movedBody(match[4], match[5]) + text.slice(match.index + match[0].length)
  }
  if (instances.length) text = text.replace(new RegExp(`\\b(\\w+): (?:${instances.join('|')})\\.\\1\\b`, 'g'), '$1').replace(new RegExp(`\\b(?:${instances.join('|')})\\.(?=[A-Za-z_$])`, 'g'), '')
  return text
}

module.exports = { runtimeSource }
