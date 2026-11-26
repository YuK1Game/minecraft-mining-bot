'use strict'

// Static audit of test files and module boundaries:
// 1) Classifies strict lanes (`test:review`, `test:player`) vs compare-only pool
// 2) Breaks down compare-only files into actionable triage buckets
// 3) Enforces zero `.local/` test dependencies and zero direct `src/survival/`
//    requires inside `src/modes/` when `--strict` is passed.
const fs = require('node:fs')
const path = require('node:path')
const { reviewNames, playerNames } = require('./lib/test-lanes')

const root = path.resolve(__dirname, '..')
const testDir = path.join(root, 'test')
const modesDir = path.join(root, 'src', 'modes')
const all = fs.readdirSync(testDir).filter(name => /\.test\.js$/.test(name)).sort()
const review = new Set(reviewNames(root))
const player = new Set(playerNames(root).files)

function walkJs (dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? walkJs(full) : entry.name.endsWith('.js') ? [full] : []
  })
}

const localDeps = []
const survivalRefs = []
const unlaned = []
const breakdown = {
  legacySurvival: 0,
  quarryCompare: 0,
  runtimeCompare: 0,
  activeSubsystems: 0
}

const LEGACY_SURVIVAL_NAME = /^(?:autonomy|diamond|depot|camp|owned|hut|shelter|foraging|runner|worksite|fresh-depot|portable-worksite|supply-return|surface-return)/

for (const name of all) {
  const text = fs.readFileSync(path.join(testDir, name), 'utf8')
  if (/require\([^)]*\.local\//.test(text) || /['"](?:\.\.\/|\.\/)?\.local\/[^'"]+\.(?:c?js|json)['"]/.test(text)) {
    localDeps.push(name)
  }
  const refsSurvival = /require\([^)]*src\/survival\//.test(text) || /\.\.\/src\/survival\//.test(text)
  if (refsSurvival) {
    survivalRefs.push(name)
  }
  if (!review.has(name) && !player.has(name)) {
    unlaned.push(name)
    if (refsSurvival || LEGACY_SURVIVAL_NAME.test(name)) breakdown.legacySurvival++
    else if (name.startsWith('quarry-')) breakdown.quarryCompare++
    else if (name.startsWith('runtime-')) breakdown.runtimeCompare++
    else breakdown.activeSubsystems++
  }
}

const modesDirectSurvivalRefs = []
for (const file of walkJs(modesDir)) {
  const text = fs.readFileSync(file, 'utf8')
  if (/require\(\s*['"][^'"]*survival\//.test(text)) {
    modesDirectSurvivalRefs.push(path.relative(root, file).replace(/\\/g, '/'))
  }
}

const report = {
  totalTestFiles: all.length,
  strictReviewFiles: review.size,
  strictPlayerFiles: player.size,
  compareOnlyFiles: unlaned.length,
  compareOnlyBreakdown: breakdown,
  localCjsDependentFiles: localDeps,
  legacySurvivalDirectRefCount: survivalRefs.length,
  modesDirectSurvivalRefs
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`テスト棚卸し: 全 ${report.totalTestFiles} ファイル`)
  console.log(`  厳格レーン test:review : ${report.strictReviewFiles}`)
  console.log(`  厳格レーン test:player : ${report.strictPlayerFiles}`)
  console.log(`  全件比較対象           : ${report.compareOnlyFiles} (旧サバイバル=${breakdown.legacySurvival}, 露天掘り比較=${breakdown.quarryCompare}, Runtime比較=${breakdown.runtimeCompare}, 現役サブシステム=${breakdown.activeSubsystems})`)
  console.log(`  .local/ helper/fixture依存: ${report.localCjsDependentFiles.length} (${report.localCjsDependentFiles.join(', ') || 'なし'})`)
  console.log(`  src/modes → src/survival 直接参照: ${report.modesDirectSurvivalRefs.length} (${report.modesDirectSurvivalRefs.join(', ') || 'なし'})`)
  console.log(`  旧 src/survival/ テスト参照: ${report.legacySurvivalDirectRefCount}`)
}

if (process.argv.includes('--strict') && (localDeps.length > 0 || modesDirectSurvivalRefs.length > 0)) {
  process.exitCode = 1
}
