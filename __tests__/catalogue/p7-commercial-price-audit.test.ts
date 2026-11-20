/**
 * XP-PAYTECH-P7 — migration 067 against a real Postgres (PGlite).
 *
 * Its own engine on purpose: the payments integration file is near PGlite's memory
 * limit at shutdown. The schema here is the minimum 067 touches, with Supabase's
 * default privileges granted FIRST, so 067's revokes must do the work.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

const M067 = readFileSync(join(process.cwd(), 'supabase', 'migrations', '067_commercial_price_audit.sql'), 'utf8')

const ADMIN     = '11111111-1111-4111-8111-111111111111'
const LEARNER   = '22222222-2222-4222-8222-222222222222'
const SUSPENDED = '33333333-3333-4333-8333-333333333333'
const C_PUB     = 'aaaaaaaa-0000-4000-8000-000000000001'
const C_DRAFT   = 'aaaaaaaa-0000-4000-8000-000000000002'
const C_FREE    = 'aaaaaaaa-0000-4000-8000-000000000003'
const P_PUB     = 'bbbbbbbb-0000-4000-8000-000000000001'

let db: PGlite

const BASE = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
create table public.profiles (id uuid primary key, platform_role text, account_status text not null default 'active');
create table public.courses (
  id uuid primary key, code text unique, title text not null default 'x',
  price numeric(10,2) not null default 0, currency text not null default 'XOF',
  is_free boolean not null default false, is_published boolean not null default false,
  updated_at timestamptz not null default now());
create table public.course_packs (
  id uuid primary key, code text not null unique, title text not null default 'Pack',
  price numeric(10,2) not null check (price > 0 and price = trunc(price)), currency text not null default 'XOF',
  is_published boolean not null default false, updated_at timestamptz not null default now());
`

async function reset() {
  await db.exec(`
    truncate public.profiles, public.courses, public.course_packs;
    insert into public.profiles values
      ('${ADMIN}', 'super_admin', 'active'), ('${LEARNER}', 'user', 'active'), ('${SUSPENDED}', 'super_admin', 'suspended');
  `)
}
// Inserts of courses and packs are themselves recorded; tests count from a fresh mark.
async function seed() {
  await db.exec(`
    insert into public.courses (id, code, price, is_free, is_published) values
      ('${C_PUB}', 'C1-F1', 9900, false, true), ('${C_DRAFT}', 'C9-F9', 5000, false, false), ('${C_FREE}', 'C1-F4', 0, true, true);
    insert into public.course_packs (id, code, price, is_published) values ('${P_PUB}', 'PACK-CONSEILLER', 37900, true);
  `)
}
const lastId = async () => Number((await db.query<{ m: number | null }>('select max(id) as m from public.commercial_price_changes')).rows[0].m ?? 0)
const since = async (mark: number) =>
  (await db.query<Record<string, unknown>>('select * from public.commercial_price_changes where id > $1 order by id', [mark])).rows
const price = async (id: string, table = 'courses') =>
  Number((await db.query<{ price: string }>(`select price from public.${table} where id = $1`, [id])).rows[0].price)
const rpc = (o: Partial<{ kind: string; id: string; expected: number | null; price: number; free: boolean | null; reason: string | null; actor: string | null; email: string }>) =>
  db.query<{ r: Record<string, unknown> }>(
    'select public.admin_change_commercial_price($1, $2, $3, $4, $5, $6, $7, $8) as r',
    [o.kind ?? 'course', o.id ?? C_PUB, o.expected === undefined ? 9900 : o.expected, o.price ?? 10900,
     o.free === undefined ? false : o.free, o.reason === undefined ? 'Nouveau tarif validé' : o.reason,
     o.actor === undefined ? ADMIN : o.actor, o.email ?? 'admin@example.test'])
async function refused(p: Promise<unknown>, re: RegExp) {
  let msg = ''
  try { await p } catch (e) { msg = (e as Error).message }
  expect(msg, 'expected a refusal').toMatch(re)
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(BASE)
  await db.exec(M067)
}, 60_000)
afterAll(async () => { await db?.close() })
beforeEach(async () => { await reset(); await seed() })

describe('067 · applies whole', () => {
  it('creates the record, both witnesses, both guards and the append-only triggers', async () => {
    const t = await db.query<{ n: number }>(`select count(*)::int as n from pg_trigger where not tgisinternal and tgname like '%commercial_price%'`)
    expect(t.rows[0].n).toBe(8)
  })

  it('records the creation of priced items', async () => {
    const rows = (await db.query<{ item_code: string; operation: string; new_price: string }>(
      `select item_code, operation, new_price from public.commercial_price_changes where operation = 'INSERT' order by id`)).rows
    expect(rows.map(r => [r.item_code, Number(r.new_price)])).toEqual(
      expect.arrayContaining([['C1-F1', 9900], ['PACK-CONSEILLER', 37900]]))
  })
})

describe('067 · a published price never changes silently', () => {
  it('refuses a direct change of a published course price, and keeps the price', async () => {
    const mark = await lastId()
    await refused(db.query(`update public.courses set price = 500 where id = $1`, [C_PUB]), /commercial_price_unconfirmed/)
    expect(await price(C_PUB)).toBe(9900)
    expect(await since(mark)).toHaveLength(0)
  })

  it('refuses a direct change of the free flag or the currency of a published course', async () => {
    await refused(db.query(`update public.courses set is_free = true, price = 0 where id = $1`, [C_PUB]), /commercial_price_unconfirmed/)
    await refused(db.query(`update public.courses set currency = 'EUR' where id = $1`, [C_PUB]), /commercial_price_unconfirmed/)
  })

  it('refuses a price change bundled with publication', async () => {
    await refused(db.query(`update public.courses set price = 1, is_published = true where id = $1`, [C_DRAFT]), /commercial_price_unconfirmed/)
  })

  it('refuses a direct change of a published pack price', async () => {
    await refused(db.query(`update public.course_packs set price = 100 where id = $1`, [P_PUB]), /commercial_price_unconfirmed/)
    expect(await price(P_PUB, 'course_packs')).toBe(37900)
  })

  it('lets every non-price edit of a published course through, unrecorded', async () => {
    const mark = await lastId()
    await db.query(`update public.courses set title = 'Nouveau titre', is_published = false where id = $1`, [C_PUB])
    expect(await since(mark)).toHaveLength(0)
  })

  it('lets a draft price change through, and records it as unconfirmed and unattributed', async () => {
    const mark = await lastId()
    await db.query(`update public.courses set price = 6000 where id = $1`, [C_DRAFT])
    const [row] = await since(mark)
    expect(row).toMatchObject({ item_kind: 'course', item_code: 'C9-F9', operation: 'UPDATE', confirmed: false,
      actor_source: 'unattributed', was_published: false, is_published: false })
    expect([Number(row.old_price), Number(row.new_price)]).toEqual([5000, 6000])
    expect(row.db_session_user).toBeTruthy()
    expect(row.txid).toBeTruthy()
  })

  it('attributes a change made with a user token to that token', async () => {
    const mark = await lastId()
    await db.exec('begin')
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: LEARNER, email: 'l@example.test', role: 'authenticated' })])
    await db.query(`update public.courses set price = 7000 where id = $1`, [C_DRAFT])
    await db.exec('commit')
    const [row] = await since(mark)
    expect(row).toMatchObject({ actor_source: 'jwt', actor_id: LEARNER, actor_email: 'l@example.test', jwt_role: 'authenticated' })
  })
})

describe('067 · admin_change_commercial_price is the one confirmed way', () => {
  it('changes a published course price for an active administrator and records who, what, why', async () => {
    const mark = await lastId()
    const { rows } = await rpc({})
    expect(rows[0].r).toMatchObject({ kind: 'course', id: C_PUB, code: 'C1-F1', published: true, oldPrice: 9900, newPrice: 10900 })
    expect(await price(C_PUB)).toBe(10900)
    const [row] = await since(mark)
    expect(row).toMatchObject({ item_kind: 'course', item_id: C_PUB, confirmed: true, actor_source: 'admin_rpc',
      actor_id: ADMIN, actor_email: 'admin@example.test', reason: 'Nouveau tarif validé', was_published: true, is_published: true })
    expect([Number(row.old_price), Number(row.new_price)]).toEqual([9900, 10900])
    expect(Number(rows[0].r.changeId)).toBe(Number(row.id))
  })

  it('makes a course free only at 0, and a free course paid only above 0', async () => {
    await rpc({ price: 0, free: true })
    expect(await price(C_PUB)).toBe(0)
    await refused(rpc({ id: C_FREE, expected: 0, price: 0, free: false }), /commercial_price_invalid/)
    await rpc({ id: C_FREE, expected: 0, price: 9900, free: false })
    expect(await price(C_FREE)).toBe(9900)
  })

  it('changes a published pack price', async () => {
    const mark = await lastId()
    await rpc({ kind: 'pack', id: P_PUB, expected: 37900, price: 39900, free: null })
    expect(await price(P_PUB, 'course_packs')).toBe(39900)
    expect((await since(mark))[0]).toMatchObject({ item_kind: 'pack', item_code: 'PACK-CONSEILLER', confirmed: true, actor_id: ADMIN })
  })

  it('the confirmation covers that one statement: a direct change after it, in the same transaction, is refused', async () => {
    await db.exec('begin')
    let msg = ''
    try {
      await rpc({})
      await db.query(`update public.courses set price = 1 where id = $1`, [C_PUB])
    } catch (e) { msg = (e as Error).message }
    await db.exec('rollback')
    expect(msg).toMatch(/commercial_price_unconfirmed/)
    expect(await price(C_PUB)).toBe(9900)
  })

  it.each([
    ['a price the operator did not see (lost update)', { expected: 9500 }, /commercial_price_stale/],
    ['no expected price', { expected: null }, /commercial_price_stale/],
    ['a learner as actor', { actor: LEARNER }, /commercial_actor_not_admin/],
    ['a suspended administrator', { actor: SUSPENDED }, /commercial_actor_not_admin/],
    ['no actor', { actor: null }, /commercial_actor_not_admin/],
    ['no reason', { reason: null }, /commercial_reason_required/],
    ['a two-letter reason', { reason: 'ok' }, /commercial_reason_required/],
    ['a fractional price', { price: 9900.5 }, /commercial_price_invalid/],
    ['a negative price', { price: -1 }, /commercial_price_invalid/],
    ['a paid course at 0', { price: 0, free: false }, /commercial_price_invalid/],
    ['a free course above 0', { price: 100, free: true }, /commercial_price_invalid/],
    ['an unchanged price', { price: 9900 }, /commercial_price_unchanged/],
    ['an unknown item', { id: 'cccccccc-0000-4000-8000-000000000000' }, /commercial_item_not_found/],
    ['an unknown kind', { kind: 'bundle' }, /commercial_kind_invalid/],
    ['a pack at 0', { kind: 'pack', id: P_PUB, expected: 37900, price: 0, free: null }, /commercial_price_invalid/],
  ])('refuses %s, and changes nothing', async (_l, o, re) => {
    const mark = await lastId()
    await refused(rpc(o as Parameters<typeof rpc>[0]), re)
    expect(await price(C_PUB)).toBe(9900)
    expect(await price(P_PUB, 'course_packs')).toBe(37900)
    expect(await since(mark)).toHaveLength(0)
  })
})

describe('067 · the record cannot be rewritten, and is closed to the browser', () => {
  it('refuses UPDATE, DELETE and TRUNCATE, even from the owner', async () => {
    await refused(db.query(`update public.commercial_price_changes set reason = 'x'`), /append-only/)
    await refused(db.query(`delete from public.commercial_price_changes`), /append-only/)
    await refused(db.query(`truncate public.commercial_price_changes`), /append-only/)
  })

  it('records a deletion of a priced item', async () => {
    const mark = await lastId()
    await db.query(`delete from public.courses where id = $1`, [C_DRAFT])
    expect((await since(mark))[0]).toMatchObject({ operation: 'DELETE', item_code: 'C9-F9', new_price: null })
  })

  it('anon and authenticated can neither read it nor call the function; service_role may only read', async () => {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`)
      await refused(db.query('select 1 from public.commercial_price_changes'), /permission denied/)
      await refused(db.query(`select public.admin_change_commercial_price('course', '${C_PUB}', 9900, 10900, false, 'raison', '${ADMIN}', 'a@b')`), /permission denied/)
      await db.exec('reset role')
    }
    await db.exec('set role service_role')
    await db.query('select count(*) from public.commercial_price_changes')
    await refused(db.query(`insert into public.commercial_price_changes (item_kind, item_id, operation, confirmed, actor_source, db_session_user, txid)
                            values ('course', '${C_PUB}', 'UPDATE', true, 'admin_rpc', 'x', '1')`), /permission denied/)
    await db.exec('reset role')
  })

  it('the witness and the guard cannot be called directly by any application role', async () => {
    const r = await db.query<{ role: string; f: string; ok: boolean }>(`
      select r.role, f.f, has_function_privilege(r.role, f.f, 'execute') as ok
        from (values ('anon'), ('authenticated'), ('service_role')) r(role),
             (values ('public.audit_commercial_price()'), ('public.guard_commercial_price()'),
                     ('public.commercial_price_changes_append_only()')) f(f)`)
    expect(r.rows.filter(x => x.ok)).toEqual([])
  })
})
