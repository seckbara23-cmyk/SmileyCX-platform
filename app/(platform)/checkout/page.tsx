import Link from 'next/link'
import { redirect, notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import PaytechCheckoutButton from '@/components/payment/PaytechCheckoutButton'
import { formatPrice } from '@/lib/utils/cn'
import { paytechCheckoutAvailability } from '@/lib/payments/providers'
import { resolveCourseAccessById } from '@/lib/auth/course-access'

// ENR-01C-b dropped PILOT_MODE from this page: the pilot redirect was its
// last consumer here, and a deployment mode is not an access fact.
//
// XP-PAYTECH-04 dropped PAYMENTS_ENABLED too. It was a NEXT_PUBLIC_ build-time
// flag, so a browser-visible variable decided whether money could be taken,
// and when true it rendered PaymentMethodSelector — a form that collected card
// numbers and CVVs on this page and wrote a pending row nothing ever settled.
// The decision is now `paytechCheckoutAvailability()`, evaluated on the server
// from server-only variables, and the only control is a PayTech redirect.
import type { Metadata } from 'next'

// ENR-01C-a — three imports left with the code that used them.
//
//   FLAGSHIP_COURSE  the phantom-course fallback (C1). The seed module is no
//                    longer a source of course identity on any public or
//                    commercial page.
//   enrollForFree    the dead free-enrollment branch (C4). This page now
//                    writes nothing at all.
//   FREE_ACCESS_MODE its last two uses were that branch and the page title
//                    below. PILOT_MODE is untouched and still read on line ~50.
//
// `lib/pilot.ts` is unchanged and FREE_ACCESS_MODE still has three consumers:
// checkout/confirm/page.tsx and app/actions/enrollment.ts.

export const metadata: Metadata = {
  // ENR-01C-a (C5) — this read "Inscription gratuite" under pilot mode, which
  // titled a browser tab with a claim CAT-02's prices contradict. Static
  // metadata cannot read the course row, so it states neither a price nor a
  // freeness: the one word that is true in every mode.
  title: 'Inscription',
}

interface Props { searchParams: Promise<{ course?: string }> }

export default async function CheckoutPage({ searchParams }: Props) {
  const { course: courseId } = await searchParams
  if (!courseId) redirect('/courses')

  const supabase = await createClient()

  // ENR-01C-a (C1) — the course is whatever the DATABASE says, or nothing.
  //
  // This used to fall back to `data/seed.ts` for the old flagship slug and for
  // the literal id 'seed', fabricating a course object with `id: 'seed'`. That
  // is the same phantom-course escape hatch CAT-02 removed from the public
  // detail page, left behind here: `?course=comprendre-client-qualite-experience`
  // or `?course=seed` produced a checkout for a course that exists in no row.
  //
  // `courseId` arrives from the query string and is not validated as a uuid, so
  // a non-uuid makes this query error and return no row — which is the same
  // answer as "not found", and is handled identically.
  const { data: course } = await supabase
    .from('courses')
    .select('*')
    .eq('id', courseId)
    .single()

  if (!course) notFound()

  // ENR-01C-b (C2) — a PILOT_MODE block stood here and sent every caller
  // straight into a lesson. It read, ABOVE the auth check and above any
  // access resolution:
  //
  //   if (PILOT_MODE) {            // "No auth or enrollment needed"
  //     … read modules/lessons …
  //     … then sent the caller to the first lesson under /learn …
  //   }
  //
  // A DEPLOYMENT MODE IS NOT AN ACCESS GRANT. `PILOT_MODE` appears in no
  // policy, no function and no grant; `resolveCourseAccess` is the authority
  // and this block never asked it. Production runs PLATFORM_MODE=pilot, so a
  // signed-in learner following any checkout link was bounced into a lesson
  // the learn layout then refused: CTA -> checkout -> lesson -> denial. The
  // route itself always held, so this was never a bypass — it was the page
  // promising entry the gate denies, the same shape CAT-02 removed from the
  // price and ENR-01B from the lesson badge.
  //
  // Nothing replaces it here. Control now falls through to the auth check, the
  // enrollment check (C3, deliberately untouched), the entitlement check below,
  // and finally the priced panel — all of which already exist.

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect(`/login?next=/checkout?course=${courseId}`)

  // Load profile
  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single()
  if (!profile) redirect(`/login?next=/checkout?course=${courseId}`)

  // ENR-01C-c (C3) — an enrollment row used to decide this, and it is not
  // evidence of anything commercial.
  //
  // What stood here read `enrollments` and, on finding a row, redirected to
  // /dashboard as though the learner already had the course:
  //
  //   if (existing) redirect('/dashboard')
  //
  // Per Q-L and migration 037 an enrollment is an ACADEMIC TRANSCRIPT and
  // authorizes nothing — `has_course_access()` does not read the table at all.
  // So this check answered a commercial question with an academic fact, and it
  // ran BEFORE the entitlement check, which meant it won.
  //
  // Two live production rows sat in exactly that state: one learner holds
  // active enrollments in C1-F4 and C2-F5 with NO entitlement row of any kind,
  // both with payment_id null — records left by the retired pilot path. They
  // were bounced to /dashboard, which shows them nothing, and could not reach
  // the price of the paid course they might want to buy. The mirror case also
  // exists: one learner holds a live MANUAL_ADMIN entitlement with no
  // enrollment row, and was treated as a prospect until ENR-01C-b.
  //
  // Nothing replaces it. The entitlement check below was already the correct
  // authority; removing this leaves it as the ONLY one, so checkout now agrees
  // with the course page, the learn layout and the media route by construction
  // rather than by coincidence. A revoked, expired, suspended or absent
  // entitlement all deny here for the same reason they deny there.

  // ENR-01C-b (C2) — an ALREADY-ENTITLED learner is not a sales prospect.
  //
  // Deleting the pilot redirect would otherwise have shown the priced panel
  // ("Inscription bientôt disponible") to someone who already holds access and
  // simply has no enrollment row yet — a real production state: one live
  // entitlement currently exists with no matching enrollment.
  //
  // The authority is `resolveCourseAccessById`, the same seam the learn layout,
  // the media route and `ensureAcademicEnrollment` use, and which
  // `has_course_access()` mirrors in SQL. This DELEGATES to it rather than
  // re-deciding anything, so no authorization logic is duplicated here, and it
  // deliberately does NOT read the enrollment row above: an enrollment is an
  // academic transcript and authorizes nothing (Q-L, migration 037).
  //
  // The destination is the COURSE PAGE, not a lesson URL. That page already
  // resolves this learner's access and renders the correct progress-aware CTA
  // (CAT-02 / ENR-01B), so checkout computes no lesson route and can promise
  // nothing the gate would refuse.
  const access = await resolveCourseAccessById(String(course.id))
  if (access.allowed) redirect(`/courses/${course.slug}`)

  // ENR-01C-a (C4) — a TEMP_FREE_ACCESS block stood here and was DEAD CODE.
  //
  // It read `if (FREE_ACCESS_MODE) { await enrollForFree(course.id); redirect() }`.
  // But `FREE_ACCESS_MODE` and `PILOT_MODE` are the SAME predicate --
  // `PLATFORM_MODE === 'pilot'` (lib/pilot.ts) -- and the `if (PILOT_MODE)`
  // branch above returns unconditionally, so this could never be reached: by
  // the time control arrived here, FREE_ACCESS_MODE was provably false.
  //
  // Had it been reachable it was also wrong twice over: it called
  // `enrollForFree` for ANY course including the paid ones, and it DISCARDED
  // the result, so a learner was redirected to /dashboard and told they were
  // enrolled whether or not anything had been written. (`enrollForFree` is
  // itself closed behind SELF_ENROLLMENT_OPEN and writes no entitlement, so
  // nothing was ever granted.) Removed rather than repaired: free enrollment
  // is ENR-01E/F and will be a server action with its own authority checks.
  //
  // NOTHING replaces it. This slice introduces no enrollment or entitlement
  // write of any kind.

  // ── Can this deployment take a payment? (server-side) ─────────────────────
  //
  // XP-PAYTECH-04: the server-only PayTech checkout availability, not a
  // NEXT_PUBLIC flag. When it is off, the honest "not yet" panel below is shown.
  //
  // ENR-01C-a (C5). This panel announced "Accès gratuit en cours -- La
  // plateforme est en phase pilote. L'accès aux formations est entièrement
  // gratuit et ne nécessite aucun paiement", and offered "Accéder à ma
  // formation" pointing at /dashboard.
  //
  // Every clause of that was false once CAT-02 published real prices: the
  // courses are not free, no access follows from arriving here, and /dashboard
  // shows nothing to a learner with no entitlement. It described how the
  // platform was once operated rather than what this course costs.
  //
  // The replacement states the commercial fact from the course ROW, using the
  // same derivation and the same wording as the public detail page, and sends
  // the learner somewhere that works.
  if (!paytechCheckoutAvailability().available) {
    const price    = Number(course.price)
    const currency = String(course.currency)
    const isFree   = course.is_free === true

    return (
      <div className="cx-section">
        <div className="cx-container max-w-2xl text-center py-16">
          <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-6">
            <span className="text-3xl">🎓</span>
          </div>
          <h1 className="text-2xl font-extrabold text-dark mb-3">
            Inscription bient&ocirc;t disponible
          </h1>
          <p className="text-cx-gray mb-2 max-w-md mx-auto font-semibold text-dark">
            {isFree
              ? 'Formation gratuite · Certificat inclus · Compte requis'
              : `${formatPrice(price, currency)} · Accès complet à vie · Certificat inclus`}
          </p>
          <p className="text-cx-gray mb-8 max-w-md mx-auto text-sm">
            Le paiement en ligne n&apos;est pas encore activé pour cette formation.
            Contactez-nous pour organiser votre inscription.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link
              href={`/contact?course=${encodeURIComponent(String(course.slug))}`}
              className="inline-block px-6 py-3 bg-primary text-white font-bold rounded-cx hover:opacity-90 transition-opacity"
            >
              Nous contacter
            </Link>
            <Link
              href={`/courses/${course.slug}`}
              className="inline-block px-6 py-3 bg-light border border-black/[0.08] text-dark font-semibold rounded-cx hover:bg-white transition-colors"
            >
              Revenir &agrave; la formation
            </Link>
          </div>
        </div>
      </div>
    )
  }

  // Below is the payment UI — reached only when PayTech checkout is available here.
  return (
    <div className="cx-section">
      <div className="cx-container max-w-4xl">
        <h1 className="text-2xl font-extrabold text-dark mb-8">
          Finaliser votre inscription
        </h1>

        <div className="grid md:grid-cols-[1fr_320px] lg:grid-cols-[1fr_360px] gap-6 md:gap-8 items-start">
          {/* Payment selector */}
          <div className="cx-card p-6">
            <h2 className="text-lg font-bold text-dark mb-6">
              Paiement sécurisé
            </h2>
            <PaytechCheckoutButton courseId={String(course.id)} />
          </div>

          {/* Order summary */}
          <div className="cx-card p-4 sm:p-6 md:sticky md:top-24">
            <h2 className="text-base font-bold text-dark mb-4">Récapitulatif</h2>

            <div className="flex gap-3 mb-4 pb-4 border-b border-black/[0.06]">
              <div className="w-16 h-16 rounded-cx bg-primary/10 flex items-center justify-center text-primary font-extrabold text-xl shrink-0">
                CX
              </div>
              <div className="min-w-0">
                <p className="font-semibold text-dark text-sm leading-tight">
                  {course.title}
                </p>
                <p className="text-xs text-cx-gray mt-1">Accès complet · Certificat</p>
              </div>
            </div>

            <div className="flex flex-col gap-2 mb-4 text-sm">
              <div className="flex justify-between text-cx-gray">
                <span>Prix</span>
                <span>{formatPrice(course.price, course.currency)}</span>
              </div>
              <div className="flex justify-between text-cx-gray">
                <span>Frais</span>
                <span>Inclus</span>
              </div>
            </div>

            <div className="flex justify-between font-bold text-dark border-t border-black/[0.06] pt-3">
              <span>Total</span>
              <span className="text-lg">{formatPrice(course.price, course.currency)}</span>
            </div>

            <div className="mt-4 pt-4 border-t border-black/[0.06] text-xs text-cx-gray space-y-1">
              <p>✅ Accès activé dès la confirmation du paiement</p>
              <p>✅ Contenu à vie</p>
              <p>✅ Certificat de réussite</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
