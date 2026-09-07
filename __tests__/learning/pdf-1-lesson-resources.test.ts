// @vitest-environment node
/**
 * PDF-1 — learner-facing lesson PDF resources.
 *
 * ── WHAT WAS ACTUALLY MISSING ─────────────────────────────────────────────
 *
 * Nothing in the backend. `lessons.pdf_url` has existed since migration 007,
 * `pdf_object_path` since 041, `pdf` has been a first-class member of
 * PROTECTED_FOLDERS since XPA-8 W3, `/api/media/lesson/[id]/pdf` has enforced
 * entitlement on it all along, and the admin editor has uploaded to it for
 * months. Three production lessons on C1-F2 carry approved PDFs today.
 *
 * The learner query simply never asked for the columns. Exactly the QUIZ-1A
 * shape: a complete capability made unreachable by one SELECT.
 *
 * So this suite guards the seam that was broken — the columns are requested,
 * the block renders only when there is something to render, and the href is an
 * application URL rather than a Storage URL — and it proves the two things that
 * can be proven for real, by running the actual helper: delivery address and
 * path-over-URL precedence.
 *
 * The rest is static source analysis. It runs without a database and cannot
 * observe a real fetch; the runtime proof of protected delivery lives in
 * `__tests__/security/xpa-8-w3-protected-media.test.ts` and in production.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  lessonAssetSrc, lessonMediaHref, resolveAssetSource, PROTECTED_FOLDERS,
} from '@/lib/media/paths'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const blank = (m: string) => m.replace(/[^\n]/g, ' ')
const stripJs = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, blank)
   .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, blank)
   .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length))

const PLAYER  = 'app/(learn)/learn/[courseSlug]/[moduleId]/[lessonId]/page.tsx'
const SIDEBAR = 'components/lms/LessonSidebar.tsx'
const ROUTE   = 'app/api/media/lesson/[lessonId]/[kind]/route.ts'
const STORAGE = 'lib/media/storage.ts'

const LESSON = '1f9ab4a4-776e-42ec-8f88-6f6a8da644a6'

// ══════════════════════════════════════════════════════════════════════════
describe('PDF-1 — the learner query asks for the columns', () => {
  it('1. BOTH lesson selects include pdf_url and pdf_object_path', () => {
    const s = stripJs(read(PLAYER))
    const selects = s.match(/lessons\(id, slug, title,[^)]*\)/g) ?? []
    // Two: the initial load and the post-enrollment reload. Missing either one
    // leaves a code path where the resource silently disappears.
    expect(selects).toHaveLength(2)
    for (const sel of selects) {
      expect(sel, 'pdf_url missing from a lesson select').toContain('pdf_url')
      expect(sel, 'pdf_object_path missing from a lesson select').toContain('pdf_object_path')
    }
  })

  it('the row type carries both fields, or the page cannot compile', () => {
    const t = read(SIDEBAR)
    expect(t).toMatch(/pdf_url\?:\s*string \| null/)
    expect(t).toMatch(/pdf_object_path\?:\s*string \| null/)
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('PDF-1 — the resource block renders only when there is a resource', () => {
  const src = () => stripJs(read(PLAYER))

  it('2. a lesson WITH a pdf renders the block', () => {
    const s = src()
    expect(s).toMatch(/\{pdfSrc && \(/)
    const block = s.slice(s.indexOf('{pdfSrc && ('))
    expect(block).toContain('Ressources')
    expect(block).toContain('Télécharger le support PDF')
  })

  it('3. a lesson WITHOUT a pdf renders nothing', () => {
    const s = src()
    // `lessonAssetSrc` returns null when both columns are null, so the guard is
    // the whole mechanism. Assert the strings appear ONLY inside it — an
    // unguarded heading would be an empty panel on 115 of 118 lessons.
    const guard = s.indexOf('{pdfSrc && (')
    expect(guard).toBeGreaterThan(-1)
    expect(s.indexOf('Ressources')).toBeGreaterThan(guard)
    expect(s.indexOf('Télécharger le support PDF')).toBeGreaterThan(guard)
    expect((s.match(/Ressources/g) ?? []).length).toBe(1)
    // And there is no separate empty-state panel.
    expect(s).not.toMatch(/Aucune ressource|pas de ressource/i)
  })

  it('4. the visible heading is exactly "Ressources"', () => {
    expect(src()).toContain('<p className="mb-3 text-sm font-semibold text-white/90">Ressources</p>')
  })

  it('5. the visible action is exactly "Télécharger le support PDF"', () => {
    const s = src()
    expect(s).toContain('Télécharger le support PDF')
    // Raw accents, matching this file's existing convention — not entities.
    expect(s).not.toContain('T&eacute;l&eacute;charger')
  })

  it('the block sits below the lesson content area', () => {
    const s = src()
    const content = s.indexOf('dangerouslySetInnerHTML')
    const block   = s.indexOf('{pdfSrc && (')
    expect(content).toBeGreaterThan(-1)
    expect(block).toBeGreaterThan(content)
  })
})

// ══════════════════════════════════════════════════════════════════════════
// These two run the REAL helper rather than reading source, because delivery
// address and precedence are behaviour, not text.
// ══════════════════════════════════════════════════════════════════════════
describe('PDF-1 — delivery address and precedence, proven behaviourally', () => {
  it('6. a protected pdf resolves to /api/media/lesson/<id>/pdf', () => {
    const src = lessonAssetSrc(LESSON, 'pdf', 'pdf/1783538482616-wbsg6lgryj.pdf', null)
    expect(src).toBe(`/api/media/lesson/${LESSON}/pdf`)
    expect(lessonMediaHref(LESSON, 'pdf')).toBe(`/api/media/lesson/${LESSON}/pdf`)
    // Never a Storage URL, never a signed URL.
    expect(src).not.toContain('supabase')
    expect(src).not.toContain('/storage/v1/')
    expect(src).not.toContain('token=')
  })

  it('9. pdf_object_path WINS over a legacy pdf_url', () => {
    const legacy = 'https://x.supabase.co/storage/v1/object/public/course-media/pdf/old.pdf'
    // Both present: the private path must win, so the learner is served through
    // the entitlement check rather than a public URL.
    expect(lessonAssetSrc(LESSON, 'pdf', 'pdf/new.pdf', legacy)).toBe(`/api/media/lesson/${LESSON}/pdf`)
    expect(resolveAssetSource('pdf/new.pdf', legacy)).toEqual({ kind: 'protected', path: 'pdf/new.pdf' })
    // Path only.
    expect(lessonAssetSrc(LESSON, 'pdf', 'pdf/new.pdf', null)).toBe(`/api/media/lesson/${LESSON}/pdf`)
    // Legacy only — an external URL passes through untouched, unchanged by PDF-1.
    expect(lessonAssetSrc(LESSON, 'pdf', null, legacy)).toBe(legacy)
    // Neither — nothing to render, which is why the guard suppresses the block.
    expect(lessonAssetSrc(LESSON, 'pdf', null, null)).toBeNull()
    expect(resolveAssetSource(null, null)).toBeNull()
  })

  it('pdf is a first-class protected kind, not a special case', () => {
    expect(PROTECTED_FOLDERS).toContain('pdf')
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('PDF-1 — the learner surface holds the security line', () => {
  const src = () => stripJs(read(PLAYER))

  it('7. the link opens in a new tab', () => {
    const s = src()
    const block = s.slice(s.indexOf('{pdfSrc && ('), s.indexOf('{exercises.map'))
    expect(block).toContain('target="_blank"')
  })

  it('8. rel carries BOTH noopener and noreferrer', () => {
    const s = src()
    const block = s.slice(s.indexOf('{pdfSrc && ('), s.indexOf('{exercises.map'))
    expect(block).toMatch(/rel="[^"]*noopener[^"]*"/)
    expect(block).toMatch(/rel="[^"]*noreferrer[^"]*"/)
  })

  it('10. the href comes from lessonAssetSrc, not a hand-built string', () => {
    const s = src()
    expect(s).toMatch(/const pdfSrc\s*=\s*lessonAssetSrc\(lesson\.id, 'pdf',\s*lesson\.pdf_object_path,\s*lesson\.pdf_url\)/)
    const block = s.slice(s.indexOf('{pdfSrc && ('), s.indexOf('{exercises.map'))
    expect(block).toContain('href={pdfSrc}')
  })

  it('11. the learner page never signs anything', () => {
    const s = src()
    for (const forbidden of ['signObject', 'createSignedUrl', 'SERVICE_ROLE', 'service_role'])
      expect(s, `the learner page references ${forbidden}`).not.toContain(forbidden)
    // `lib/media/storage.ts` is the only module that signs, and it is server-only.
    expect(read(STORAGE)).toMatch(/^import 'server-only'/m)
  })

  it('12. the learner page constructs no Storage URL', () => {
    const s = src()
    for (const forbidden of ['/storage/v1/', 'object/public', 'PUBLIC_BUCKET', 'PROTECTED_BUCKET', '.supabase.co/storage'])
      expect(s, `the learner page builds a Storage URL via ${forbidden}`).not.toContain(forbidden)
  })
})

// ══════════════════════════════════════════════════════════════════════════
describe('PDF-1 — the protected-media contract it depends on is intact', () => {
  it('13. /api/media/lesson/<id>/pdf still enforces entitlement and signs briefly', () => {
    const r = stripJs(read(ROUTE))
    // Entitlement is the authority, keyed on the course derived from the LESSON.
    expect(r).toMatch(/resolveCourseAccessById\(resolvedCourseId\)/)
    expect(r).toMatch(/if \(!access\.allowed\)/)
    // pdf is routed to its own column, and the kind is allowlisted.
    expect(r).toMatch(/pdf:\s*'pdf_object_path'/)
    expect(r).toMatch(/PROTECTED_FOLDERS as readonly string\[\]\)\.includes\(kind\)/)
    // Delivery is a short-lived redirect that is never cached.
    expect(r).toMatch(/signObject\(/)
    expect(r).toMatch(/NextResponse\.redirect\(signed, 302\)/)
    expect(r).toMatch(/private, no-store/)
    // Preview status must never be an access grant.
    expect(r, 'preview must not weaken protected-media authorization').not.toContain('is_preview')
  })

  it('the pdf signed-URL TTL is short and unchanged by PDF-1', () => {
    const s = read(STORAGE)
    expect(s).toMatch(/pdf:\s*120/)
  })

  it('PDF-1 introduced no new public bucket or durable URL anywhere it touched', () => {
    for (const f of [PLAYER, SIDEBAR]) {
      const s = stripJs(read(f))
      expect(s, `${f} names a public bucket`).not.toContain('course-media')
      expect(s, `${f} names the protected bucket directly`).not.toContain('course-content')
    }
  })
})
