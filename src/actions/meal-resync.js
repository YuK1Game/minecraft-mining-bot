'use strict'
// A meal refused because the inventory is not confirmed by the server asks the server for the inventory again.
// 2026-11-19 07:52-07:54 JST real Realm: a code reload interrupted a meal; for two and a half minutes the idle meal
// answered "サーバーで確定した持ち物が必要です。" once a minute with two cooked chickens in the pack, at health 7, and
// the Bot died of the next hit. Nothing asked the server again while it waited.
// The request is the ordinary resync (it carries no predicted contents); only a received inventory clears the doubt.
const REST_MS = 20000

function createMealResync ({ request, log = () => {}, now = () => Date.now() }) {
  let askedAt = -Infinity
  return function mealRefused (error) {
    if (error?.code !== 'INVENTORY_UNKNOWN') return false
    const t = now()
    if (t - askedAt < REST_MS) return false
    askedAt = t
    try {
      const sent = request('idle_meal')
      if (sent && typeof sent.catch === 'function') sent.catch(() => {})
      log('食事: 持ち物が未確定のため、サーバーから持ち物を受信し直します')
      return true
    } catch { return false }
  }
}

module.exports = { createMealResync, REST_MS }
