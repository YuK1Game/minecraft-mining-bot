'use strict'

// Is one of the ordinary player jobs doing something right now?
// The expedition waits for them before it acts. A job that only holds a
// purpose (the return goal waiting between ticks) is not doing anything: its
// tick is not called while the expedition owns the work, so waiting for it
// never ends (live 2026-11-19 13:15:53-13:22 JST: the house repair was given
// up, the expedition took the work back, the return goal stayed "active"
// after its trip was interrupted, and the expedition showed 「進行中の移動・収納・
// 戦闘が終わるのを待っています。」 with nothing moving and no line in the log).
// - A job that reports `working` is busy only while an operation is in flight.
// - Every other job is busy while it is active, as before.
const busy = task => { const s = task.status(); return (typeof s?.working === 'boolean' ? s.working : s?.active) === true }
function crewBusy (crew) {
  return crew.some(busy)
}
// Which one, by the name the log gives it (decision-journal.js `owner`); null with none busy.
const crewBusyName = (crew, names) => { const at = crew.findIndex(busy); return at < 0 ? null : names[at] ?? 'ほかの作業' }

module.exports = { crewBusy, crewBusyName }
