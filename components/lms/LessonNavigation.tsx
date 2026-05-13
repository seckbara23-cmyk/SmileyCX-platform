'use client'
import Link from 'next/link'
import { ChevronLeft, ChevronRight, CheckCircle, Award, ClipboardList, Lock } from 'lucide-react'
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
  isLastLesson:         boolean
  isLastLessonInModule: boolean
  currentModHasQuiz:    boolean
  currentModPassed:     boolean
  nextIsBlocked:        boolean
  moduleId:             string | null
  pilotMode:            boolean
  onMarkComplete:       () => void
}

export default function LessonNavigation({
  courseSlug, prevLesson, nextLesson, completed,
  isLastLesson, isLastLessonInModule,
  currentModHasQuiz, currentModPassed, nextIsBlocked,
  moduleId, pilotMode, onMarkComplete,
}: Props) {

  // Build the primary CTA for the bottom of the content area
  function renderPrimaryCTA() {
    if (pilotMode) return null

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

    if (isLastLesson) {
      return (
        <Link
          href={`/certificate/${courseSlug}`}
          className="inline-flex items-center gap-2 px-6 py-3.5 bg-gradient-to-r from-amber-500 to-yellow-400 text-white font-bold rounded-xl hover:opacity-90 active:scale-[0.98] transition-all text-sm shadow-lg shadow-amber-500/25 animate-pulse-once"
        >
          <Award className="w-4 h-4" /> Obtenir mon certificat 🎉
        </Link>
      )
    }

    if (isLastLessonInModule && currentModHasQuiz && !currentModPassed) {
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

    if (nextLesson && !nextIsBlocked) {
      return (
        <Link
          href={`/learn/${courseSlug}/${nextLesson.module.id}/${nextLesson.id}`}
          className="inline-flex items-center gap-2 px-6 py-3.5 bg-primary text-white font-bold rounded-xl hover:opacity-90 active:scale-[0.98] transition-all text-sm shadow-sm"
        >
          Leçon suivante <ChevronRight className="w-5 h-5" />
        </Link>
      )
    }

    // Completed, next is gated by an un-passed quiz
    if (nextIsBlocked) {
      return (
        <Link
          href={`/learn/${courseSlug}/${moduleId}/quiz`}
          className="inline-flex items-center gap-2 px-6 py-3.5 bg-secondary text-white font-bold rounded-xl hover:opacity-90 active:scale-[0.98] transition-all text-sm shadow-sm"
        >
          <ClipboardList className="w-4 h-4" /> Passer au quiz pour continuer
          <ChevronRight className="w-4 h-4" />
        </Link>
      )
    }

    return (
      <span className="flex items-center gap-2 text-success font-semibold text-sm">
        <CheckCircle className="w-5 h-5" /> Leçon complétée
      </span>
    )
  }

  return (
    <>
      {/* ── Inline bottom navigation (desktop + mobile scroll) ──────────── */}
      <div className="mt-10 pt-6 border-t border-white/10 space-y-5">
        {renderPrimaryCTA()}

        {/* Prev / Next row */}
        <div className="flex items-center gap-3 flex-wrap">
          {prevLesson ? (
            <Link
              href={`/learn/${courseSlug}/${prevLesson.module.id}/${prevLesson.id}`}
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-white/10 text-white/70 text-sm font-medium rounded-xl hover:bg-white/15 hover:text-white active:scale-[0.98] transition-all"
            >
              <ChevronLeft className="w-4 h-4" /> Leçon précédente
            </Link>
          ) : (
            <span className="inline-flex items-center gap-2 px-4 py-2.5 text-white/20 text-sm cursor-not-allowed">
              <ChevronLeft className="w-4 h-4" /> Première leçon
            </span>
          )}

          {nextIsBlocked && (
            <span className="flex items-center gap-1.5 text-xs text-white/30 italic ml-auto">
              <Lock className="w-3.5 h-3.5" /> Quiz requis pour continuer
            </span>
          )}
        </div>

        {!pilotMode && (
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
        {prevLesson ? (
          <Link
            href={`/learn/${courseSlug}/${prevLesson.module.id}/${prevLesson.id}`}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white/10 text-white/70 text-sm font-medium hover:bg-white/15 transition-colors active:scale-[0.97]"
          >
            <ChevronLeft className="w-4 h-4" />
            <span className="hidden xs:inline">Précédente</span>
          </Link>
        ) : (
          <div className="w-12" />
        )}

        {/* Mobile center: completion or progress hint */}
        {!pilotMode && !completed && (
          <button
            onClick={onMarkComplete}
            className="flex-1 max-w-[200px] flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-success/20 border border-success/30 text-success text-xs font-semibold hover:bg-success/30 transition-colors"
          >
            <CheckCircle className="w-3.5 h-3.5" /> Terminer
          </button>
        )}
        {completed && !isLastLesson && !nextIsBlocked && nextLesson && (
          <div className="flex-1 max-w-[200px]" />
        )}

        {/* Right: next */}
        {isLastLesson ? (
          <Link
            href={`/certificate/${courseSlug}`}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-gradient-to-r from-amber-500 to-yellow-400 text-white text-sm font-bold hover:opacity-90 transition-opacity active:scale-[0.97]"
          >
            <Award className="w-4 h-4" />
          </Link>
        ) : nextIsBlocked ? (
          <Link
            href={`/learn/${courseSlug}/${moduleId}/quiz`}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-secondary/20 border border-secondary/30 text-secondary text-sm font-semibold hover:bg-secondary/30 transition-colors active:scale-[0.97]"
          >
            <ClipboardList className="w-4 h-4" />
            <span className="hidden xs:inline">Quiz</span>
          </Link>
        ) : nextLesson ? (
          <Link
            href={`/learn/${courseSlug}/${nextLesson.module.id}/${nextLesson.id}`}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary/20 border border-primary/30 text-primary text-sm font-semibold hover:bg-primary/30 transition-colors active:scale-[0.97]"
          >
            <span className="hidden xs:inline">Suivante</span>
            <ChevronRight className="w-4 h-4" />
          </Link>
        ) : (
          <div className="w-12" />
        )}
      </div>
    </>
  )
}
