'use strict'

// Why no melee stance was found: the refusals of the route previews and of the
// standing checks, counted, so the reason of a failed approach names its cause.
// Live 2026-11-19 06:15-06:25 JST: fourteen approaches to a skeleton (3.6-11.4 m)
// and a witch (6.7 m) ended with "No known bounded melee stance", one in 40 ms,
// with nothing in the log about what refused them; the witch killed the Bot
// without one sword hit.
function approachWhy () {
  const reasons = new Map()
  let looked = 0, standing = 0
  const note = preview => {
    looked++
    if (preview?.ready !== true) { const reason = String(preview?.reason ?? 'no route').slice(0, 90); reasons.set(reason, (reasons.get(reason) ?? 0) + 1) }
    return preview
  }
  const stand = () => { standing++ }
  function text () {
    const top = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([reason, count]) => `${reason} x${count}`)
    return ` (routes ${looked}, no standing ${standing}${top.length ? ': ' + top.join('; ') : ''})`
  }
  return { note, stand, text }
}

module.exports = { approachWhy }
