'use strict'

// Hanging and climbing plants a sword swing passes through.
//
// The melee sight lets air, water and the listed floor plants through and
// stops at every other block. Vines have no collision shape either, and a
// shaft or cave wall hung with them is where mobs stand: the swing was refused
// as LOS_BLOCKED with the mob two metres away (real Realm 2026-11-19
// 14:11:47-14:12:52 JST: in a vine shaft a skeleton at 2.1-4.2 m shot eight
// times, twelve fights ended before a single swing, eight of them with
// preview=LOS_BLOCKED; 02:15-02:27 JST: a pig under vines was never hit).
// Only blocks the received registry gives an empty bounding box count; the
// callers keep that check.
const CLIMBERS = ['vine', 'glow_lichen', 'cave_vines', 'cave_vines_body_with_berries', 'cave_vines_head_with_berries', 'weeping_vines', 'twisting_vines', 'hanging_roots', 'pale_hanging_moss'].map(name => `minecraft:${name}`)

module.exports = { CLIMBERS }
