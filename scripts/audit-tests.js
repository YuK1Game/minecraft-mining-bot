'use strict'

// Static audit of test files to classify lane coverage, `.local/` helper
// dependencies, and legacy survival test footprints so pre-existing failures
// can be retired systematically without weakening assertions.
const fs = require('node:fs')
const path = require('node:path')
const { reviewNames, playerNames } = require('./lib/test-lanes')

const root = path.resolve(__dirname, '..')
const testDir = path.join(root, 'test')
const all = fs.readdirSync(testDir).filter(name => /\.test\.js$/.test(name)).sort()
const review = new Set(reviewNames(root))
const player = new Set(playerNames(root).files)

const localDeps = []
const survivalRefs = []
const unlaned = []

for (const name of all) {
  const text = fs.readFileSync(path.join(testDir, name), 'utf8')
  if (/require\([^)]*\.local\//.test(text) || /['"]\.local\/[^'"]+\.cjs['"]/.test(text)) {
    localDeps.push(name)
  }
  if (/require\([^)]*src\/survival\//.test(text) || /\.\.\/src\/survival\//.test(text)) {
    survivalRefs.push(name)
  }
  if (!review.has(name) && !player.has(name)) {
    unlaned.push(name)
  }
}

const report = {
  totalTestFiles: all.length,
  strictReviewFiles: review.size,
  strictPlayerFiles: player.size,
  compareOnlyFiles: unlaned.length,
  localCjsDependentFiles: localDeps,
  legacySurvivalDirectRefCount: survivalRefs.length
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`テスト棚卸し: 全 ${report.totalTestFiles} ファイル`)
  console.log(`  厳格レーン test:review : ${report.strictReviewFiles}`)
  console.log(`  厳格レーン test:player : ${report.strictPlayerFiles}`)
  console.log(`  全件比較対象           : ${report.compareOnlyFiles}`)
  console.log(`  .local/*.cjs 依存      : ${report.localCjsDependentFiles.length} (${report.localCjsDependentFiles.join(', ') || 'なし'})`)
  console.log(`  旧 src/survival/ 直接参照: ${report.legacySurvivalDirectRefCount}`)
}
