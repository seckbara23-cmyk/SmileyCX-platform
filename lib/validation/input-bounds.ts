/**
 * A cheap check of how much an action's input holds, run BEFORE Zod.
 *
 * Zod 3 keeps one issue for every failing element and does not stop early, not even
 * for `.max()`, and no 3.x release changes that. So anything larger than an action could
 * legitimately receive is refused here first.
 *
 * It walks iteratively and refuses as soon as a limit is passed, so it never reads past
 * them, apart from listing one object's keys, and deep nesting cannot overflow the stack.
 * It decides only whether a value is small enough to validate, not whether it is valid. A
 * key that names the prototype is refused too, because no field these actions take is
 * called that. It never throws on what a client can send, which is plain JSON.
 */
export interface InputBounds {
  /** Values of any kind, including containers. */
  readonly maxNodes: number
  /** Nesting below the top-level value. */
  readonly maxDepth: number
  /** Characters across every string and object key. */
  readonly maxChars: number
}

export function withinInputBounds(value: unknown, bounds: InputBounds): boolean {
  let nodes = 0
  let chars = 0
  const pending: { readonly value: unknown; readonly depth: number }[] = [{ value, depth: 0 }]

  while (pending.length > 0) {
    const item = pending.pop()!
    nodes += 1
    if (nodes > bounds.maxNodes) return false

    const v = item.value
    if (typeof v === 'string') {
      chars += v.length
      if (chars > bounds.maxChars) return false
      continue
    }
    if (v === null || v === undefined || typeof v === 'number' || typeof v === 'boolean') continue
    if (typeof v !== 'object' || item.depth >= bounds.maxDepth) return false

    if (Array.isArray(v)) {
      // Checked first, so a huge array costs nothing to refuse.
      if (nodes + pending.length + v.length > bounds.maxNodes) return false
      for (const child of v) pending.push({ value: child, depth: item.depth + 1 })
      continue
    }

    // Nothing these actions accept is a Map, a Set, a Date or anything else with a
    // prototype of its own, and Zod would walk some of those.
    const proto = Object.getPrototypeOf(v)
    if (proto !== Object.prototype && proto !== null) return false

    const keys = Object.keys(v)
    if (nodes + pending.length + keys.length > bounds.maxNodes) return false
    for (const key of keys) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return false
      chars += key.length
      if (chars > bounds.maxChars) return false
      pending.push({ value: (v as Record<string, unknown>)[key], depth: item.depth + 1 })
    }
  }
  return true
}
