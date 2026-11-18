'use strict'

// Whether a long trip that finds no way on in any direction ends there with
// its reason (LONG_TRAVEL_BLOCKED) instead of trying the same directions
// again every ten seconds. In player play it ends: the job that asked for the
// trip decides what comes next (a route that digs and stacks, another side,
// holding the goal). User 2026-11-18: 「永遠にルート探す仕様は辞めてください」.
// Real Realm 2026-11-18 15:30:44-15:34:46 JST: from the same feet (-4905.5,
// 89.0, -4991.4), 「区間を進めませんでした」 1-6, 「どの方向にも進めませんでした。
// 10秒後にもう一度試します」, 1-6 again, walked 0.0 m, until the return cut the
// trip after four minutes.
// A trip started by hand or by the quarry keeps trying, as before.
function stopsWhenBlocked (shared) {
  return shared?.playerWanted === true
}

module.exports = { stopsWhenBlocked }
