'use strict'

// Only the expedition can announce a completed working step. Periodic player
// ticks still check safety and condition-based retries while no fast tick runs.
function createDragonContinuation ({ active, disposed = () => false, tick, schedule = setTimeout, unschedule = clearTimeout }) {
  let timer = null
  function clear () { if (timer != null) { unschedule(timer); timer = null } }
  function onStepDone (info) {
    if (disposed() || !active() || timer != null) return
    timer = schedule(() => {
      timer = null
      if (!disposed() && active()) tick()
    }, info?.ms >= 100 ? 100 : 400)
    timer?.unref?.()
  }
  return { clear, onStepDone }
}

module.exports = { createDragonContinuation }
