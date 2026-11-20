'use strict'

// The crafting window, the table's open click and the placement's answer for a box of blocks (helpers/dig-world.js).
// Stand-ins for the server only: a craft takes its parts from the bag and gives the result, at the window the game
// asks for (a tool at a table); a placement is received and the item leaves the bag. Their success is not the game's.
// w.crafted: the outputs made, in order. w.asked: the crafts asked for. w.tables: where a block was put down.
const assert = require('node:assert/strict')

const full = name => 'minecraft:' + name
const TOOLS = { stone_pickaxe: { parts: [['cobblestone', 3], ['stick', 2]], uses: 131 }, stone_sword: { parts: [['cobblestone', 2], ['stick', 1]], uses: 131 } }

function attachBench (w, items, { craftFails = false } = {}) {
  const take = (name, n) => { for (const row of items) { if (!(name instanceof RegExp ? name.test(row.name) : row.name === full(name)) || !row.count) continue; const part = Math.min(n, row.count); row.count -= part; n -= part } if (n) throw new Error('材料が不足しています: ' + name) }
  const free = () => { for (let slot = 0; ; slot++) if (!items.some(item => item.slot === slot && item.count > 0)) return slot }
  const give = (name, n) => items.push({ slot: free(), name: full(name), count: n })
  w.crafted = []; w.asked = []; w.tables = []
  let open = null
  Object.assign(w.ctx.operations, {
    crafting: {
      closeContainer () { open = null },
      openInventory: async () => { open = 'inventory' },
      craft: async output => {
        w.asked.push(output)
        if (craftFails) throw new Error('サーバーから受信したレシピがありません: ' + output)
        const tool = TOOLS[output.replace('minecraft:', '')]
        if (/_planks$/.test(output)) { assert.ok(open, 'a window is open'); take(new RegExp(output.replace('_planks', '_log') + '$'), 1); give(output.replace('minecraft:', ''), 4) }
        else if (output === full('stick')) { assert.ok(open, 'a window is open'); take(/_planks$/, 2); give('stick', 4) }
        else if (output === full('crafting_table')) { assert.ok(open, 'a window is open'); take(/_planks$/, 4); give('crafting_table', 1) }
        else {
          assert.ok(tool, `a craft this bench knows: ${output}`)
          assert.equal(open, 'table', 'a tool is made at a table')
          for (const [part, n] of tool.parts) take(part, n)
          items.push({ slot: free(), name: output, count: 1, durabilityKnown: true, durabilityRemaining: tool.uses })
        }
        w.crafted.push(output)
      }
    },
    interactions: {
      ...w.ctx.operations.interactions,
      openCraftingTable: async at => {
        const feet = w.ctx.getFeet()
        assert.equal(w.getBlock(at.x, at.y, at.z).name, full('crafting_table'))
        assert.ok(Math.hypot(at.x + 0.5 - feet.x, at.y - feet.y, at.z + 0.5 - feet.z) <= 5)
        open = 'table'
      },
      // An ordinary placement: the block is received and the item leaves the bag.
      placeBlock: async ({ position, slot }) => { const row = items.find(item => item.slot === slot && item.count > 0); row.count--; w.put(position, row.name.replace('minecraft:', '')); w.tables.push(position) }
    }
  })
  return w
}

module.exports = { attachBench }
