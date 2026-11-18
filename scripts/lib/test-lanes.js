'use strict'

// Which test files belong to the two strict lanes (`npm run test:review`,
// `npm run test:player`). Both lanes fail on any failure, and CI runs them on
// every push, so the comparison of the complete suite (`npm run test:compare`,
// which only looks for *new* failures) does not run those files a second time.
const fs = require('node:fs')
const path = require('node:path')

const REVIEW = /^(?:review-|dashboard-control|loadout-).*\.test\.js$/
// Existing tests the review lane keeps as compatibility checks, in the order they run.
const REVIEW_NAMED = ['manual-chest-deposit.test.js', 'manual-chest-runtime-adapter.test.js', 'quarry-v22-reset.test.js', 'quarry-v22-reset-complete.test.js', 'quarry-supply-job.test.js', 'quarry-supply-portable.test.js', 'quarry-supplies.test.js', 'inventory-inspection.test.js', 'runtime-combat-priority.test.js', 'initial-life-receipt.test.js', 'combat-coordinator.test.js', 'quarry-job.test.js', 'quarry-runtime-adapter.test.js', 'idle-safety-armed-continuation.test.js', 'quarry-carried-storage.test.js', 'quarry-observed-placement-job.test.js', 'quarry-source-rejection.test.js', 'quarry-storage-reachability.test.js', 'quarry-pillar-exit.test.js', 'quarry-egress-runtime.test.js', 'dashboard-state.test.js', 'dashboard-depot-state.test.js', 'dashboard.test.js', 'host-packets.test.js', 'keep-alive.test.js', 'hotreload.test.js', 'hotreload-content-filter.test.js', 'quarry-debug-site.test.js', 'quarry-v22-reset-site.test.js', 'quarry-initial-loadout.test.js', 'quarry-v22-chest-work.test.js', 'chest.test.js', 'chest-withdrawal.test.js', 'chest-withdrawal-response.test.js']
const PLAYER = /^(?:player-|house-|bot-mode|mode-|travel-dry-start|damage-note|low-block|ground-refresh).*\.test\.js$/
// A file with a failure older than the player lane: named with its reason, kept out of the lane, still compared with the base.
const PLAYER_EXCLUDED = {
  'player-drop-access.test.js': '2 failures on main before this lane existed (e275fd0): the way to a dropped item, not the return to the base'
}

const names = root => fs.existsSync(path.join(root, 'test')) ? fs.readdirSync(path.join(root, 'test')).filter(name => /\.test\.js$/.test(name)).sort() : []
// A long file that runs as several processes brings its part files (name.partN.test.js) with it.
const withParts = (name, all) => [name, ...all.filter(other => other.startsWith(`${name.slice(0, -'.test.js'.length)}.part`))]

// File names (inside test/) of the review lane, in the order they run. A named file that is missing stays in the list: the lane must fail, not shrink.
function reviewNames (root) {
  const all = names(root)
  const matched = all.filter(name => REVIEW.test(name))
  const named = REVIEW_NAMED.flatMap(name => withParts(name, all)).filter(name => !matched.includes(name))
  return [...matched, ...named]
}
function playerNames (root) {
  const all = names(root).filter(name => PLAYER.test(name))
  return { files: all.filter(name => !PLAYER_EXCLUDED[name]), excluded: PLAYER_EXCLUDED }
}
// 'test/<name>' of every file a strict lane runs.
const strictFiles = root => new Set([...reviewNames(root), ...playerNames(root).files].map(name => `test/${name}`))

module.exports = { reviewNames, playerNames, strictFiles }
