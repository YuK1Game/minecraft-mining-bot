/* Visual chest list & contents viewer mounted in #inventory. Minimal text, icon-first UI. */
(() => {
  'use strict'
  const panel = document.getElementById('inventory')
  if (!panel) return
  const head = panel.querySelector('.panel-title')
  const heading = document.getElementById('inventory-heading')
  if (!head || !heading) return

  const el = (tag, cls, text) => {
    const node = document.createElement(tag)
    if (cls) node.className = cls
    if (text != null) node.textContent = text
    return node
  }

  const NAMES = {
    dirt: '土', grass_block: '草ブロック', cobblestone: '丸石', stone: '石', deepslate: '深層岩',
    cobbled_deepslate: '深層岩の丸石', granite: '花崗岩', diorite: '閃緑岩', andesite: '安山岩',
    tuff: '凝灰岩', calcite: '方解石', coal: '石炭', charcoal: '木炭', iron_ingot: '鉄インゴット',
    raw_iron: '鉄の原石', gold_ingot: '金インゴット', raw_gold: '金の原石', raw_copper: '銅の原石',
    copper_ingot: '銅インゴット', diamond: 'ダイヤ', redstone: 'レッドストーン', lapis_lazuli: 'ラピス',
    emerald: 'エメラルド', stick: '棒', chest: 'チェスト', crafting_table: '作業台', furnace: 'かまど',
    torch: 'たいまつ', bow: '弓', arrow: '矢', shield: '盾', bread: 'パン', apple: 'リンゴ',
    cooked_beef: 'ステーキ', beef: '生牛肉', cooked_porkchop: '焼き豚', porkchop: '生豚肉',
    cooked_mutton: '焼いた羊肉', mutton: '生羊肉', cooked_chicken: '焼き鳥', rotten_flesh: '腐った肉',
    bucket: 'バケツ', water_bucket: '水バケツ', lava_bucket: '溶岩バケツ', ender_pearl: 'パール',
    obsidian: '黒曜石', sand: '砂', gravel: '砂利', flint: '火打石', bone: '骨', string: '糸',
    gunpowder: '火薬', oak_log: 'オーク原木', birch_log: '白樺原木', spruce_log: 'トウヒ原木',
    oak_planks: 'オーク板', birch_planks: '白樺板', cobblestone_slab: '丸石ハーフ', oak_slab: 'オークハーフ',
    white_wool: '白羊毛', ladder: 'はしご', leaf_litter: '落ち葉', oak_boat: 'ボート',
    iron_pickaxe: '鉄ツルハシ', stone_pickaxe: '石ツルハシ', diamond_pickaxe: 'ダイヤツルハシ',
    iron_sword: '鉄の剣', stone_sword: '石の剣', diamond_sword: 'ダイヤの剣',
    iron_helmet: '鉄兜', iron_chestplate: '鉄胸当て', iron_leggings: '鉄レギンス', iron_boots: '鉄ブーツ',
    golden_leggings: '金レギンス', golden_boots: '金ブーツ'
  }
  const bare = name => String(name || '').replace(/^minecraft:/, '')
  const labelOf = name => NAMES[bare(name)] ?? bare(name)
  const fmt = n => new Intl.NumberFormat('ja-JP').format(n)

  let textures = null
  let textureVersion = ''
  const loadTextures = async () => {
    try {
      const res = await fetch('/assets/minecraft/manifest.json', { cache: 'no-store' })
      if (!res.ok) return
      const m = await res.json()
      if (m?.version === 1 && m.items && typeof m.items === 'object') {
        textures = m.items
        const c = typeof m.source?.commit === 'string' ? m.source.commit.slice(0, 12) : ''
        textureVersion = /^[a-f0-9]{12}$/i.test(c) ? `?v=${c}` : ''
        render()
      }
    } catch { /* fallback to glyph */ }
  }

  const texSrc = name => {
    const src = textures?.[name]?.src
    if (typeof src !== 'string' || !/^\/assets\/minecraft\/textures\/(?:items|blocks)\/[a-zA-Z0-9_./-]+\.png$/.test(src)) return null
    return src + textureVersion
  }

  const makeIcon = (name, sizeClass = '') => {
    const src = texSrc(name)
    if (src) {
      const img = document.createElement('img')
      img.className = sizeClass ? `minecraft-texture ${sizeClass}` : 'minecraft-texture'
      img.src = src
      img.alt = ''
      img.decoding = 'async'
      img.draggable = false
      return img
    }
    return el('span', 'chest-slot-fallback', bare(name).slice(0, 2).toUpperCase() || '?')
  }

  // Tab switch in #inventory header
  const tabs = el('div', 'inv-tab-switch')
  tabs.setAttribute('role', 'tablist')
  tabs.setAttribute('aria-label', '所持品とチェストの切替')
  const tabInv = el('button', '', '所持品')
  tabInv.type = 'button'
  tabInv.setAttribute('role', 'tab')
  tabInv.setAttribute('aria-selected', 'true')
  const tabChests = el('button', '')
  tabChests.type = 'button'
  tabChests.setAttribute('role', 'tab')
  tabChests.setAttribute('aria-selected', 'false')
  const chestCountBadge = el('span', 'inv-tab-count', '0')
  tabChests.append(document.createTextNode('チェスト '), chestCountBadge)
  tabs.append(tabInv, tabChests)
  heading.after(tabs)

  // Chest workspace view
  const view = el('div', 'chest-view')
  const toolbar = el('div', 'chest-toolbar')
  const searchWrap = el('div', 'chest-search-wrap')
  const searchInput = el('input', 'chest-search')
  searchInput.type = 'search'
  searchInput.placeholder = 'アイテム・座標'
  searchInput.setAttribute('aria-label', 'チェスト内アイテムを検索')
  searchWrap.append(searchInput)

  const modeToggle = el('div', 'chest-mode-toggle')
  const btnGrid = el('button', '', '▦')
  btnGrid.type = 'button'; btnGrid.title = 'スロット表示'; btnGrid.setAttribute('aria-pressed', 'true')
  const btnList = el('button', '', '≡')
  btnList.type = 'button'; btnList.title = '集計表示'; btnList.setAttribute('aria-pressed', 'false')
  modeToggle.append(btnGrid, btnList)

  const kpis = el('div', 'chest-kpis')
  toolbar.append(searchWrap, modeToggle, kpis)

  const split = el('div', 'chest-split')
  const listEl = el('div', 'chest-list')
  listEl.setAttribute('role', 'listbox')
  listEl.setAttribute('aria-label', 'チェスト一覧')
  const detailEl = el('div', 'chest-detail')
  split.append(listEl, detailEl)
  view.append(toolbar, split)
  panel.append(view)

  let data = { chests: [] }
  let activeTab = 'inventory'
  let viewMode = 'grid'
  let selectedId = null
  let selectedSlot = null
  let query = ''
  let digest = ''
  let fetching = false

  const setTab = next => {
    activeTab = next
    panel.dataset.tab = next
    tabInv.setAttribute('aria-selected', String(next === 'inventory'))
    tabChests.setAttribute('aria-selected', String(next === 'chests'))
    if (next === 'chests') void fetchChests(true)
  }
  tabInv.addEventListener('click', () => setTab('inventory'))
  tabChests.addEventListener('click', () => setTab('chests'))

  btnGrid.addEventListener('click', () => {
    viewMode = 'grid'
    btnGrid.setAttribute('aria-pressed', 'true')
    btnList.setAttribute('aria-pressed', 'false')
    renderDetail()
  })
  btnList.addEventListener('click', () => {
    viewMode = 'summary'
    btnGrid.setAttribute('aria-pressed', 'false')
    btnList.setAttribute('aria-pressed', 'true')
    renderDetail()
  })
  searchInput.addEventListener('input', () => {
    query = searchInput.value.trim().toLowerCase()
    render()
  })

  const itemMatches = name => {
    if (!query || !name) return false
    const b = bare(name).toLowerCase()
    const l = labelOf(name).toLowerCase()
    return b.includes(query) || l.includes(query)
  }

  const chestMatches = c => {
    if (!query) return true
    const coords = `${c.position.x},${c.position.y},${c.position.z}`
    if (coords.includes(query) || c.dimension.includes(query)) return true
    return c.items.some(it => itemMatches(it.name))
  }

  const fillLevel = c => {
    const ratio = c.slotCount > 0 ? c.used / c.slotCount : 0
    return ratio >= 1 ? 'full' : ratio >= 0.78 ? 'warn' : 'ok'
  }

  const shortTime = jst => {
    if (!jst) return '—'
    const m = /(\d{2}:\d{2})/.exec(jst)
    return m ? m[1] : jst
  }

  function renderInspector (inspectorEl, item) {
    inspectorEl.replaceChildren()
    if (!item || !item.name) {
      inspectorEl.append(el('span', 'chest-inspector-id', 'スロットを選択'))
      return
    }
    inspectorEl.append(
      makeIcon(item.name),
      el('span', 'chest-inspector-name', labelOf(item.name)),
      el('span', 'chest-inspector-id', bare(item.name)),
      el('span', 'chest-inspector-qty', `×${fmt(item.count)}`)
    )
  }

  function renderDetail () {
    detailEl.replaceChildren()
    const filtered = data.chests.filter(chestMatches)
    const chest = filtered.find(c => c.id === selectedId) ?? filtered[0] ?? null
    if (!chest) {
      detailEl.append(el('div', 'chest-empty', data.chests.length ? '一致するチェストなし' : '記録されたチェストなし'))
      return
    }
    selectedId = chest.id

    const dHead = el('div', 'chest-detail-head')
    const dot = el('span', 'chest-dim-dot')
    dot.dataset.dim = chest.dimension
    const coordsText = `${chest.position.x}, ${chest.position.y}, ${chest.position.z}`
    const copyBtn = el('button', 'chest-copy-btn', '⧉')
    copyBtn.type = 'button'
    copyBtn.title = '座標をコピー'
    copyBtn.addEventListener('click', () => {
      navigator.clipboard?.writeText(`${chest.position.x} ${chest.position.y} ${chest.position.z}`).catch(() => {})
      copyBtn.textContent = '✓'
      setTimeout(() => { copyBtn.textContent = '⧉' }, 900)
    })
    dHead.append(
      dot,
      chest.role === 'base' ? el('span', 'chest-role-tag', '🏠') : document.createTextNode(''),
      el('span', 'chest-detail-coords', coordsText),
      copyBtn,
      el('span', 'chest-size-chip', chest.large ? `大 ${chest.used}/${chest.slotCount}` : `${chest.used}/${chest.slotCount}`),
      el('span', 'chest-time-chip', shortTime(chest.receivedAtJST))
    )

    const body = el('div', 'chest-detail-body')
    const inspector = el('div', 'chest-inspector')

    if (viewMode === 'grid') {
      const grid = el('div', 'chest-slot-grid')
      for (const s of chest.slots) {
        const hit = !!query && itemMatches(s.name)
        const dim = !!query && !hit && !!s.name
        const cls = ['chest-slot', !s.known ? 'unknown' : !s.name ? 'empty' : '', hit ? 'hit' : '', dim ? 'dim' : '', selectedSlot === s.slot ? 'active' : ''].filter(Boolean).join(' ')
        const cell = el('button', cls)
        cell.type = 'button'
        if (s.name) {
          cell.title = `${labelOf(s.name)} ×${s.count}`
          cell.append(makeIcon(s.name))
          if (s.count > 1) cell.append(el('span', 'chest-slot-qty', String(s.count)))
          cell.addEventListener('click', () => {
            selectedSlot = s.slot
            grid.querySelectorAll('.chest-slot.active').forEach(n => n.classList.remove('active'))
            cell.classList.add('active')
            renderInspector(inspector, s)
          })
        } else {
          cell.disabled = true
        }
        grid.append(cell)
      }
      body.append(grid)
      const activeItem = chest.slots.find(s => s.slot === selectedSlot && s.name) ?? chest.items[0] ?? null
      renderInspector(inspector, activeItem)
    } else {
      const sumGrid = el('div', 'chest-summary-grid')
      const items = query ? chest.items.filter(it => itemMatches(it.name)) : chest.items
      if (!items.length) {
        body.append(el('div', 'chest-empty', '空'))
      } else {
        for (const it of items) {
          const tile = el('div', `chest-sum-tile${query && itemMatches(it.name) ? ' hit' : ''}`)
          tile.title = `${labelOf(it.name)} (${bare(it.name)}) ×${it.count}`
          tile.append(makeIcon(it.name), el('span', 'chest-sum-name', labelOf(it.name)), el('span', 'chest-sum-qty', fmt(it.count)))
          sumGrid.append(tile)
        }
        body.append(sumGrid)
      }
      renderInspector(inspector, items[0] ?? null)
    }

    detailEl.append(dHead, body, inspector)
  }

  function render () {
    const all = data.chests ?? []
    chestCountBadge.textContent = String(all.length)
    const filtered = all.filter(chestMatches)
    const totalEmpty = all.reduce((s, c) => s + (c.empty ?? 0), 0)
    const totalSlots = all.reduce((s, c) => s + (c.slotCount ?? 0), 0)
    kpis.replaceChildren(
      el('span', 'chest-kpi', `${filtered.length}/${all.length} 箱`),
      el('span', `chest-kpi${totalEmpty === 0 && all.length ? ' warn' : ''}`, `空き ${totalEmpty}/${totalSlots}`)
    )

    if (!filtered.some(c => c.id === selectedId)) {
      selectedId = filtered[0]?.id ?? null
      selectedSlot = null
    }

    listEl.replaceChildren()
    if (!filtered.length) {
      listEl.append(el('div', 'chest-empty', all.length ? '該当なし' : 'チェスト未記録'))
      renderDetail()
      return
    }

    for (const c of filtered) {
      const card = el('button', 'chest-card')
      card.type = 'button'
      card.setAttribute('role', 'option')
      card.setAttribute('aria-selected', String(c.id === selectedId))

      const top = el('div', 'chest-card-top')
      const iconWrap = el('span', 'chest-card-icon')
      iconWrap.append(makeIcon('minecraft:chest'))
      const dot = el('span', 'chest-dim-dot')
      dot.dataset.dim = c.dimension
      const level = fillLevel(c)
      const cap = el('span', `chest-cap-text${level === 'full' ? ' full' : ''}`, `${c.used}/${c.slotCount}`)
      top.append(iconWrap, dot)
      if (c.role === 'base') top.append(el('span', 'chest-role-tag', '🏠'))
      top.append(el('span', 'chest-card-coords', `${c.position.x}, ${c.position.y}, ${c.position.z}`), cap)

      const bar = el('div', 'chest-bar')
      bar.dataset.level = level
      const fill = el('span')
      fill.style.width = `${Math.min(100, Math.round((c.used / Math.max(1, c.slotCount)) * 100))}%`
      bar.append(fill)

      const preview = el('div', 'chest-preview-row')
      const ranked = query
        ? [...c.items].sort((a, b) => (itemMatches(b.name) ? 1 : 0) - (itemMatches(a.name) ? 1 : 0) || b.count - a.count)
        : c.items
      for (const it of ranked.slice(0, 4)) {
        const chip = el('span', `chest-mini-item${query && itemMatches(it.name) ? ' hit' : ''}`)
        chip.title = `${labelOf(it.name)} ×${it.count}`
        chip.append(makeIcon(it.name), document.createTextNode(it.count >= 1000 ? `${(it.count / 1000).toFixed(1)}k` : String(it.count)))
        preview.append(chip)
      }
      if (ranked.length > 4) preview.append(el('span', 'chest-mini-more', `+${ranked.length - 4}`))

      card.append(top, bar, preview)
      card.addEventListener('click', () => {
        selectedId = c.id
        selectedSlot = null
        listEl.querySelectorAll('.chest-card').forEach(n => n.setAttribute('aria-selected', 'false'))
        card.setAttribute('aria-selected', 'true')
        renderDetail()
      })
      listEl.append(card)
    }
    renderDetail()
  }

  async function fetchChests (force = false) {
    if (fetching) return
    fetching = true
    try {
      const res = await fetch('/api/chests', { cache: 'no-store' })
      if (!res.ok) return
      const next = await res.json()
      const nextDigest = JSON.stringify([next.updatedAt, next.chests?.length, next.chests?.map(c => [c.id, c.used, c.receivedAt])])
      if (force || nextDigest !== digest) {
        digest = nextDigest
        data = next && Array.isArray(next.chests) ? next : { chests: [] }
        render()
      }
    } catch { /* keep previous */ } finally {
      fetching = false
    }
  }

  void loadTextures()
  void fetchChests(true)
  setInterval(() => {
    if (document.visibilityState === 'visible') void fetchChests(false)
  }, 10000)
})()
