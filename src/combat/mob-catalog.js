'use strict'

// Type identity is shared by receipt classification, danger observation and
// attack controllers. A potential hostile is NOT permission to attack it.
// Preserve the existing observation coverage; a design-only profile must not
// turn a neutral or otherwise unclassified received actor into a hostile.
const WHEN_NEEDED = 'when_needed_and_safe'
const SELF_DEFENSE = 'self_defense_only'
const entries = Object.create(null)
function define (engagement, routine, names, observation = 'hostile') {
  for (const name of names) entries[`minecraft:${name}`] = {
    observation,
    combat: Object.freeze({ engagement, routine }),
    avoidance: observation === 'hostile' ? 'melee' : null,
    attackAccess: 'enemy_walk_route', recognitionRadius: 12
  }
}
define(WHEN_NEEDED, 'melee_kite', ['zombie', 'zombie_villager', 'zombie_villager_v2', 'husk', 'spider', 'breeze'])
define(WHEN_NEEDED, 'underwater_cover', ['drowned', 'guardian'])
define(WHEN_NEEDED, 'underwater_cover', ['zombie_nautilus'], 'unclassified')
define(WHEN_NEEDED, 'ranged_cover', ['skeleton', 'stray', 'bogged', 'witch', 'pillager', 'blaze'])
define(WHEN_NEEDED, 'ranged_cover', ['parched'], 'unclassified')
define(WHEN_NEEDED, 'special_objective', ['creeper', 'shulker'])
define(WHEN_NEEDED, 'fast_small_intercept', ['cave_spider', 'silverfish', 'endermite'])
define(WHEN_NEEDED, 'split_cleanup', ['slime', 'magma_cube'])
define(WHEN_NEEDED, 'aerial_intercept', ['phantom', 'vex', 'ghast'])
define(WHEN_NEEDED, 'ranged_terrain_isolation', ['vindicator', 'ravager', 'wither_skeleton', 'hoglin', 'zoglin', 'piglin_brute'])
define(WHEN_NEEDED, 'ranged_terrain_isolation', ['camel_husk', 'zombie_horse'], 'unclassified')
define(WHEN_NEEDED, 'summon_source_focus', ['evocation_illager'])
define('prepared_expedition_only', 'avoid', ['elder_guardian'])
define('avoid_unless_hostile_or_objective', 'melee_kite', ['piglin'], 'neutral')
define('self_defense_or_explicit_objective', 'melee_kite', ['zombie_pigman'], 'neutral')
define('self_defense_or_explicit_objective', 'melee_kite', ['zombified_piglin'], 'unclassified')
define('avoid_unless_hostile_or_prepared_objective', 'no_ranged_no_gaze', ['enderman'], 'neutral')
define('dedicated_prepared_mission', 'avoid', ['ender_dragon'])
define('dedicated_verified_bedrock_mission', 'avoid', ['wither'])
define('do_not_engage', 'avoid', ['warden'])
define('avoid_or_special_objective', 'avoid', ['creaking'])
define('hazard_avoidance_only', 'avoid', ['sulfur_cube'], 'unclassified')
define(SELF_DEFENSE, 'melee_kite', ['iron_golem', 'wolf', 'bee', 'polar_bear', 'llama', 'trader_llama', 'dolphin', 'panda', 'goat'], 'neutral')
define(SELF_DEFENSE, 'melee_kite', ['nautilus'], 'unclassified')

// Existing passive receipt coverage. Passive observations never inherit a
// combat profile or attack permission from similarly named hostile types.
for (const name of ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'horse', 'donkey', 'mule', 'camel', 'mooshroom', 'cat', 'ocelot', 'fox', 'bat', 'parrot', 'allay', 'axolotl', 'turtle', 'squid', 'glow_squid', 'cod', 'salmon', 'tropicalfish', 'pufferfish', 'villager', 'villager_v2', 'wandering_trader', 'snow_golem', 'strider', 'frog', 'tadpole', 'sniffer', 'armadillo']) entries[`minecraft:${name}`] = { observation: 'passive', combat: null, avoidance: null, attackAccess: null, recognitionRadius: null }

function details (names, values) {
  for (const name of names) Object.assign(entries[`minecraft:${name}`], values)
}
details(['skeleton', 'stray', 'bogged'], { avoidance: 'archer' })
details(['zombie', 'zombie_villager', 'zombie_villager_v2', 'husk', 'spider'], { learning: 'melee' })
details(['skeleton', 'stray', 'bogged'], { learning: 'archer' })
details(['pillager', 'witch', 'drowned'], { learning: 'ranged' })
details(['skeleton', 'stray', 'bogged', 'parched', 'witch'], { attackAccess: 'projectile_sight', recognitionRadius: 18 })
details(['witch', 'pillager', 'breeze', 'shulker', 'guardian', 'drowned', 'evocation_illager', 'piglin', 'llama', 'trader_llama'], { attackAccess: 'projectile_sight' })
details(['breeze', 'shulker', 'drowned', 'evocation_illager', 'piglin', 'llama', 'trader_llama'], { recognitionRadius: 24 })
details(['creeper', 'pillager', 'guardian'], { recognitionRadius: 16 })
details(['phantom', 'vex', 'ghast', 'blaze'], { attackAccess: 'flight_sight_proxy', recognitionRadius: 32 })
for (const name of ['creeper', 'witch', 'pillager', 'drowned', 'breeze', 'blaze', 'ghast', 'guardian', 'elder_guardian', 'evocation_illager', 'phantom', 'shulker']) details([name], { avoidance: name })
details(['warden', 'wither', 'ender_dragon'], { avoidance: 'boss' })
for (const entry of Object.values(entries)) Object.freeze(entry)
Object.freeze(entries)

const COMBAT_PROFILES = Object.freeze(Object.fromEntries(Object.entries(entries).filter(([, entry]) => entry.combat).map(([type, entry]) => [type, entry.combat])))
const mobType = type => entries[type] ?? null
const isKnownMobType = type => { const entry = mobType(type); return entry != null && entry.observation !== 'unclassified' }
const isPotentialHostileType = type => mobType(type)?.observation === 'hostile'
const isAttackableHostileType = type => isPotentialHostileType(type) && mobType(type)?.combat?.engagement === WHEN_NEEDED

module.exports = { WHEN_NEEDED, SELF_DEFENSE, COMBAT_PROFILES, mobType, isKnownMobType, isPotentialHostileType, isAttackableHostileType }
