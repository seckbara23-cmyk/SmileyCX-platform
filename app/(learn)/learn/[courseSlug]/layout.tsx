import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Lock, ArrowRight, Mail } from 'lucide-react'
import { resolveCourseAccess, denialMessage } from '@/lib/auth/course-access'
import { coursePageHref } from '@/lib/learn/routes'

/**
 * Course-access gate for every learning route (XPA-6A).
 *
 * Covers the lesson player, module quizzes and the final exam in one place,
 * because it sits above `[courseSlug]` and they all live below it.
 *
 * ── THIS IS NOT THE ENFORCEMENT POINT ────────────────────────────────────
 * RLS is (migration 035). If this file were deleted, an unentitled learner
 * would reach the player and see nothing at all — every query would return zero
 * rows. What this adds is HONESTY: an explicit "you are not enrolled" instead of
 * a functioning page with no content in it, which reads as a bug.
 *
 * The distinction matters for review: nothing here can be bypassed into access,
 * because nothing here grants access.
 */
export default async function CourseAccessLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: { courseSlug: string }
}) {
  const access = await resolveCourseAccess(params.courseSlug)

  if (access.allowed) return <>{children}</>

  // Sign-in is a redirect rather than a message: there is a well-defined place
  // to send them, and ?next brings them straight back.
  if (access.reason === 'not_authenticated') {
    redirect(`/login?next=${encodeURIComponent(`/learn/${params.courseSlug}`)}`)
  }

  const { title, body } = denialMessage(access.reason ?? 'not_entitled')
  const unverified = access.reason === 'email_unverified'

  return (
    <div className="bg-light min-h-screen flex items-center justify-center px-4 py-16">
      <div className="cx-card p-8 max-w-md w-full text-center">
        <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-5">
          {unverified
            ? <Mail className="w-7 h-7 text-primary" />
            : <Lock className="w-7 h-7 text-primary" />}
        </div>

        <h1 className="text-xl font-extrabold text-dark mb-2">{title}</h1>
        <p className="text-sm text-cx-gray leading-relaxed mb-6">{body}</p>

        <div className="flex flex-col gap-2">
          {/*
            UAT-ROUTE-01. This said "Voir la formation" — the same words the
            learner clicked to arrive here, pointing back at the page they came
            from. It read as "try again" and simply looped. The destination was
            always correct (a public course page, never a gated lesson route);
            only the label promised entry it cannot grant.
          */}
          <Link
            href={coursePageHref(params.courseSlug)}
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-primary text-white font-bold rounded-cx hover:opacity-90 transition-opacity text-sm"
          >
            Retour à la fiche de formation <ArrowRight className="w-4 h-4" />
          </Link>
          <Link
            href="/dashboard"
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-light border border-black/[0.08] text-cx-gray font-semibold rounded-cx hover:bg-white transition-colors text-sm"
          >
            Mon espace
          </Link>
        </div>
      </div>
    </div>
  )
}
