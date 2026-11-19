/**
 * XP-PAYTECH-P7 — the application side of the price audit (migration 067 is tested on real SQL
 * in p7-commercial-price-audit.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('server-only', () => ({}))

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  owners: vi.fn(() => ['owner@example.test', 'second@example.test']),
  priceAlert: vi.fn(async () => ({ success: true })),
  integrityAlert: vi.fn(async () => ({ success: true })),
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ rpc: h.rpc, from: h.from }) }))
vi.mock('@/lib/auth/owner-email', () => ({ ownerEmails: h.owners }))
vi.mock('@/lib/email', () => ({ sendCommercialPriceAlert: h.priceAlert, sendCommercialIntegrityAlert: h.integrityAlert }))

const { decidePriceChange, changeCommercialPrice, PRICE_MESSAGES, DRAFT_REASON } = await import('@/lib/catalogue/commercial-price')
const { checkCommercialIntegrity, confirmedInApp } = await import('@/lib/catalogue/commercial-integrity')
const T = await import('@/lib/email/templates/price-change')

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const blank = (m: string) => m.replace(/[^\n]/g, ' ')
const strip = (s: string) => s.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, blank).replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length))

beforeEach(() => { vi.clearAllMocks() })

const pub = { price: 9900, isFree: false, isPublished: true }
const form = (confirm: string | null, reason: string | null) => ({ confirm, reason })

describe('P7 · decidePriceChange: what the form must carry', () => {
  it('no price or free-flag change: nothing to confirm', () => {
    expect(decidePriceChange(pub, { ...pub }, form(null, null))).toEqual({ kind: 'none' })
  })
  it('a published course: the new price typed again and a reason, or a refusal', () => {
    const next = { ...pub, price: 10900 }
    expect(decidePriceChange(pub, next, form(null, null))).toEqual({ kind: 'refuse', message: PRICE_MESSAGES.confirm })
    expect(decidePriceChange(pub, next, form('10900', ''))).toEqual({ kind: 'refuse', message: PRICE_MESSAGES.confirm })
    expect(decidePriceChange(pub, next, form('10 900', 'ok'))).toEqual({ kind: 'refuse', message: PRICE_MESSAGES.confirm })
    expect(decidePriceChange(pub, next, form('9900', 'Hausse validée'))).toEqual({ kind: 'refuse', message: PRICE_MESSAGES.confirm })
    expect(decidePriceChange(pub, next, form('10 900', '  Hausse validée  '))).toEqual({ kind: 'change', reason: 'Hausse validée' })
  })
  it('publishing a draft at a new price needs the same confirmation', () => {
    const draft = { ...pub, isPublished: false }
    expect(decidePriceChange(draft, { ...pub, price: 500 }, form(null, null)).kind).toBe('refuse')
  })
  it('making a published course free is a price change too', () => {
    expect(decidePriceChange(pub, { price: 0, isFree: true, isPublished: true }, form(null, null)).kind).toBe('refuse')
    expect(decidePriceChange(pub, { price: 0, isFree: true, isPublished: true }, form('0', 'Offerte'))).toEqual({ kind: 'change', reason: 'Offerte' })
  })
  it('an unpublished draft changes without confirmation, with a recorded reason', () => {
    const draft = { ...pub, isPublished: false }
    expect(decidePriceChange(draft, { ...draft, price: 500 }, form(null, null))).toEqual({ kind: 'change', reason: DRAFT_REASON })
    expect(decidePriceChange(draft, { ...draft, price: 500 }, form(null, 'Essai'))).toEqual({ kind: 'change', reason: 'Essai' })
  })
  it('refuses a fractional or negative price before asking anything', () => {
    expect(decidePriceChange(pub, { ...pub, price: 9900.5 }, form('9900.5', 'x x x'))).toEqual({ kind: 'refuse', message: PRICE_MESSAGES.whole })
    expect(decidePriceChange(pub, { ...pub, price: -1 }, form('-1', 'x x x'))).toEqual({ kind: 'refuse', message: PRICE_MESSAGES.whole })
  })
})

const request = {
  kind: 'course' as const, id: 'c-1', code: 'C1-F1', title: 'Fondamentaux',
  expectedPrice: 9900, newPrice: 10900, newIsFree: false, reason: 'Hausse validée',
  actor: { id: 'admin-1', email: 'admin@example.test' },
}

describe('P7 · changeCommercialPrice: the one confirmed path, then the alert', () => {
  it('calls 067 with the server-session administrator and alerts every owner', async () => {
    h.rpc.mockResolvedValueOnce({ data: { changeId: 42 }, error: null })
    expect(await changeCommercialPrice(request)).toEqual({ ok: true, changeId: 42 })
    expect(h.rpc).toHaveBeenCalledWith('admin_change_commercial_price', {
      p_kind: 'course', p_item_id: 'c-1', p_expected_price: 9900, p_new_price: 10900, p_new_is_free: false,
      p_reason: 'Hausse validée', p_actor_id: 'admin-1', p_actor_email: 'admin@example.test',
    })
    expect(h.priceAlert).toHaveBeenCalledTimes(2)
    expect(h.priceAlert).toHaveBeenCalledWith('owner@example.test', expect.objectContaining({ code: 'C1-F1', oldPrice: 9900, newPrice: 10900, changeId: 42, actorEmail: 'admin@example.test' }))
  })
  it('maps a database refusal to its message and sends no alert', async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { message: 'commercial_price_stale', code: '40001' } })
    expect(await changeCommercialPrice(request)).toEqual({ ok: false, message: PRICE_MESSAGES.commercial_price_stale })
    expect(h.priceAlert).not.toHaveBeenCalled()
  })
  it('fails closed when 067 is not installed', async () => {
    h.rpc.mockResolvedValueOnce({ data: null, error: { message: 'Could not find the function public.admin_change_commercial_price', code: 'PGRST202' } })
    expect(await changeCommercialPrice(request)).toEqual({ ok: false, message: PRICE_MESSAGES.unavailable })
  })
  it('a failed alert never undoes or hides a recorded change', async () => {
    h.rpc.mockResolvedValueOnce({ data: { changeId: 7 }, error: null })
    h.priceAlert.mockRejectedValueOnce(new Error('mail down'))
    expect(await changeCommercialPrice(request)).toEqual({ ok: true, changeId: 7 })
  })
})

describe('P7 · the course editor', () => {
  const EDIT = 'app/(admin)/admin/courses/[id]/edit/actions.ts'
  const src = () => strip(read(EDIT))
  const generic = () => { const s = src(); const i = s.indexOf(".from('courses')\n    .update({"); return s.slice(i, s.indexOf('.eq(', i)) }

  it('never writes price or is_free in the generic update', () => {
    expect(generic()).toBeTruthy()
    expect(generic()).not.toMatch(/\bprice\b|\bis_free\b/)
  })
  it('decides and makes the price change BEFORE the generic update, and throws on refusal', () => {
    const s = src()
    const decide = s.indexOf('decidePriceChange(')
    const change = s.indexOf('changeCommercialPrice(')
    const update = s.indexOf(".from('courses')\n    .update({")
    expect(decide).toBeGreaterThan(0)
    expect(decide).toBeLessThan(change)
    expect(change).toBeLessThan(update)
    expect(s.slice(decide, change)).toMatch(/if \(pricing\.kind === 'refuse'\) throw new Error/)
    expect(s.slice(change, update)).toMatch(/if \(!changed\.ok\) throw new Error/)
  })
  it('takes the actor from the server session, never from the form', () => {
    const s = src()
    expect(s).toMatch(/actor: \{ id: admin\.id, email: admin\.email \?\? null \}/)
    expect(s).not.toMatch(/formData\.get\('(actor|admin|email)/)
  })
  it('reads the current price from the row, fail closed', () => {
    expect(src()).toMatch(/\.select\('price, is_free'\)[\s\S]{0,200}if \(priceReadError \|\| !priceRow\)[\s\S]{0,300}throw new Error/)
  })
  it('the forms accept any whole FCFA price (step 500 rejected 9 900 and 14 900)', () => {
    for (const f of ['app/(admin)/admin/courses/[id]/edit/page.tsx', 'app/(admin)/admin/courses/new/NewCourseForm.tsx']) {
      expect(read(f), f).not.toMatch(/step=\{500\}/)
      expect(read(f), f).toMatch(/name="price"[\s\S]{0,60}step=\{1\}/)
    }
  })
  it('the edit page offers the confirmation and the reason', () => {
    const p = read('app/(admin)/admin/courses/[id]/edit/page.tsx')
    expect(p).toMatch(/name="price_confirm"/)
    expect(p).toMatch(/name="price_reason"/)
  })
  it('no other application code updates a course or pack price', () => {
    const files: string[] = []
    const walk = (d: string) => { for (const n of readdirSync(join(ROOT, d))) { const p = join(d, n); statSync(join(ROOT, p)).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) && files.push(p) } }
    walk('app'); walk('lib')
    const offenders = files.filter(f => {
      const s = strip(read(f))
      return /\.from\('(courses|course_packs)'\)\s*\.update\(\{[^}]*\bprice\b/.test(s) || /\.from\('(courses|course_packs)'\)\s*\.upsert\(/.test(s)
    })
    expect(offenders).toEqual([])
  })
})

describe('P7 · the daily integrity check', () => {
  const chain = (result: unknown) => {
    const c: Record<string, unknown> = {}
    for (const m of ['select', 'gt', 'eq', 'order', 'limit', 'in']) c[m] = () => c
    ;(c as { then: unknown }).then = (res: (_v: unknown) => unknown) => Promise.resolve(result).then(res)
    return c
  }
  const tables = (t: Record<string, unknown>) => h.from.mockImplementation((name: string) => chain(t[name]))

  it('says nothing when there is nothing to say', async () => {
    tables({
      commercial_price_changes: { data: [], error: null },
      payments: { data: [{ id: 'p1', reference: 'SCX-1' }], error: null },
      payment_entitlements: { data: [{ payment_id: 'p1' }], error: null },
    })
    expect(await checkCommercialIntegrity()).toEqual({ priceChanges: 0, priceChangesOutsideApp: 0, accessLinkMissing: 0, alertsSent: 0 })
    expect(h.integrityAlert).not.toHaveBeenCalled()
  })

  it('alerts on a price change made outside the administration and a completed payment with no access', async () => {
    tables({
      commercial_price_changes: { data: [
        { occurred_at: 't1', item_kind: 'course', item_code: 'C1-F1', operation: 'UPDATE', old_price: '9900.00', new_price: '500.00', confirmed: false, actor_source: 'unattributed', actor_email: null, jwt_role: null },
        { occurred_at: 't2', item_kind: 'course', item_code: 'C1-F2', operation: 'UPDATE', old_price: '9900.00', new_price: '10900.00', confirmed: true, actor_source: 'admin_rpc', actor_email: 'a@x', jwt_role: 'service_role' },
      ], error: null },
      payments: { data: [{ id: 'p1', reference: 'SCX-1' }, { id: 'p2', reference: 'SCX-2' }], error: null },
      payment_entitlements: { data: [{ payment_id: 'p1' }], error: null },
    })
    const r = await checkCommercialIntegrity()
    expect(r).toEqual({ priceChanges: 2, priceChangesOutsideApp: 1, accessLinkMissing: 1, alertsSent: 2 })
    const data = h.integrityAlert.mock.calls[0][1] as { accessLinkMissing: string[]; priceChanges: { confirmedInApp: boolean; oldPrice: number }[] }
    expect(data.accessLinkMissing).toEqual(['SCX-2'])
    expect(data.priceChanges.map(c => [c.oldPrice, c.confirmedInApp])).toEqual([[9900, false], [9900, true]])
  })

  it('reports an unreadable record instead of failing the sweep', async () => {
    tables({
      commercial_price_changes: { data: null, error: { code: '42P01' } },
      payments: { data: [], error: null },
    })
    expect((await checkCommercialIntegrity()).unavailable).toBe('price_changes_unreadable')
  })

  it('a confirmed change counts as in-app only when made through 067 by the application', () => {
    expect(confirmedInApp({ confirmed: true, actor_source: 'admin_rpc', jwt_role: 'service_role' })).toBe(true)
    expect(confirmedInApp({ confirmed: true, actor_source: 'admin_rpc', jwt_role: null })).toBe(false)   // SQL editor with forged settings
    expect(confirmedInApp({ confirmed: false, actor_source: 'jwt', jwt_role: 'authenticated' })).toBe(false)
  })

  it('runs after the sweep is recorded, and is returned beside it', () => {
    const s = strip(read('app/api/payments/paytech/reconcile/route.ts'))
    const recorded = s.indexOf('await recordSweepFinished(counts)')
    const check = s.indexOf('await checkCommercialIntegrity()')
    expect(recorded).toBeGreaterThan(0)
    expect(check).toBeGreaterThan(recorded)
    // Counts only: the sweep's response carries numbers and nothing else (xp-paytech-ready-01).
    for (const k of ['integrityPriceChanges', 'integrityPriceChangesOutsideApp', 'integrityAccessLinkMissing', 'integrityAlertsSent', 'integrityUnavailable']) {
      expect(s).toMatch(new RegExp(`${k}:\\s+integrity\\.`))
    }
  })
})

describe('P7 · the alert e-mails', () => {
  const d = { kind: 'course' as const, code: 'C1-F1', title: '<b>Fondamentaux</b>', oldPrice: 9900, newPrice: 10900, actorEmail: 'admin@example.test', reason: 'Hausse', changeId: 42 }
  it('say what changed, from what to what, by whom, why, and the record number', () => {
    expect(T.commercialPriceAlertSubject(d)).toBe('Prix modifié — C1-F1 : 9 900 FCFA → 10 900 FCFA')
    const text = T.commercialPriceAlertText(d)
    for (const s of ['9 900 FCFA', '10 900 FCFA', 'admin@example.test', 'Motif : Hausse', 'n° 42']) expect(text).toContain(s)
    expect(T.commercialPriceAlertHtml(d)).not.toContain('<b>Fondamentaux')
  })
  it('the daily summary flags a change made outside the administration', () => {
    const text = T.commercialIntegrityAlertText({ windowHours: 26, accessLinkMissing: ['SCX-2'],
      priceChanges: [{ at: 't', kind: 'course', code: 'C1-F1', oldPrice: 9900, newPrice: 500, confirmedInApp: false, actorEmail: null }] })
    expect(text).toContain('HORS DE L’ADMINISTRATION')
    expect(text).toContain('SCX-2')
  })
})
