'use client'
import Link from 'next/link'
import { ChevronLeft, ChevronRight, CheckCircle, Award, ClipboardList, Lock, Star } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

export interface NavLesson {
  id:     string
  title:  string
  module: { id: string }
}

interface Props {
  courseSlug:           string
  prevLesson:           NavLesson | null
  nextLesson:           NavLesson | null
  completed:            boolean
  justCompleted:        boolean
  isLastLesson:         boolean
  isLastLessonInModule: boolean
  currentModHasQuiz:    boolean
  currentModPassed:     boolean
  nextIsBlocked:        boolean
  moduleId:             string | null
  /**
   * XPA-8 B-2.6 — this replaced `pilotMode`, and the change of name is the
   * whole fix.
   *
   * The completion control used to disappear whenever `PLATFORM_MODE=pilot`.
   * That encoded an assumption from the original pilot — that learners were
   * anonymous, so "save my progress" was meaningless — which UAT-ACCESS-01
   * retired when it made a signed-in learner take the authorized path in every
   * mode. The gate outlived its reason, and an operating-mode flag was left
   * deciding whether a learner could record academic progress.
   *
   * An operating mode is not an academic authority. Identity is: a learner with
   * a session has somewhere to persist completion and a server action that will
   * authorize it, and an anonymous pilot visitor has neither. So this is `true`
   * exactly when the viewer is signed in — the same value in pilot and in
   * private mode — and `PLATFORM_MODE` is consulted nowhere in this component.
   *
   * It is not named `isAuthenticated` because that is not what the caller is
   * asserting. It is asserting that a supported completion mechanism exists for
   * this viewer; who ultimately gets to complete the lesson is decided by the
   * entitlement seam server-side, and this prop is not that decision.
   */
  canComplete:          boolean
  hasFinalExam:         boolean
  finalExamPassed:      boolean
  onMarkComplete:       () => void
}

export default function LessonNavigation({
  courseSlug, prevLesson, nextLesson, completed, justCompleted,
  isLastLesson, isLastLessonInModule,
  currentModHasQuiz, currentModPassed, nextIsBlocked,
  moduleId, canComplete, hasFinalExam, finalExamPassed, onMarkComplete,
}: Props) {

  function renderPrimaryCTA() {
    // Don't show a separate CTA while auto-advance banner is visible
    if (justCompleted) return null

    // Structurally identical to the `if (pilotMode) return null` it replaces —
    // deliberately, so the only viewer whose experience changes is the one
    // B-2.6 is about: an AUTHENTICATED learner in pilot mode, who was shown no
    // completion control at all. Anonymous pilot browsing is untouched.
    if (!canComplete) return null

    if (!completed) {
      return (
        <button
          onClick={onMarkComplete}
          className="flex items-center gap-2 px-5 py-3 bg-success text-white font-semibold rounded-xl hover:opacity-90 active:scale-[0.98] transition-all text-sm"
        >
          <CheckCircle className="w-4 h-4" />
          Marquer comme complétée
        </button>
      )
    }

    // Quiz gate takes priority — even when this is the final lesson of the course.
    if (nextIsBlocked || (isLastLessonInModule && currentModHasQuiz && !currentModPassed)) {
      return (
        <Link
          href={`/learn/${courseSlug}/${moduleId}/quiz`}
          className="inline-flex items-center gap-2 px-6 py-3.5 bg-secondary text-white font-bold rounded-xl hover:opacity-90 active:scale-[0.98] transition-all text-sm shadow-sm"
        >
          <ClipboardList className="w-4 h-4" /> Passer au quiz du module
          <ChevronRight className="w-4 h-4" />
        </Link>
      )
    }

    if (isLastLesson && hasFinalExam && !finalExamPassed) {
      return (
        <Link
          href={`/learn/${courseSlug}/final-exam`}
          className="inline-flex items-center gap-2 px-6 py-3.5 bg-gradient-to-r from-amber-600 to-amber-400 text-white font-bold rounded-xl hover:opacity-90 active:scale-[0.98] transition-all text-sm shadow-lg shadow-amber-500/25"
        >
          <Star className="w-4 h-4" /> Passer l&apos;examen final <ChevronRight className="w-4 h-4" />
        </Link>
      )
    }

    if (isLastLesson) {
      return (
        <Link
          href={`/certificate/${courseSlug}`}
          className="inline-flex items-center gap-2 px-6 py-3.5 bg-gradient-to-r from-amber-500 to-yellow-400 text-white font-bold rounded-xl hover:opacity-90 active:scale-[0.98] transition-all text-sm shadow-lg shadow-amber-500/25"
        >
          <Award className="w-4 h-4" /> Obtenir mon certificat 🎉
        </Link>
      )
    }

    if (nextLesson) {
      return (
        <Link
          href={`/learn/${courseSlug}/${nextLesson.module.id}/${nextLesson.id}`}
          className="inline-flex items-center gap-2 px-6 py-3.5 bg-primary text-white font-bold rounded-xl hover:opacity-90 active:scale-[0.98] transition-all text-sm shadow-sm"
        >
          Leçon suivante <ChevronRight className="w-5 h-5" />
        </Link>
      )
    }

    return (
      <span className="flex items-center gap-2 text-success font-semibold text-sm">
        <CheckCircle className="w-5 h-5" /> Leçon complétée
      </span>
    )
  }

  // ── Mobile right-side button ───────────────────────────────────────────────
  function renderMobileRight() {
    // Quiz gate takes priority — even when this is the final lesson of the course.
    if (nextIsBlocked || (isLastLessonInModule && currentModHasQuiz && !currentModPassed)) {
      return (
        <Link
          href={`/learn/${courseSlug}/${moduleId}/quiz`}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-secondary/20 border border-secondary/30 text-secondary text-sm font-semibold hover:bg-secondary/30 transition-colors active:scale-[0.97]"
        >
          <ClipboardList className="w-4 h-4" />
          <span className="text-xs">Quiz</span>
        </Link>
      )
    }
    if (isLastLesson && hasFinalExam && !finalExamPassed) {
      return (
        <Link
          href={`/learn/${courseSlug}/final-exam`}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-gradient-to-r from-amber-600 to-amber-400 text-white text-sm font-bold hover:opacity-90 transition-opacity active:scale-[0.97]"
        >
          <Star className="w-4 h-4" />
        </Link>
      )
    }
    if (isLastLesson) {
      return (
        <Link
          href={`/certificate/${courseSlug}`}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-gradient-to-r from-amber-500 to-yellow-400 text-white text-sm font-bold hover:opacity-90 transition-opacity active:scale-[0.97]"
        >
          <Award className="w-4 h-4" />
        </Link>
      )
    }
    if (nextLesson) {
      return (
        <Link
          href={`/learn/${courseSlug}/${nextLesson.module.id}/${nextLesson.id}`}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary/20 border border-primary/30 text-primary text-sm font-semibold hover:bg-primary/30 transition-colors active:scale-[0.97]"
        >
          <span className="text-xs">Suivante</span>
          <ChevronRight className="w-4 h-4" />
        </Link>
      )
    }
    return <div className="w-12" />
  }

  return (
    <>
      {/* ── Inline bottom navigation ────────────────────────────────────── */}
      <div className="mt-6 pt-5 border-t border-white/10 space-y-4">
        {renderPrimaryCTA()}

        <div className="flex items-center gap-3 flex-wrap">
          {prevLesson ? (
            <Link
              href={`/learn/${courseSlug}/${prevLesson.module.id}/${prevLesson.id}`}
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-white/10 text-white/70 text-sm font-medium rounded-xl hover:bg-white/15 hover:text-white active:scale-[0.98] transition-all"
            >
              <ChevronLeft className="w-4 h-4" /> Leçon précédente
            </Link>
          ) : (
            <span className="inline-flex items-center gap-2 px-4 py-2.5 text-white/20 text-sm select-none">
              <ChevronLeft className="w-4 h-4" /> Première leçon
            </span>
          )}

          {nextIsBlocked && !justCompleted && (
            <span className="flex items-center gap-1.5 text-xs text-white/30 italic ml-auto">
              <Lock className="w-3.5 h-3.5" /> Quiz requis pour continuer
            </span>
          )}
        </div>

        {/* The caption is a factual claim about persistence, so it follows the
            same signal: a signed-in learner's progress IS saved server-side, in
            pilot and in private mode alike. An anonymous visitor's is not, and
            was never promised it. */}
        {canComplete && (
          <p className="text-[11px] text-white/20">
            Votre progression est sauvegardée automatiquement.
          </p>
        )}
      </div>

      {/* ── Mobile sticky bottom bar ─────────────────────────────────────── */}
      <div className={cn(
        'md:hidden fixed bottom-0 left-0 right-0 z-20',
        'bg-[#1a1d27]/95 backdrop-blur border-t border-white/10',
        'flex items-center justify-between px-4 py-3 gap-3'
      )}>
        {/* Left: prev */}
        {prevLesson ? (
          <Link
            href={`/learn/${courseSlug}/${prevLesson.module.id}/${prevLesson.id}`}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/10 text-white/70 text-sm font-medium hover:bg-white/15 transition-colors active:scale-[0.97]"
          >
            <ChevronLeft className="w-4 h-4" />
            <span className="text-xs">Préc.</span>
          </Link>
        ) : (
          <div className="w-16" />
        )}

        {/* Center: mark complete or completed status */}
        {canComplete && !completed && (
          <button
            onClick={onMarkComplete}
            className="flex-1 max-w-[200px] flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-success/20 border border-success/30 text-success text-xs font-semibold hover:bg-success/30 transition-colors"
          >
            <CheckCircle className="w-3.5 h-3.5" /> Terminer
          </button>
        )}
        {canComplete && completed && !isLastLesson && (
          <div className="flex-1 max-w-[200px] flex items-center justify-center gap-1.5 text-success/60 text-xs font-medium">
            <CheckCircle className="w-3.5 h-3.5" />
            <span>Complétée</span>
          </div>
        )}
        {!canComplete && <div className="flex-1" />}

        {/* Right: next destination */}
        {renderMobileRight()}
      </div>
    </>
  )
}
