import 'server-only'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'
import { createLogger } from '@/lib/logger'

const log = createLogger('commerce/packs')

/**
 * Fixed commercial packs — XP-LAUNCH-FINAL-08 (requirements V4 §7 and §17).
 *
 * A pack is ONE payment that opens every course of the pack for six months, at the
 * same instant (migration 065). Its price and composition live in
 * `public.course_packs` and `public.course_pack_courses`; nothing here hardcodes a
 * price. Published packs are readable by anyone (RLS); checkout reads them through
 * the service role, because what a learner is charged must not depend on a policy.
 *
 * Reads FAIL SOFT for display (an empty list, a null pack): a page that cannot read
 * the packs shows no pack, never a wrong one. Checkout fails closed on its own.
 */

/** A pack code: upper-case, as migration 065 constrains it. */
export const PACK_CODE_RE = /^[A-Z][A-Z0-9-]{2,39}$/

export interface PackCourse {
  readonly id: string
  readonly code: string | null
  readonly slug: string
  readonly title: string
  readonly price: number
  readonly currency: string
  readonly isPublished: boolean
}

export interface Pack {
  readonly id: string
  readonly code: string
  readonly title: string
  readonly description: string
  readonly price: number
  readonly currency: string
  readonly isPublished: boolean
  readonly courses: readonly PackCourse[]
}

/** `pack-conseiller` or `PACK-CONSEILLER` → `PACK-CONSEILLER`, or null if it is not a pack code. */
export function packCodeFrom(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const code = raw.trim().toUpperCase()
  return PACK_CODE_RE.test(code) ? code : null
}

/** The public page of a pack. */
export function packHref(code: string): string {
  return `/packs/${encodeURIComponent(code.toLowerCase())}`
}

/** Where a pack is bought. */
export function packCheckoutHref(code: string): string {
  return `/checkout?pack=${encodeURIComponent(code)}`
}

/** What the courses of a pack cost when bought one by one. */
export function individualTotal(pack: Pick<Pack, 'courses'>): number {
  return pack.courses.reduce((sum, c) => sum + c.price, 0)
}

type Row = Record<string, unknown>
type Reader = ReturnType<typeof createAdminClient>

/**
 * Packs, their courses and those courses, read as three plain queries (no embedded
 * select), in display order. `undefined` when any read fails. A pack one of whose
 * courses the reader cannot see (unpublished, for the public) is returned with that
 * course missing, so callers can tell it is incomplete.
 */
async function readPacks(client: Reader, opts: { code?: string; publishedOnly: boolean }): Promise<{ pack: Pack; complete: boolean }[] | undefined> {
  let q = client
    .from('course_packs')
    .select('id, code, title, description, price, currency, is_published, position')
  if (opts.publishedOnly) q = q.eq('is_published', true)
  if (opts.code) q = q.eq('code', opts.code)
  const { data: packs, error } = await q.order('position', { ascending: true })
  if (error || !Array.isArray(packs)) return undefined
  if (packs.length === 0) return []

  const packIds = (packs as Row[]).map(p => String(p.id))
  const { data: links, error: linkError } = await client
    .from('course_pack_courses')
    .select('pack_id, course_id, position')
    .in('pack_id', packIds)
  if (linkError || !Array.isArray(links)) return undefined

  const courseIds = [...new Set((links as Row[]).map(l => String(l.course_id)))]
  let courses: Row[] = []
  if (courseIds.length > 0) {
    const { data, error: courseError } = await client
      .from('courses')
      .select('id, code, slug, title, price, currency, is_published')
      .in('id', courseIds)
    if (courseError || !Array.isArray(data)) return undefined
    courses = data as Row[]
  }
  const courseOf = new Map(courses.map(c => [String(c.id), c]))

  return (packs as Row[]).map(row => {
    const mine = (links as Row[])
      .filter(l => String(l.pack_id) === String(row.id))
      .sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0))
    const list: PackCourse[] = []
    let complete = mine.length > 0
    for (const l of mine) {
      const c = courseOf.get(String(l.course_id))
      if (!c) { complete = false; continue }
      list.push({
        id:          String(c.id),
        code:        typeof c.code === 'string' ? c.code : null,
        slug:        String(c.slug ?? ''),
        title:       String(c.title ?? ''),
        price:       Number(c.price ?? 0),
        currency:    String(c.currency ?? 'XOF'),
        isPublished: c.is_published === true,
      })
    }
    return {
      complete,
      pack: {
        id:          String(row.id),
        code:        String(row.code),
        title:       String(row.title ?? ''),
        description: String(row.description ?? ''),
        price:       Number(row.price ?? 0),
        currency:    String(row.currency ?? 'XOF'),
        isPublished: row.is_published === true,
        courses:     list,
      },
    }
  })
}

function publicClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } },
  ) as unknown as Reader
}

/** Every published, complete pack, in display order. Empty when they cannot be read. */
export async function getPublishedPacks(): Promise<Pack[]> {
  try {
    const read = await readPacks(publicClient(), { publishedOnly: true })
    if (read === undefined) {
      log.warn('published packs could not be read')
      return []
    }
    return read
      .filter(r => r.complete && r.pack.courses.every(c => c.isPublished))
      .map(r => r.pack)
  } catch {
    log.warn('reading the published packs threw')
    return []
  }
}

/** One published, complete pack by code, or null. */
export async function getPublishedPack(code: string): Promise<Pack | null> {
  const normalised = packCodeFrom(code)
  if (!normalised) return null
  return (await getPublishedPacks()).find(p => p.code === normalised) ?? null
}

/**
 * A pack as checkout must price it: through the service role, whatever its state,
 * so that the caller decides (unpublished, incomplete) rather than the policy.
 * `undefined` when it cannot be read: checkout then fails closed. An incomplete pack
 * (a course row missing) is returned as null: it is not sold.
 */
export async function loadPackForCheckout(code: string): Promise<Pack | null | undefined> {
  try {
    const read = await readPacks(createAdminClient(), { code, publishedOnly: false })
    if (read === undefined) {
      log.error('the pack could not be read for checkout')
      return undefined
    }
    const found = read[0]
    if (!found) return null
    return found.complete ? found.pack : null
  } catch {
    log.error('reading the pack for checkout threw')
    return undefined
  }
}

/** The packs a course belongs to (ids). Empty when none, or when they cannot be read. */
export async function packIdsContainingCourse(courseId: string): Promise<string[]> {
  try {
    const { data, error } = await createAdminClient()
      .from('course_pack_courses')
      .select('pack_id')
      .eq('course_id', courseId)
    if (error || !Array.isArray(data)) return []
    return (data as Row[]).map(r => r.pack_id).filter((v): v is string => typeof v === 'string')
  } catch {
    return []
  }
}

/** The course ids of a pack (service role). Empty when it cannot be read. */
export async function courseIdsOfPack(packId: string): Promise<string[]> {
  try {
    const { data, error } = await createAdminClient()
      .from('course_pack_courses')
      .select('course_id')
      .eq('pack_id', packId)
    if (error || !Array.isArray(data)) return []
    return (data as Row[]).map(r => r.course_id).filter((v): v is string => typeof v === 'string')
  } catch {
    return []
  }
}
