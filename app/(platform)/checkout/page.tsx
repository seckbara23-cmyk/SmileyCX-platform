import { redirect, notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import PaymentMethodSelector from '@/components/payment/PaymentMethodSelector'
import { formatPrice } from '@/lib/utils/cn'
import { FLAGSHIP_COURSE } from '@/data/seed'
import { FREE_ACCESS_MODE, PILOT_MODE } from '@/lib/pilot'
import { enrollForFree } from '@/app/actions/enrollment'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: FREE_ACCESS_MODE || PILOT_MODE ? 'Inscription gratuite' : 'Paiement',
}

interface Props { searchParams: Promise<{ course?: string }> }

export default async function CheckoutPage({ searchParams }: Props) {
  const { course: courseId } = await searchParams
  if (!courseId) redirect('/courses')

  const supabase = await createClient()

  // Load course first — needed for both pilot and payment paths
  let course = null
  const { data: dbCourse } = await supabase
    .from('courses')
    .select('*')
    .eq('id', courseId)
    .single()

  if (dbCourse) {
    course = dbCourse
  } else if (courseId === FLAGSHIP_COURSE.slug || courseId === 'seed') {
    course = { ...FLAGSHIP_COURSE, id: 'seed', created_at: '', updated_at: '' }
  } else {
    notFound()
  }

  // ── PILOT_MODE: No auth or enrollment needed — go straight to learning ─────
  if (PILOT_MODE) {
    const { data: firstMod } = await supabase
      .from('modules')
      .select('id, slug, lessons(id, slug)')
      .eq('course_id', course.id)
      .order('order_index')
      .limit(1)
      .maybeSingle()

    const firstLesson = (firstMod?.lessons as { id: string; slug: string }[] | null)?.[0]
    if (firstMod && firstLesson) {
      redirect(`/learn/${course.slug}/${firstMod.slug ?? firstMod.id}/${firstLesson.slug ?? firstLesson.id}`)
    }
    redirect(`/courses/${course.slug}`)
  }
  // ── End PILOT_MODE ─────────────────────────────────────────────────────────

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect(`/login?next=/checkout?course=${courseId}`)

  // Load profile
  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single()
  if (!profile) redirect(`/login?next=/checkout?course=${courseId}`)

  // If already enrolled, send to dashboard
  const { data: existing } = await supabase
    .from('enrollments')
    .select('id')
    .eq('user_id', user.id)
    .eq('course_id', course.id)
    .single()
  if (existing) redirect('/dashboard')

  // ── TEMP_FREE_ACCESS: Bypass payment during pilot ──────────────────────────
  // When FREE_ACCESS_MODE is true, create an active enrollment immediately
  // without going through any payment gateway.
  // To restore payment: remove this entire block.
  if (FREE_ACCESS_MODE) {
    if (course.id !== 'seed') {
      await enrollForFree(course.id)
    }
    redirect('/dashboard')
  }
  // ── End TEMP_FREE_ACCESS ───────────────────────────────────────────────────

  // Below is the payment UI — only reached when FREE_ACCESS_MODE is false
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
              Choisir un mode de paiement
            </h2>
            <PaymentMethodSelector course={course} profile={profile} />
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
              <p>✅ Accès immédiat après paiement</p>
              <p>✅ Contenu à vie</p>
              <p>✅ Certificat de réussite</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
