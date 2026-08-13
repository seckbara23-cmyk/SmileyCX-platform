// @vitest-environment node
/**
 * XPA-8 W3 — protected storage delivery (blocker F-2).
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────
 *
 * Row-level security protected the lesson ROW. Nothing protected the FILE.
 * Measured in production before remediation:
 *
 *   • a lesson with is_preview = false returned 0 rows to an anonymous caller,
 *     and its 15 MB video returned HTTP 200 to that same caller;
 *   • `anon` LISTed course-media and enumerated 149 videos, 3 PDFs, 24 covers —
 *     no URL had to leak first, so "the path is unguessable" was never true;
 *   • an authenticated learner with has_course_access() = false downloaded it;
 *   • a synthetic certificate written for learner B was downloaded anonymously
 *     AND by a different signed-in learner;
 *   • any authenticated learner could INSERT a PDF into another learner's
 *     certificate folder (bucket went 0 → 1 objects, then cleaned).
 *
 * ── THE INVARIANTS ────────────────────────────────────────────────────────
 *
 *   knowing an object path or a historical URL is NOT authorization
 *   only the owner (or an authorized server path) may retrieve a certificate
 *
 * ── WHY BUCKET PRIVACY IS THE PRECONDITION, NOT ONE LAYER ─────────────────
 *
 * For public = true, `/storage/v1/object/public/<bucket>/<path>` serves the
 * object WITHOUT evaluating storage.objects RLS. 018's `cert_owner_select` was
 * written correctly and never ran. A policy cannot rescue a public bucket.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import {
  objectPathFromPublicUrl, resolveAssetSource, lessonAssetSrc,
  lessonMediaHref, certificateMediaHref,
  PROTECTED_BUCKET, PUBLIC_BUCKET, CERTIFICATE_BUCKET, PROTECTED_FOLDERS,
} from '@/lib/media/paths'

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')
const has = (rel: string) => existsSync(join(ROOT, rel))
const blank = (m: string) => m.replace(/[^\n]/g, ' ')
const stripTs = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, blank)
   .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, blank)
   .replace(/\/\/[^\n]*/g, blank)
const stripSql = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/--[^\n]*/g, blank)

// Tolerant reads: a file that does not exist yields '', so this suite can be
// run against a pre-fix commit to prove the assertions actually catch the
// defect, rather than dying at import time with ENOENT and proving nothing.
const readOr = (rel: string) => (has(rel) ? read(rel) : '')

const M041 = readOr('supabase/migrations/041_protected_media_storage.sql')
const M042 = readOr('supabase/migrations/042_backfill_media_object_paths.sql')
const LESSON_ROUTE = 'app/api/media/lesson/[lessonId]/[kind]/route.ts'
const CERT_ROUTE = 'app/api/media/certificate/[certificateId]/route.ts'

// ═══════════════════════════════════════════════════════════════════════════
// THE NAMED REGRESSION — NO PROTECTED BUCKET MAY BE PUBLIC
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 W3 — protected media never lives in a public bucket', () => {
  it('F-2: the protected bucket is created PRIVATE', () => {
    const sql = stripSql(M041)
    const block = sql.slice(sql.indexOf("'course-content'"))
    expect(block.slice(0, 600)).toMatch(/false/)
    expect(block, 'course-content was created public').not.toMatch(/'course-content'[\s\S]{0,400}?public\s*\)\s*values[\s\S]{0,200}true/i)
  })

  it('F-2: the certificates bucket is made private', () => {
    expect(stripSql(M041)).toMatch(/update storage\.buckets[\s\S]{0,120}set public = false[\s\S]{0,120}'certificates'/i)
  })

  it('F-2: the two storage policies that granted writes to every role are dropped', () => {
    const sql = stripSql(M041)
    expect(sql).toMatch(/drop policy if exists "cert_service_insert"/i)
    expect(sql).toMatch(/drop policy if exists "cert_service_update"/i)
    // …and not merely recreated with the same permissiveness.
    expect(sql, 'a permissive insert policy was recreated')
      .not.toMatch(/create policy[\s\S]{0,80}cert_service_insert/i)
  })

  it('F-2: no protected bucket is ever created or re-asserted public in app code', () => {
    const offenders: string[] = []
    const walk = (d: string) => {
      for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.next') continue
        const p = `${d}/${e.name}`
        if (e.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e.name) && !p.includes('__tests__')) {
          const src = stripTs(read(p))
          if (/createBucket\(/.test(src)) offenders.push(p)
        }
      }
    }
    for (const d of ['app', 'lib', 'components']) walk(d)
    expect(offenders, `createBucket() survives in:\n${offenders.join('\n')}`).toEqual([])
  })

  it('F-2: the upload route sends protected kinds to the private bucket', () => {
    const src = stripTs(read('app/api/admin/upload-url/route.ts'))
    expect(src).toMatch(/cover:\s*PUBLIC_BUCKET/)
    for (const k of ['video', 'pdf', 'subtitle']) {
      expect(src, `${k} uploads still go to the public bucket`)
        .toMatch(new RegExp(`${k}:\\s*PROTECTED_BUCKET`))
    }
  })

  it('F-2: a protected upload is never handed a persistable delivery URL', () => {
    const src = stripTs(read('app/api/admin/upload-url/route.ts'))
    expect(src).toMatch(/publicUrl:\s*isProtected\s*\n?\s*\?\s*null/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// DELIVERY IS AUTHORIZED BY THE EXISTING SEAM
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 W3 delivery authority', () => {
  const route = () => stripTs(read(LESSON_ROUTE))

  it('lesson media asks resolveCourseAccessById — the same seam as everything else', () => {
    const s = route()
    expect(s).toContain('resolveCourseAccessById')
    expect(s).toMatch(/if \(!access\.allowed\)/)
  })

  it('enrollment, organization membership and mode flags are NOT consulted', () => {
    const s = route()
    for (const t of ['enrollment', 'enrollments', 'organization', 'is_org_member',
                     'PLATFORM_MODE', 'PILOT_MODE', 'FREE_ACCESS_MODE']) {
      expect(s, `${t} leaked into the delivery decision`).not.toContain(t)
    }
  })

  it('is_preview does not authorize protected delivery', () => {
    // F-1 flagged 20 lessons as preview. Preview governs the catalogue ROW; it
    // must never become a second authority over the FILE.
    expect(route(), 'is_preview became a delivery authority').not.toContain('is_preview')
  })

  it('the service role is used to look the lesson UP, never to decide', () => {
    const s = route()
    const lookupAt = s.indexOf('createAdminClient')
    const decideAt = s.indexOf('resolveCourseAccessById')
    expect(lookupAt).toBeGreaterThan(-1)
    expect(decideAt).toBeGreaterThan(lookupAt)
  })

  it('a denied caller cannot distinguish "no such lesson" from "not yours"', () => {
    const s = route()
    // Missing lesson, missing asset and un-migrated lesson all answer 404.
    expect(s).toMatch(/if \(!lesson\) return notFound\(\)/)
    expect(s).toMatch(/if \(!objectPath \|\| !resolvedCourseId\) return notFound\(\)/)
  })

  it('the kind parameter is validated against an allowlist', () => {
    const s = route()
    expect(s).toMatch(/PROTECTED_FOLDERS as readonly string\[\]\)\.includes\(kind\)/)
  })

  it('no SQL identifier is built from request input', () => {
    const s = route()
    expect(s, 'a column name is interpolated into the query')
      .not.toMatch(/\.select\(`[^`]*\$\{/)
  })

  it('delivery responses are never cached', () => {
    for (const r of [LESSON_ROUTE, CERT_ROUTE]) {
      expect(stripTs(read(r))).toMatch(/Cache-Control['"],\s*['"]private, no-store/)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// CERTIFICATES — OWNERSHIP, NOT COURSE ACCESS
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 W3 certificate delivery', () => {
  const route = () => stripTs(read(CERT_ROUTE))

  it('only the owner or the administration portal may retrieve one', () => {
    const s = route()
    expect(s).toMatch(/cert\.user_id === user\.id/)
    expect(s).toContain('getOwnerSession')
    expect(s).toMatch(/if \(!isOwner && !owner\)/)
  })

  it('a foreign certificate answers 404, not 403', () => {
    const s = route()
    const guard = s.slice(s.indexOf('if (!isOwner && !owner)'))
    expect(guard.slice(0, 200)).toMatch(/return notFound\(\)/)
  })

  it('a certificate is NOT gated on current course access', () => {
    // Revoking a course does not un-earn a certificate, and the access_ended
    // copy already promises the learner keeps it.
    expect(route(), 'certificate delivery consults course access')
      .not.toContain('resolveCourseAccess')
  })

  it('the generator persists an object PATH, never a public URL', () => {
    const s = stripTs(read('app/api/certificates/[id]/pdf/route.ts'))
    expect(s).toContain('pdf_object_path: storagePath')
    expect(s, 'getPublicUrl survives in the certificate path').not.toContain('getPublicUrl')
  })

  it('the generator returns the application URL, not a Storage URL', () => {
    const s = stripTs(read('app/api/certificates/[id]/pdf/route.ts'))
    expect(s).toMatch(/pdf_url:\s*certificateMediaHref\(id\)/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// NO SERVICE-ROLE KEY, NO PERMANENT URL, IN ANY BROWSER PAYLOAD
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 W3 browser exposure', () => {
  it('the signing module is server-only', () => {
    expect(readOr('lib/media/storage.ts').split('\n')[0]).toMatch(/^import 'server-only'/)
  })

  it('the client-safe module contains no key, no signing and no decision', () => {
    const s = read('lib/media/paths.ts')
    expect(s, 'the client-safe module became server-only')
      .not.toMatch(/^import 'server-only'/m)          // a client component imports it
    expect(s).not.toContain('SERVICE_ROLE')
    expect(s).not.toContain('createSignedUrl')
    expect(s).not.toContain('createAdminClient')
    expect(s).not.toContain('has_course_access')
  })

  it('no client component imports the signing module', () => {
    const offenders: string[] = []
    const walk = (d: string) => {
      for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.next') continue
        const p = `${d}/${e.name}`
        if (e.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e.name)) {
          const raw = read(p)
          if (/^['"]use client['"]/m.test(raw) && /@\/lib\/media\/storage/.test(stripTs(raw))) {
            offenders.push(p)
          }
        }
      }
    }
    for (const d of ['app', 'components', 'lib']) walk(d)
    expect(offenders, `client components importing the signer:\n${offenders.join('\n')}`).toEqual([])
  })

  it('the learn player asks the application, never Storage', () => {
    const s = stripTs(read('app/(learn)/learn/[courseSlug]/[moduleId]/[lessonId]/page.tsx'))
    expect(s).toContain('lessonAssetSrc')
    expect(s).toMatch(/src=\{videoSrc\}/)
    expect(s, 'the player still reads a raw storage url').not.toMatch(/src=\{lesson\.video_url\}/)
    expect(s).not.toContain('/storage/v1/object/public/')
  })

  it('lessonMediaHref and certificateMediaHref produce application URLs only', () => {
    expect(lessonMediaHref('abc', 'video')).toBe('/api/media/lesson/abc/video')
    expect(certificateMediaHref('xyz')).toBe('/api/media/certificate/xyz')
    for (const u of [lessonMediaHref('a', 'pdf'), certificateMediaHref('b')]) {
      expect(u.startsWith('/api/')).toBe(true)
      expect(u).not.toContain('supabase')
      expect(u).not.toContain('storage')
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// PATH IDENTITY — THE SQL AND THE TYPESCRIPT MUST AGREE
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 W3 object-path parsing', () => {
  const REAL = 'https://eqoqcxkdcxeosjqaafhs.supabase.co/storage/v1/object/public/course-media/video/1786646008777-abc.mp4'

  it('parses one of our public URLs into a path', () => {
    expect(objectPathFromPublicUrl(REAL)).toBe('video/1786646008777-abc.mp4')
  })

  it('leaves an external URL alone — that is not a parse failure', () => {
    for (const u of ['https://www.youtube.com/embed/xyz', 'https://cdn.partner.com/a.mp4']) {
      expect(objectPathFromPublicUrl(u)).toBeNull()
    }
  })

  it('does not match a different bucket or the signed route', () => {
    expect(objectPathFromPublicUrl(REAL.replace('course-media', 'course-content'))).toBeNull()
    expect(objectPathFromPublicUrl(REAL.replace('/public/', '/sign/'))).toBeNull()
  })

  it('handles null and empty input', () => {
    expect(objectPathFromPublicUrl(null)).toBeNull()
    expect(objectPathFromPublicUrl('')).toBeNull()
  })

  it('the TypeScript regex and the 042 SQL regex agree', () => {
    // Both must capture everything after the bucket name, and both must be
    // anchored to OUR public route so an external URL is never rewritten.
    const sqlRe = /'\^https\?:\/\/\[\^\/\]\+\/storage\/v1\/object\/public\/course-media\/\(\.\+\)\$'/
    expect(M042, 'the SQL backfill regex changed shape').toMatch(sqlRe)
    const tsSrc = read('lib/media/paths.ts')
    expect(tsSrc).toContain('storage\\/v1\\/object\\/public\\/course-media\\/(.+)$')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// PRECEDENCE, AND THE SAFE INTERMEDIATE STATE
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 W3 asset precedence', () => {
  it('a path wins over a legacy URL', () => {
    expect(resolveAssetSource('video/a.mp4', 'https://x/y.mp4')).toEqual({ kind: 'protected', path: 'video/a.mp4' })
  })

  it('with no path, the existing URL is used unchanged — the deploy window', () => {
    // Between deploying the code and running the 042 backfill every path is
    // NULL. Nothing may break in that window.
    expect(resolveAssetSource(null, 'https://x/y.mp4')).toEqual({ kind: 'external', url: 'https://x/y.mp4' })
    expect(lessonAssetSrc('L1', 'video', null, 'https://x/y.mp4')).toBe('https://x/y.mp4')
  })

  it('a protected asset resolves to the application route', () => {
    expect(lessonAssetSrc('L1', 'video', 'video/a.mp4', 'https://x/y.mp4'))
      .toBe('/api/media/lesson/L1/video')
  })

  it('nothing at all resolves to null', () => {
    expect(resolveAssetSource(null, null)).toBeNull()
    expect(lessonAssetSrc('L1', 'video', null, null)).toBeNull()
  })

  it('the admin action decides the column from the VALUE, not from the client', () => {
    // RAW source. The comment stripper cannot be used for this assertion: the
    // regex literal ends in `\/\//i`, whose last two characters are an adjacent
    // `//` that any naive scanner reads as the start of a line comment — so a
    // stripped copy has the rest of the line blanked out.
    const s = read('app/(admin)/admin/modules/[id]/edit/actions.ts')
    expect(s).toContain('function splitAsset')
    expect(s).toContain('/^[a-z]+:\\/\\//i.test(v)')
    expect(s).toMatch(/video_object_path:\s*video\.path/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// THE SCHEMA REFUSES THE OLD MISTAKE
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 W3 schema guarantees', () => {
  it('a path column cannot hold a URL', () => {
    const sql = stripSql(M041)
    expect(sql).toMatch(/lessons_object_paths_are_paths/)
    expect(sql).toMatch(/certificates_object_path_is_path/)
    expect(sql).toMatch(/!~ '\^\[a-z\]\+:\/\/'/)
  })

  it('all four path columns are added', () => {
    const sql = stripSql(M041)
    for (const c of ['video_object_path', 'pdf_object_path', 'subtitle_object_path']) {
      expect(sql).toContain(c)
    }
    expect(sql).toMatch(/alter table public\.certificates[\s\S]{0,120}pdf_object_path/i)
  })

  it('041 verifies its own outcome and raises if it did not happen', () => {
    const sql = stripSql(M041)
    expect(sql).toMatch(/raise exception[\s\S]{0,80}still public/i)
    expect(sql).toMatch(/raise exception[\s\S]{0,90}permissive certificate write policies/i)
  })

  it('the backfill refuses to run before the objects exist', () => {
    const sql = stripSql(M042)
    expect(sql).toMatch(/from storage\.objects/i)
    expect(sql).toMatch(/bucket_id = 'course-content'/)
    expect(sql).toMatch(/raise exception[\s\S]{0,140}not yet in the course-content bucket/i)
  })

  it('the backfill fails rather than silently skipping an unparseable value', () => {
    const sql = stripSql(M042)
    expect(sql).toMatch(/raise exception[\s\S]{0,160}neither a course-media URL nor an external URL/i)
    expect(sql).toMatch(/Nothing was changed/)
  })

  it('the backfill is forward-only and re-runnable', () => {
    // It only fills columns that are still NULL, so a second run is a no-op
    // and never overwrites a path an administrator has since corrected.
    const sql = stripSql(M042)
    expect((sql.match(/and \w+_object_path is null/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })

  it('no applied migration was edited', () => {
    // 037–040 are live in production. W3 adds 041 and 042 and touches nothing.
    for (const f of ['037_entitlements.sql', '038_answer_key_protection.sql',
                     '039_public_course_structure.sql', '040_organizations_xpa7.sql']) {
      expect(read(`supabase/migrations/${f}`), `${f} mentions W3`).not.toMatch(/XPA-8 W3|course-content/)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// THE HISTORICAL-URL PROBLEM IS ACTUALLY SOLVED
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 W3 historical URLs', () => {
  it('the operator script exists and separates copy from delete', () => {
    expect(has('scripts/security/migrate-media-objects.mjs')).toBe(true)
    const s = readOr('scripts/security/migrate-media-objects.mjs')
    expect(s).toContain('--copy')
    expect(s).toContain('--delete-originals')
  })

  it('deletion refuses unless every object is in the private bucket AND recorded', () => {
    const s = stripTs(readOr('scripts/security/migrate-media-objects.mjs'))
    expect(s).toMatch(/are not in \$\{TARGET\} yet/)
    expect(s).toMatch(/not referenced by any lesson path column/)
  })

  it('it refuses to copy into a bucket that is public', () => {
    expect(stripTs(readOr('scripts/security/migrate-media-objects.mjs')))
      .toMatch(/if \(target\.public\)/)
  })

  it('cover/ is deliberately NOT moved — it is public marketing', () => {
    const s = readOr('scripts/security/migrate-media-objects.mjs')
    expect(s).toMatch(/MOVE_PREFIXES = \['video', 'pdf', 'subtitle'\]/)
    expect(s).not.toMatch(/MOVE_PREFIXES = \[[^\]]*'cover'/)
  })

  it('the documented sequence puts deletion last', () => {
    const s = readOr('scripts/security/migrate-media-objects.mjs')
    expect(s.indexOf('--copy')).toBeLessThan(s.indexOf('--delete-originals'))
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// TTL — CHOSEN, NOT GUESSED
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 W3 signed-URL lifetime', () => {
  const src = () => readOr('lib/media/storage.ts')

  it('is short, because the route re-mints on every request', () => {
    const s = stripTs(src())
    const m = /SIGNED_URL_TTL_SECONDS = \{([\s\S]*?)\}/.exec(s)
    expect(m).toBeTruthy()
    const values = [...m![1].matchAll(/:\s*(\d+)/g)].map(x => Number(x[1]))
    expect(values.length).toBeGreaterThanOrEqual(4)
    for (const v of values) {
      expect(v, 'a TTL longer than 10 minutes is not "short-lived"').toBeLessThanOrEqual(600)
      expect(v, 'a TTL under 30s will break a slow mobile connection').toBeGreaterThanOrEqual(30)
    }
  })

  it('the reasoning is written down, not just the number', () => {
    const s = src()
    expect(s).toMatch(/Range requests/)
    expect(s).toMatch(/Senegal|mobile network/)
  })

  it('the route redirects per request rather than handing out a long URL', () => {
    const s = stripTs(read(LESSON_ROUTE))
    expect(s).toMatch(/NextResponse\.redirect\(signed, 302\)/)
  })

  it('signObject refuses a value that is a URL', () => {
    // RAW, for the same reason as the splitAsset assertion above.
    expect(src())
      .toContain('if (!objectPath || /^[a-z]+:\\/\\//i.test(objectPath)) return null')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// NOTHING ELSE MOVED
// ═══════════════════════════════════════════════════════════════════════════

describe('XPA-8 W3 stayed in its lane', () => {
  it('F-1 was not touched — is_preview is untouched by these migrations', () => {
    // Comments stripped: 041's header DESCRIBES the defect using
    // "is_preview = false". Describing F-1 is not touching it.
    for (const m of [M041, M042]) {
      expect(stripSql(m), 'W3 modified the preview flag').not.toMatch(/is_preview\s*=/)
    }
  })

  it('the public marketing bucket stays public, on purpose', () => {
    expect(PUBLIC_BUCKET).toBe('course-media')
    expect(stripSql(M041), 'course-media was made private')
      .not.toMatch(/update storage\.buckets[\s\S]{0,120}public = false[\s\S]{0,120}'course-media'/i)
  })

  it('the bucket constants are what the rest of the code expects', () => {
    expect(PROTECTED_BUCKET).toBe('course-content')
    expect(CERTIFICATE_BUCKET).toBe('certificates')
    expect([...PROTECTED_FOLDERS]).toEqual(['video', 'pdf', 'subtitle'])
  })

  it('the entitlement seam itself is unchanged', () => {
    const seam = stripTs(read('lib/auth/course-access.ts'))
    expect(seam).toContain('my_course_access')
    expect(seam, 'storage leaked into the access seam').not.toMatch(/storage|bucket|signObject/i)
  })

  it('W1 admission and W2 retirement are untouched', () => {
    expect(stripTs(read('lib/access-control.ts'))).toContain('account_status')
    expect(existsSync(join(ROOT, 'app/app/[[...path]]/page.tsx'))).toBe(true)
  })
})
