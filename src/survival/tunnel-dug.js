'use strict'

// The blocks a tunnel path has dug so far, shared between the paths of one
// search. Every digging step used to copy its parent's whole set; with paths
// of a hundred or more dug blocks, one search made thousands of copies and
// most of its time went to garbage collection (real Realm 2026-11-16 20:20
// JST: four tunnel searches in one decision, 1.6 s). A step now keeps only
// the blocks it digs and a link to its parent; every 16 links the whole set is
// written once, so a lookup walks at most 16 links.
const SNAPSHOT_EVERY = 16

class Dug {
  constructor (parent = null, own = []) {
    this.parent = parent
    this.own = own
    this.size = (parent?.size ?? 0) + own.length
    this.links = parent ? (parent.full ? 1 : parent.links + 1) : 0
    this.full = null
    if (this.links >= SNAPSHOT_EVERY) {
      this.full = new Set(own)
      for (let node = parent; node; node = node.parent) {
        if (node.full) { for (const id of node.full) this.full.add(id); break }
        for (const id of node.own) this.full.add(id)
      }
      this.links = 0
    }
  }

  has (id) {
    for (let node = this; node; node = node.parent) {
      if (node.full) return node.full.has(id)
      if (node.own.includes(id)) return true
    }
    return false
  }

  // A new set with these ids added (the parent is never changed).
  with (ids) { return ids.length ? new Dug(this, ids) : this }
}

const emptyDug = () => new Dug()

module.exports = { emptyDug, Dug }
