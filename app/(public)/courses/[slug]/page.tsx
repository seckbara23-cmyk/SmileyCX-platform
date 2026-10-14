import { notFound } from 'next/navigation'
import Link from 'next/link'
import Image from 'next/image'
import { CheckCircle, Clock, BookOpen, Users, Award, Play, Lock, ChevronDown, ClipboardList, Star } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { learnEntryHref, coursePageHref } from '@/lib/learn/routes'
import { resolveCourseAccess } from '@/lib/auth/course-access'
import { formatPrice, LEVEL_LABELS } from '@/lib/utils/cn'
import { COURSE_MODULES, COURSE_COPY } from '@/data/seed'
import { FREE_ACCESS_MODE, PLATFORM_MODE, PAYMENTS_ENABLED } from '@/lib/pilot'
import { getPublicPathsForCourse, pathHref } from '@/lib/queries/catalogue'
import type { Metadata } from 'next'

const COURSE_META: Record<string, { number: number; objectives: string[]; image: string }> = {
  'fondamentaux-experience-client': {
    number: 1,
    objectives: [
      'Comprendre pourquoi certains clients restent fidèles et d\'autres partent',
      'Cartographier le parcours client pour repérer les points de friction concrets',
      'Identifier les moments clés qui ont le plus d\'impact sur la satisfaction',
      'Appliquer des améliorations immédiates dans votre contexte professionnel',
    ],
    image: '/images/Formation1.jpg',
  },
  'comprendre-client-qualite-experience': {
    number: 1,
    objectives: [
      'Comprendre pourquoi certains clients restent fidèles et d\'autres partent',
      'Cartographier le parcours client pour repérer les points de friction concrets',
      'Créer des interactions qui renforcent la confiance et la fidélité',
      'Mesurer et améliorer la qualité de service de façon continue',
    ],
    image: '/images/Formation1.jpg',
  },
  'excellence-dans-le-service-client': {
    number: 1,
    objectives: [
      'Comprendre les attentes réelles de vos clients et ce qui les fidélise',
      'Transformer chaque interaction en opportunité de créer de la valeur',
      'Gérer les situations difficiles sans perdre la qualité de service',
      'Mettre en place des indicateurs pour suivre et améliorer la satisfaction',
      'Construire une culture client durable dans votre équipe',
      'Fidéliser vos clients sur le long terme grâce à la qualité de l\'expérience',
    ],
    image: '/images/Formation1.jpg',
  },
  'experience-client-memorable': {
    number: 2,
    objectives: [
      'Concevoir des interactions qui marquent durablement vos clients',
      'Différencier votre organisation par la qualité de l\'expérience',
      'Transformer vos clients satisfaits en ambassadeurs',
      'Fidéliser durablement grâce à des moments mémorables',
    ],
    image: '/images/Formation1.jpg',
  },
  'service-client-digital': {
    number: 3,
    objectives: [
      'Maîtriser les canaux digitaux pour une relation client cohérente',
      'Utiliser les outils CRM pour mieux connaître et servir vos clients',
      'Offrir une expérience fluide sur tous les points de contact digitaux',
      'Réduire les délais de réponse et améliorer la satisfaction en ligne',
    ],
    image: '/images/Formation1.jpg',
  },
}

interface Props { params: Promise<{ slug: string }> }

function normalizeSlug(raw: string): string {
  return decodeURIComponent(raw)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug: rawSlug } = await params
  const slug = normalizeSlug(rawSlug)
  const supabase = await createClient()

  const { data: course } = await supabase
    .from('courses')
    .select('title, description, cover_url')
    .eq('slug', slug)
    .eq('is_published', true)
    .maybeSingle()

  // CAT-02 — the metadata must not outlive the page.
  //
  // The body now 404s for any slug the database does not publish, but this
  // still reached into `data/seed.ts` for the old flagship slug, so
  // /courses/comprendre-client-qualite-experience returned 404 carrying the
  // title and description of a course that does not exist -- exactly the
  // phantom listing CAT-02 removed from the page, left behind in the <head>
  // where crawlers and link previews read it. An unpublished slug now gets
  // nothing but a de-slugified name.
  const title       = course?.title       ?? slug.replace(/-/g, ' ')
  const description = course?.description ?? undefined
  const image       = course?.cover_url   ?? null

  return {
    title,
    description: description ?? undefined,
    openGraph: {
      title,
      description: description ?? undefined,
      ...(image ? { images: [{ url: image }] } : {}),
    },
    twitter: {
      card:  image ? 'summary_large_image' : 'summary',
      title,
      description: description ?? undefined,
    },
  }
}

export default async function CourseDetailPage({ params }: Props) {
  const { slug: rawSlug } = await params
  const slug = normalizeSlug(rawSlug)
  const supabase = await createClient()

  let modules = COURSE_MODULES

  // Look up course first, without any join — avoids silent failures from join RLS
  const { data: dbCourse } = await supabase
    .from('courses')
    .select('*')
    .eq('slug', slug)
    .eq('is_published', true)
    .maybeSingle()

  // CAT-02 — a course page requires a published DATABASE row. Full stop.
  //
  // This used to read `!dbCourse && slug !== FLAGSHIP_COURSE.slug`, which let
  // one slug render entirely from `data/seed.ts`. That was not theoretical:
  // `comprendre-client-qualite-experience` is absent from `courses`, yet
  // /courses/comprendre-client-qualite-experience returned 200 in production
  // and advertised a course titled "Comprendre le Client" as GRATUIT — because
  // the seed carries `price: 0` with a TEMP_FREE_ACCESS note saying to restore
  // 45000 later. A phantom course, priced free, that nothing could sell and no
  // entitlement could unlock.
  //
  // Making the database the only source means a slug it does not publish is a
  // 404, which is what withdrawal has meant everywhere else since Q-E.
  if (!dbCourse) notFound()

  // UAT-ROUTE-02: read the PUBLIC projection, not the protected tables.
  //
  // This page previously loaded `modules` / `lessons` with the learner's session
  // client. XPA-6A/6B/6D correctly hide those from anyone without an
  // entitlement, so an anonymous visitor got zero rows and the page rendered
  // "0 modules · 0 leçons" with no resolvable first lesson — which is what made
  // the primary CTA inert.
  //
  // A syllabus is marketing copy; lesson bodies are not. Migration 039 projects
  // exactly the former. `content`, `video_url`, `subtitle_url` and `pdf_url` are
  // structurally absent from these views, so this cannot widen into a leak.
  if (dbCourse) {
    const [{ data: pubModules }, { data: pubLessons }] = await Promise.all([
      supabase
        .from('public_course_modules')
        .select('id, slug, title, order_index')
        .eq('course_id', dbCourse.id)
        .order('order_index'),
      supabase
        .from('public_course_lessons')
        .select('id, module_id, slug, title, duration_minutes, is_preview, order_index')
        .eq('course_id', dbCourse.id)
        .order('order_index'),
    ])

    const lessonsByModule = new Map<string, any[]>()
    for (const l of pubLessons ?? []) {
      const bucket = lessonsByModule.get(l.module_id as string) ?? []
      bucket.push(l)
      lessonsByModule.set(l.module_id as string, bucket)
    }

    modules = (pubModules ?? []).map((m: any) => ({
      ...m,
      lessons: (lessonsByModule.get(m.id as string) ?? [])
        .sort((a: any, b: any) => a.order_index - b.order_index),
    }))
  }

  const { data: { user } } = await supabase.auth.getUser()
  let isEnrolled = false
  if (user) {
    const { data: enroll } = await supabase
      .from('enrollments')
      .select('id')
      .eq('user_id', user.id)
      .eq('course_id', dbCourse?.id ?? 'seed')
      .single()
    isEnrolled = !!enroll
  }

  // For enrolled users: load progress to drive smart CTA and progress card
  type CourseProgress = {
    completedLessons: number; totalLessons: number
    completedSteps: number;  totalSteps: number
    percentage: number; continueUrl: string
    nextStep: 'lesson' | 'quiz' | 'final-exam' | 'certificate'
  }
  let enrolledProgress: CourseProgress | null = null

  if (isEnrolled && user && dbCourse) {
    const allLessonPairs = modules.flatMap((m: any) =>
      (m.lessons ?? []).map((l: any) => ({ lessonId: l.id as string, moduleId: m.id as string }))
    )
    const allLessonIds = allLessonPairs.map(x => x.lessonId)
    const moduleIds    = modules.map((m: any) => m.id as string)
    // UAT-ROUTE-01: never interpolate a possibly-absent segment. `modules` is
    // RLS-filtered, so it is empty for an unentitled learner and the old
    // template produced "/learn/<slug>/undefined/undefined".
    const lessonHrefFallback = learnEntryHref(slug, modules)

    const [{ data: lessonProgress }, { data: modQuizRaw }, { data: finalExamQ }] = await Promise.all([
      supabase.from('lesson_progress').select('lesson_id')
        .eq('user_id', user.id).eq('is_completed', true)
        .in('lesson_id', allLessonIds.length > 0 ? allLessonIds : ['__none__']),
      moduleIds.length > 0
        ? supabase.from('quizzes').select('id, module_id').in('module_id', moduleIds)
        : Promise.resolve({ data: [] as { id: string; module_id: string }[] }),
      supabase.from('quizzes').select('id').eq('course_id', dbCourse.id).is('module_id', null).limit(1).maybeSingle(),
    ])

    const completedSet = new Set((lessonProgress ?? []).map(r => r.lesson_id as string))
    const modQuizzes   = ((modQuizRaw ?? []) as { id: string; module_id: string }[])
    const allQuizIds   = [...modQuizzes.map(q => q.id), ...(finalExamQ ? [finalExamQ.id] : [])]
    let passedIds      = new Set<string>()

    if (allQuizIds.length > 0) {
      const { data: passed } = await supabase.from('quiz_attempts').select('quiz_id')
        .eq('user_id', user.id).eq('passed', true).in('quiz_id', allQuizIds)
      passedIds = new Set((passed ?? []).map((a: { quiz_id: string }) => a.quiz_id))
    }

    const completedLessons = completedSet.size
    const totalSteps    = allLessonIds.length + allQuizIds.length
    const completedSteps = completedLessons + allQuizIds.filter(id => passedIds.has(id)).length
    const percentage    = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0

    let continueUrl: string = lessonHrefFallback
    let nextStep: CourseProgress['nextStep'] = 'lesson'

    if (allLessonIds.every(id => completedSet.has(id))) {
      const pendingModQuiz = modQuizzes.find(q => !passedIds.has(q.id))
      if (pendingModQuiz) {
        continueUrl = `/learn/${slug}/${pendingModQuiz.module_id}/quiz`; nextStep = 'quiz'
      } else if (finalExamQ && !passedIds.has(finalExamQ.id)) {
        continueUrl = `/learn/${slug}/final-exam`; nextStep = 'final-exam'
      } else {
        continueUrl = `/certificate/${slug}`; nextStep = 'certificate'
      }
    } else {
      const first = allLessonPairs.find(x => !completedSet.has(x.lessonId))
      if (first) continueUrl = `/learn/${slug}/${first.moduleId}/${first.lessonId}`
    }

    enrolledProgress = { completedLessons, totalLessons: allLessonIds.length, completedSteps, totalSteps, percentage, continueUrl, nextStep }
  }

  const totalLessons   = modules.reduce((n: number, m: typeof COURSE_MODULES[number]) => n + m.lessons.length, 0)
  // CAT-02 — commercial values come from the database and nowhere else. The
  // `notFound()` above guarantees dbCourse exists, so there is no fallback to
  // reach for; `numeric` may arrive as a string, hence the coercion.
  const price          = Number(dbCourse.price)
  const currency       = String(dbCourse.currency)
  const isFree         = dbCourse.is_free === true
  // Whether a learner can act on the price yet. Payments are not activated, so
  // a paid course shows its price and says so rather than offering a checkout
  // that cannot complete.
  const paidPurchaseAvailable = PAYMENTS_ENABLED && !isFree
  // CAT-02 — no seed fallback for displayed fields either. The `notFound()`
  // above proves `dbCourse` exists, so these could never fire; but they are the
  // same shape that produced the phantom course page, and leaving them would
  // let anyone who later loosened that guard resurrect seed data silently.
  const title          = dbCourse.title
  const description    = dbCourse.description
  const level          = dbCourse.level
  const durationHours  = dbCourse.duration_hours
  const meta           = COURSE_META[slug]
  // XPA-3: paths that publicly feature this course (V4 §8 "ce cours fait
  // partie des parcours…"). Only publicly visible paths are returned.
  const memberPaths    = await getPublicPathsForCourse((dbCourse?.code as string | null) ?? null)
  const coverImage     = dbCourse?.cover_url      ?? meta?.image ?? null
  const introVideoUrl  = (dbCourse as Record<string, unknown> | null)?.intro_video_url as string | null ?? null

  // UAT-ROUTE-01: resolves a real first lesson, or degrades to the public
  // course page. It can never emit an `undefined` segment.
  const lessonHref = learnEntryHref(slug, modules)

  // ── UAT-ROUTE-02: the CTA must always DO something ────────────────────────
  //
  // Two rules, both learned from this defect:
  //
  //   1. It must never link to the page it is already on. When no lesson could
  //      be resolved, `learnEntryHref` degrades to the course page — correct as
  //      a route, useless as a CTA, and the reason the button appeared dead.
  //   2. It must not promise entry the access gate will refuse. Membership is
  //      decided by `resolveCourseAccess` — the same seam `(learn)/layout.tsx`
  //      enforces — not by `enrollments`, which XPA-6B made non-authorizing and
  //      which is empty in production.
  const ctaAccess = await resolveCourseAccess(slug)

  // CAT-02 — where the CTA sends someone who does NOT yet have access.
  //
  //   no account            -> log in / create one, returning to the lesson
  //   account, purchasable  -> checkout
  //   account, not yet      -> contact, because checkout cannot complete
  //
  // That last arm is the fix for a live dead end: payments are not activated,
  // and /checkout under PILOT_MODE redirects into /learn/..., which
  // resolveCourseAccess then refuses for want of an entitlement. The learner
  // was bounced from a CTA, through a checkout, into a lesson, back to a
  // refusal. Sending them somewhere that works is the honest state.
  const accessRequestHref = !user
    ? `/login?next=${encodeURIComponent(lessonHref)}`
    : paidPurchaseAvailable
      ? `/checkout?course=${dbCourse.id}`
      : `/contact?course=${encodeURIComponent(slug)}`

  /**
   * The one caption for "priced, but not purchasable yet".
   *
   * Named rather than repeated: it is rendered by the CTA and again by the
   * commercial line at the foot of the page, and a mutation test caught the
   * first draft writing it as two literals -- changing one left the other
   * still saying the opposite.
   */
  const PURCHASE_UNAVAILABLE_NOTE = 'Inscription bientôt disponible'

  /** The CTA label for a visitor without access. Never promises what the gate refuses. */
  const accessRequestLabel = !user
    ? 'Créer mon compte'
    : paidPurchaseAvailable
      ? COURSE_COPY.enrollment_cta
      : PURCHASE_UNAVAILABLE_NOTE

  /**
   * CAT-02 — may we offer the progress-aware CTA ("Continuer la formation",
   * "Passer le quiz", "Obtenir le certificat")?
   *
   * Two separate questions used to be answered by one term.
   *
   * MAY THEY ENTER is `ctaAccess.allowed`, and only that. The contract in
   * `lib/auth/course-access.ts` is explicit -- "an enrollment is an academic
   * transcript and must not authorize access on its own", and the SQL seam
   * dropped its enrollments arm in migration 037 -- so an entitled learner with
   * a verified email may enter whether or not an enrollment row exists. Both
   * CTA sites were gated on `isEnrolled` ALONE, which promised entry to an
   * enrolled learner whose entitlement had lapsed; the lesson route still
   * refused them, so it was never a bypass, but it was the page promising what
   * the gate denies.
   *
   * HAVE THEY PROGRESS TO RESUME is a data question, not an authorization one,
   * and `enrolledProgress` is the thing that answers it. Keying the rich CTA on
   * the progress object rather than on the transcript row means the label can
   * never outrun the data behind it, and the authority stays in one place.
   *
   * Equivalent today, because progress is only loaded when enrolled -- but it
   * states the right reason, so decoupling progress from enrollment later
   * cannot silently turn a transcript back into permission.
   */
  const mayContinue = ctaAccess.allowed && !!enrolledProgress

  const resolvedLearnHref = ctaAccess.allowed
    ? (enrolledProgress?.continueUrl ?? lessonHref)
    : accessRequestHref

  // Belt and braces: whatever the branches produced, a self-link is inert.
  const learnHref =
    resolvedLearnHref === coursePageHref(slug) ? accessRequestHref : resolvedLearnHref

  /**
   * CAT-02 — where the CONTINUE CTA points.
   *
   * The two continue CTAs disagreed: the hero used `continueUrl ?? lessonHref`
   * while the footer used `lessonHref` raw. For a course that publishes no
   * lessons `lessonHref` degrades to `coursePageHref(slug)`, so an entitled,
   * enrolled learner got a prominent footer button that reloaded the page they
   * were already on. A behavioural test on the empty-syllabus case caught it;
   * both now resolve through here, so they cannot drift apart again.
   *
   * The self-link check mirrors the one on `learnHref` above and is defensive
   * only -- mutation testing shows it is currently unreachable, because
   * whenever `mayContinue` holds there is an `enrolledProgress` whose
   * `continueUrl` is a real route. It is kept for the same reason the
   * `learnHref` guard is: this expression has had three different shapes, and
   * an inert self-link is the failure mode it keeps reaching for.
   */
  const continueHref = (() => {
    const target = enrolledProgress?.continueUrl ?? lessonHref
    return target === coursePageHref(slug) ? accessRequestHref : target
  })()

  return (
    <div>

      {/* ══ Hero ═══════════════════════════════════════════════════════ */}
      <section className="bg-light border-b border-black/[0.06] py-10 md:py-14">
        <div className="cx-container">
          <div className="grid lg:grid-cols-[1fr_420px] gap-10 items-start">

            {/* Left: info + CTAs */}
            <div className="flex flex-col gap-5">

              {/* Badges */}
              <div className="flex flex-wrap gap-2">
                {meta && (
                  <span className="bg-secondary/10 text-secondary text-xs font-bold px-3 py-1 rounded-full uppercase tracking-wide">
                    Formation {meta.number}
                  </span>
                )}
                <span className="bg-primary/10 text-primary text-xs font-semibold px-3 py-1 rounded-full">
                  {LEVEL_LABELS[level]}
                </span>
                {/* CAT-02 — the badge states the COMMERCIAL fact from the
                    database, not the deployment mode. It used to read "Accès
                    gratuit" whenever PILOT_MODE or FREE_ACCESS_MODE was set,
                    which labelled all eight courses free regardless of their
                    price. */}
                {ctaAccess.allowed ? (
                  <span className="bg-green-100 text-green-700 text-xs font-bold px-3 py-1 rounded-full">
                    Acc&egrave;s actif
                  </span>
                ) : isFree ? (
                  <span className="bg-green-100 text-green-700 text-xs font-bold px-3 py-1 rounded-full">
                    Formation gratuite
                  </span>
                ) : (
                  <span className="bg-amber-100 text-amber-700 text-xs font-bold px-3 py-1 rounded-full">
                    Droit d&apos;acc&egrave;s requis
                  </span>
                )}
              </div>

              {/* Title + description */}
              <div className="space-y-3">
                <h1 className="text-2xl md:text-3xl font-extrabold text-dark leading-tight">
                  {title}
                </h1>
                <p className="text-cx-gray leading-relaxed max-w-prose">{description}</p>
              </div>

              {/* Stats */}
              <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-cx-gray">
                <span className="flex items-center gap-1.5">
                  <Clock className="w-4 h-4 text-primary/70 shrink-0" />
                  {durationHours}h de contenu
                </span>
                <span className="flex items-center gap-1.5">
                  <BookOpen className="w-4 h-4 text-primary/70 shrink-0" />
                  {modules.length} modules
                </span>
                <span className="flex items-center gap-1.5">
                  <Users className="w-4 h-4 text-primary/70 shrink-0" />
                  {totalLessons} leçons
                </span>
                <span className="flex items-center gap-1.5">
                  <Award className="w-4 h-4 text-primary/70 shrink-0" />
                  Certificat inclus
                </span>
              </div>

              {/* CTAs */}
              <div className="flex flex-col sm:flex-row gap-3 pt-1">
                {mayContinue ? (
                  <Link
                    href={continueHref}
                    className="inline-flex items-center justify-center gap-2 px-7 py-3.5 bg-success text-white font-bold rounded-cx hover:opacity-90 transition-opacity text-sm"
                  >
                    {enrolledProgress?.nextStep === 'quiz'        ? <ClipboardList className="w-4 h-4" />
                    : enrolledProgress?.nextStep === 'final-exam' ? <Star className="w-4 h-4" />
                    : enrolledProgress?.nextStep === 'certificate'? <Award className="w-4 h-4" />
                    : <Play className="w-4 h-4" />}
                    {enrolledProgress?.nextStep === 'quiz'        ? 'Passer le quiz'
                    : enrolledProgress?.nextStep === 'final-exam' ? 'Passer l\'examen final'
                    : enrolledProgress?.nextStep === 'certificate'? 'Obtenir le certificat'
                    : 'Continuer la formation'}
                  </Link>
                ) : (
                  <Link
                    href={learnHref}
                    className="inline-flex items-center justify-center gap-2 px-7 py-3.5 bg-secondary text-white font-bold rounded-cx hover:bg-secondary-dark transition-all hover:-translate-y-0.5 shadow-btn text-sm"
                  >
                    <Play className="w-4 h-4" />
                    {/* UAT-ROUTE-02: the label must match where the link goes.
                        "Commencer gratuitement" pointing at /login is the same
                        false promise as the access note above. A learner who
                        actually holds access still gets an entry label. */}
                    {ctaAccess.allowed
                      ? (enrolledProgress?.continueUrl ? 'Reprendre la formation' : 'Commencer la formation')
                      : accessRequestLabel}
                  </Link>
                )}
                <a
                  href="#curriculum"
                  className="inline-flex items-center justify-center gap-2 px-7 py-3.5 border-2 border-primary/20 text-primary font-semibold rounded-cx hover:bg-primary/5 transition-colors text-sm"
                >
                  Voir le programme
                </a>
              </div>

              {/* Access note — CAT-02 */}
              {/*
                  Two mode-conditional notes used to live here: "Accès sur
                  demande · Compte requis · Activation par un administrateur"
                  under PILOT_MODE, and "Accès gratuit · Certificat inclus ·
                  Phase pilote" under FREE_ACCESS_MODE. Both described how the
                  platform was operated rather than what this course costs, and
                  the first advertised a manual activation step that is not the
                  commercial model.

                  The replacement is derived from the course row and the access
                  the gate actually granted, so it cannot promise entry
                  resolveCourseAccess would refuse.
              */}
              {!ctaAccess.allowed && (
                <p className="text-xs text-cx-gray flex items-center gap-1.5">
                  {isFree ? (
                    <>
                      <CheckCircle className="w-3.5 h-3.5 text-success shrink-0" />
                      Formation gratuite · Certificat inclus · Compte requis
                    </>
                  ) : (
                    <>
                      <Lock className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                      {formatPrice(price, currency)} · Accès complet à vie · Certificat inclus
                    </>
                  )}
                </p>
              )}
              {PLATFORM_MODE === 'private' && !isEnrolled && (
                <p className="text-xs text-cx-gray flex items-center gap-1.5">
                  <Lock className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                  L&apos;inscription est gratuite. L&apos;accès à cette formation nécessite un droit d&apos;accès valide. ·{' '}
                      <Link href="/signup" className="text-primary hover:underline">Créer mon compte</Link>
                </p>
              )}
              {/* CAT-02 — "requise avant l'achat" is only true when there IS a
                  purchase. This was gated on the deployment mode, so flipping
                  PLATFORM_MODE to 'live' while PAYMENTS_ENABLED stayed off
                  would have told guests to log in to buy something nothing can
                  sell. It now follows the same `paidPurchaseAvailable` the CTA
                  does. */}
              {paidPurchaseAvailable && !user && (
                <p className="text-xs text-cx-gray">
                  <Link href="/login" className="text-primary hover:underline">Connexion</Link> requise avant l&apos;achat
                </p>
              )}

              {/* Enrolled progress card */}
              {isEnrolled && enrolledProgress && enrolledProgress.totalSteps > 0 && (
                <div className="bg-white rounded-xl border border-black/[0.06] p-4 mt-1">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-bold text-dark">Ma progression</span>
                    <span className="text-sm font-extrabold text-primary">{enrolledProgress.percentage}%</span>
                  </div>
                  <div className="cx-progress-bar mb-2.5">
                    <div className="cx-progress-bar-fill" style={{ width: `${enrolledProgress.percentage}%` }} />
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    <span className="text-xs text-cx-gray">
                      {enrolledProgress.completedLessons} / {enrolledProgress.totalLessons} leçon{enrolledProgress.totalLessons !== 1 ? 's' : ''}
                    </span>
                    {enrolledProgress.nextStep !== 'lesson' && (
                      <span className={`text-xs font-semibold ${
                        enrolledProgress.nextStep === 'quiz'       ? 'text-secondary'
                        : enrolledProgress.nextStep === 'final-exam' ? 'text-amber-600'
                        : 'text-success'
                      }`}>
                        {enrolledProgress.nextStep === 'quiz'       ? '→ Quiz du module requis'
                        : enrolledProgress.nextStep === 'final-exam' ? '→ Examen final disponible'
                        : '→ Prêt pour le certificat'}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Right: video + included card */}
            <div className="flex flex-col gap-4">

              {/* Video / cover */}
              <div className="aspect-video overflow-hidden rounded-3xl shadow-lg bg-black">
                {introVideoUrl ? (
                  <video
                    controls
                    preload="metadata"
                    className="w-full h-full object-contain bg-black"
                    poster={coverImage ?? undefined}
                  >
                    <source src={introVideoUrl} type="video/mp4" />
                    Your browser does not support the video tag.
                  </video>
                ) : coverImage ? (
                  <div className="relative w-full h-full">
                    <Image src={coverImage} alt={title} fill className="object-cover" priority />
                  </div>
                ) : (
                  <div className="w-full h-full bg-gradient-to-br from-primary/10 to-secondary/10 flex items-center justify-center">
                    <BookOpen className="w-16 h-16 text-primary/30" />
                  </div>
                )}
              </div>

              {/* What's included */}
              <div className="bg-white rounded-2xl border border-black/[0.07] p-4">
                <p className="text-xs font-bold text-cx-gray uppercase tracking-wide mb-3">Ce qui est inclus</p>
                <div className="grid grid-cols-2 gap-y-2 gap-x-2">
                  {[
                    `${modules.length} modules complets`,
                    `${totalLessons} leçons`,
                    'Quiz par module',
                    'Certificat de réussite',
                    'Accès mobile & desktop',
                    'Accès à vie',
                  ].map(item => (
                    <div key={item} className="flex items-center gap-1.5">
                      <CheckCircle className="w-3.5 h-3.5 text-success shrink-0" />
                      <span className="text-xs text-cx-gray">{item}</span>
                    </div>
                  ))}
                </div>

                <div className="mt-3 pt-3 border-t border-black/[0.06]">
                  {/* CAT-02 — the price is the DATABASE price, in every mode.
                      The two branches removed here replaced it with "Gratuit —
                      phase pilote" and "Droit d'accès requis", so a learner
                      could not discover what any course costs. */}
                  {isFree ? (
                    <div className="flex items-baseline gap-2">
                      <span className="text-lg font-extrabold text-success">Gratuit</span>
                      <span className="text-xs text-cx-gray">Acc&egrave;s complet &agrave; vie</span>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-baseline gap-2 mb-2">
                        <span className="text-lg font-extrabold text-dark">{formatPrice(price, currency)}</span>
                        <span className="text-xs text-cx-gray">Accès complet à vie</span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {['🟠 Orange Money', '🔵 Wave', '💳 Carte'].map(m => (
                          <span key={m} className="text-xs px-2 py-0.5 bg-light rounded-full text-cx-gray">{m}</span>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>

            </div>
          </div>
        </div>
      </section>

      {/* ══ Parcours membership (XPA-3) ════════════════════════════════ */}
      {memberPaths.length > 0 && (
        <section className="bg-white border-b border-black/[0.06] py-8">
          <div className="cx-container max-w-4xl">
            <h2 className="text-sm font-bold text-cx-gray uppercase tracking-wide mb-4">
              Cette formation fait partie des parcours
            </h2>
            <div className="flex flex-wrap gap-2">
              {memberPaths.map(p => (
                <Link
                  key={p.code}
                  href={pathHref(p)}
                  className="inline-flex items-center gap-2 px-3.5 py-2 rounded-full border border-black/[0.08] bg-light/60 text-sm text-dark hover:border-primary/40 hover:bg-primary/5 transition-colors"
                >
                  {/*
                    B-2.5: the internal catalogue code (PM-CONS, SEC-COM…) used to
                    render here in monospace beside the title. It is a join key, a
                    React key and a URL segment — none of which a visitor can read.
                    Worse, it was usually redundant: "PM-CONS Parcours Conseiller"
                    says the same thing twice, once in machine language. C1-F1
                    belongs to all fifteen paths, so its page showed fifteen of them.
                    The code is still the key and still drives pathHref; only the
                    rendered span is gone.
                  */}
                  {p.title}
                </Link>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ══ Learning outcomes ══════════════════════════════════════════ */}
      {meta?.objectives && meta.objectives.length > 0 && (
        <section className="bg-white border-b border-black/[0.06] py-10">
          <div className="cx-container max-w-4xl">
            <h2 className="text-xl font-extrabold text-dark mb-6">Ce que vous allez apprendre</h2>
            <div className="grid sm:grid-cols-2 gap-3">
              {meta.objectives.map(obj => (
                <div key={obj} className="flex items-start gap-3 p-3.5 rounded-xl border border-black/[0.05] bg-light/60">
                  <CheckCircle className="w-4 h-4 text-success shrink-0 mt-0.5" />
                  <span className="text-sm text-dark leading-snug">{obj}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ══ Curriculum ═════════════════════════════════════════════════ */}
      <section id="curriculum" className="py-10 md:py-14">
        <div className="cx-container max-w-3xl">
          <h2 className="text-xl font-extrabold text-dark mb-6">Programme de la formation</h2>

          <div className="flex flex-col gap-3">
            {modules.map((mod: typeof COURSE_MODULES[number], i: number) => (
              <details key={mod.slug} className="cx-card overflow-hidden group" open={i === 0}>
                <summary className="flex items-center justify-between p-4 sm:p-5 cursor-pointer list-none hover:bg-light/50 transition-colors">
                  <div className="flex items-center gap-3">
                    <span className="w-8 h-8 rounded-full bg-primary text-white flex items-center justify-center text-sm font-bold shrink-0">
                      {i + 1}
                    </span>
                    <div>
                      <p className="font-semibold text-dark text-sm">{mod.title}</p>
                      <p className="text-xs text-cx-gray mt-0.5">
                        {mod.lessons.length} leçon{mod.lessons.length !== 1 ? 's' : ''}
                      </p>
                    </div>
                  </div>
                  <ChevronDown className="w-4 h-4 text-cx-gray group-open:rotate-180 transition-transform shrink-0" />
                </summary>

                <div className="border-t border-black/[0.06] divide-y divide-black/[0.03]">
                  {mod.lessons.map((lesson: typeof COURSE_MODULES[number]['lessons'][number]) => (
                    <div key={lesson.slug} className="flex items-center gap-3 px-4 sm:px-5 py-3 hover:bg-light/30 transition-colors">
                      {(lesson.is_preview || FREE_ACCESS_MODE) ? (
                        <Play className="w-3.5 h-3.5 text-primary shrink-0" />
                      ) : (
                        <Lock className="w-3.5 h-3.5 text-cx-gray/50 shrink-0" />
                      )}
                      <span className="text-sm text-dark flex-1 leading-snug">{lesson.title}</span>
                      <div className="flex items-center gap-2 shrink-0">
                        {lesson.duration_minutes && (
                          <span className="text-xs text-cx-gray">{lesson.duration_minutes} min</span>
                        )}
                        {(lesson.is_preview || FREE_ACCESS_MODE) && (
                          <span className="text-[10px] font-bold text-success bg-green-50 px-2 py-0.5 rounded-full">
                            GRATUIT
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            ))}
          </div>

          {/* Bottom CTA */}
          <div className="mt-10 bg-light rounded-2xl p-8 text-center border border-black/[0.05]">
            {/* CAT-02 — one commercial line, derived from the course row.
                The four mode branches here said "Activation par un
                administrateur", "Phase pilote", or promised immediate access
                after a payment that is not activated. None of them told the
                reader the price. */}
            {/* CAT-02 — a learner who ALREADY holds access is not a sales
                prospect. This line pitched to everyone, so an entitled student
                opening a course they own read "Inscription bientôt disponible"
                under their own continue button. The commercial line is for
                people who cannot get in yet; for everyone else it is replaced
                by what they actually need to know. */}
            <p className="text-sm text-cx-gray mb-5">
              {ctaAccess.allowed
                ? 'Votre accès est actif · Certificat de réussite inclus'
                : isFree
                ? 'Formation gratuite · Certificat inclus · Compte requis'
                : paidPurchaseAvailable
                ? `${formatPrice(price, currency)} · Accès immédiat après paiement`
                : `${formatPrice(price, currency)} · Accès complet à vie · ${PURCHASE_UNAVAILABLE_NOTE}`}
            </p>
            {mayContinue ? (
              <Link
                href={continueHref}
                className="inline-flex items-center gap-2 px-10 py-4 bg-success text-white font-bold rounded-cx hover:opacity-90 transition-opacity text-base"
              >
                <Play className="w-5 h-5" /> Continuer la formation
              </Link>
            ) : (
              <Link
                href={learnHref}
                className="inline-flex items-center gap-2 px-10 py-4 bg-secondary text-white font-bold rounded-cx hover:bg-secondary-dark transition-all hover:-translate-y-0.5 shadow-btn text-base"
              >
                <Play className="w-5 h-5" />
                {/* UAT-ROUTE-02: same correction as the hero CTA. */}
                {ctaAccess.allowed
                  ? (enrolledProgress?.continueUrl ? 'Reprendre la formation' : 'Commencer la formation')
                  : accessRequestLabel}
              </Link>
            )}
            {/* CAT-02 — the secondary guest affordance.
                This was gated on `!PILOT_MODE && !FREE_ACCESS_MODE &&
                PLATFORM_MODE !== 'private'` and pointed BOTH links at
                `/checkout?course=...`, bypassing the state machine above. Dead
                under today's config, it would have woken up the moment
                PLATFORM_MODE moved to 'live' and sent guests into a checkout
                that PAYMENTS_ENABLED still refuses. The condition is now just
                "is this a guest", and the destination is the same safe target
                the main CTA uses, so the two cannot diverge. */}
            {!user && (
              <p className="text-xs text-cx-gray mt-4">
                <Link href={accessRequestHref} className="text-primary hover:underline">Connectez-vous</Link>
                {' '}ou{' '}
                <Link href={`/signup?next=${encodeURIComponent(lessonHref)}`} className="text-primary hover:underline">créez un compte</Link>
                {' '}pour accéder
              </p>
            )}
          </div>
        </div>
      </section>

    </div>
  )
}
