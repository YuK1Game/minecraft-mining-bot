'use strict'

// Reconcile the received furnace before asking for more supplies. An interrupted
// cook can leave any of its three slots occupied, or fuel already burning. The
// inventory increase is the result; putting an item in is not a finished cook.
function createHouseSmelt ({ operations, items, count, inventoryReady, until, patient, close, refused, disposed }) {
  const furnace = operations.furnace
  const snapshot = () => furnace?.snapshot?.()
  const held = index => snapshot()?.slots?.find(slot => slot.slot === index)
  const stack = name => items().find(item => item?.name === name && item.count > 0)
  const ready = () => !disposed() && inventoryReady() && snapshot()?.contentsKnown === true
  const burning = () => held(1)?.count > 0 || snapshot()?.progress?.burnTicksRemaining > 0
  let needed = null

  async function run (at, request) {
    needed = null
    // Unknown rows cannot establish the before-count. Learning already owned
    // food while opening the furnace is not the result of this cook.
    if (disposed() || !inventoryReady()) {
      if (!disposed()) refused(new Error('持ち物の受信を確認できません'))
      return { checked: false, produced: 0, needed }
    }
    const accepts = request.accepts ?? (name => name === request.output)
    const before = count(accepts)
    let checked = false, taken = 0
    const work = async () => {
      if (disposed()) return
      await patient(() => operations.interactions.openFurnace(at))
      if (!await until(ready, 4000) || !ready()) throw new Error(inventoryReady() ? 'かまどの3枠の受信を確認できません' : '持ち物の受信を確認できません')
      checked = true
      const previous = held(0)
      const input = request.resume ? request.outputOf(previous?.name) && previous.name : request.input
      const output = request.resume ? request.outputOf(input) : request.output
      const amount = request.resume ? Math.min(3, previous?.count ?? 0) : request.amount
      // A resume only handles the requested kind of leftovers. It does not turn
      // a food inspection into a new ore cook or insert another stack of meat.
      if (request.resume && !input && !accepts(held(2)?.name)) return
      const take = async () => {
        if (!ready()) return
        const result = { ...held(2) }
        if (result?.count > 0) {
          await furnace.takeOutput({ count: result.count, expectedName: result.name })
          if (accepts(result.name)) taken += result.count
        }
      }
      await take()
      if (!ready()) return
      // A ready result can satisfy the entire request without input or fuel.
      const left = Math.max(0, amount - (count(accepts) - before))
      if (!input || !left) return
      const remaining = held(0)
      const other = remaining?.count > 0 && remaining.name !== input ? remaining : null
      const already = !other && remaining?.name === input ? remaining.count : 0
      const wanted = Math.max(0, left - already)
      const carried = request.resume ? null : stack(input)
      const insert = Math.min(wanted, carried?.count ?? 0)
      needed = { input: request.resume ? 0 : Math.max(0, wanted - insert), fuel: !burning() }
      if (!(other || already > 0 || insert > 0)) return
      // Keep raw items in hand when nothing can burn. On the next look the
      // planner can fetch fuel without mistaking a deposited input for no meat.
      const fuel = stack(request.fuel)
      if (!burning() && !fuel) return
      if (insert > 0 && !other && ready()) await furnace.putInput(carried.slot, insert)
      if (!ready()) return
      if (!burning()) {
        const supply = stack(request.fuel)
        if (supply) await furnace.putFuel(supply.slot, Math.min(request.fuelCount, supply.count))
      }
      if (!ready()) return
      if (other) {
        await until(() => !ready() || !(held(0)?.count > 0), Math.min(180000, other.count * 11000 + 5000))
        if (ready()) refused(new Error(held(0)?.count > 0 ? `かまどに残っている ${other.name} の調理が終わりません` : `かまどに残っていた ${other.name} を先に焼きました`))
      } else {
        const expected = Math.min(left, already + insert)
        try { await furnace.waitOutput(output, expected, { timeoutMs: Math.min(180000, expected * 11000 + 5000) }) } catch (error) { if (!disposed()) refused(error) }
      }
      await take()
      if (ready()) needed = { input: Math.max(0, amount - (count(accepts) - before) - (held(0)?.name === input ? held(0).count : 0)), fuel: held(0)?.count > 0 && !burning() }
    }
    try { await work() } catch (error) { if (!disposed()) refused(error) } finally { close() }
    if (taken) await until(() => disposed() || inventoryReady() && count(accepts) > before, 3000)
    return { checked, produced: inventoryReady() ? Math.max(0, Math.min(taken, count(accepts) - before)) : 0, needed }
  }

  return {
    smelt: async (at, input, amount, fuel, fuelCount, output) => (await run(at, { input, amount, fuel, fuelCount, output })).produced,
    resumeSmelt: (at, { outputOf, accepts, fuel = null, fuelCount = 1 }) => run(at, { resume: true, outputOf, accepts, fuel, fuelCount }),
    smeltNeed: () => needed
  }
}

module.exports = { createHouseSmelt }
