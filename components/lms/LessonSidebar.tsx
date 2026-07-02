'use client'
import Link from 'next/link'
import { Check, CheckCircle, ClipboardList } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { buildSidebarStructure } from './sidebarStructure'

export interface SidebarLessonRow {
  id: string; slug: string; title: string; order_index: number
  content: string | null; video_url: string | null
  subtitle_url: string | null; duration_minutes: number | null
}
export interface SidebarModuleRow {
  id: string; slug: string; title: string; order_index: number
  lessons: SidebarLessonRow[]
}

interface Props {
  modules:            SidebarModuleRow[]
  courseSlug:         string
  activeLessonId:     string | null
  activeModuleId:     string | null
  progress:           Record<string, boolean>
  validatedModules:   Set<string>
  modulesWithQuiz:    Set<string>
  hasFinalExam:       boolean
  finalExamPassed:    boolean
  isFinalExamActive:  boolean
  pilotMode:          boolean
  sideOpen:           boolean
  onClose:            () => void
}

export default function LessonSidebar({
  modules, courseSlug, activeLessonId, activeModuleId,
  progress, validatedModules, modulesWithQuiz,
  hasFinalExam, finalExamPassed, isFinalExamActive,
  pilotMode, sideOpen, onClose,
}: Props) {
  // Split into a standalone intro section + numbered modules. Progress totals
  // are computed from this same structure so the standalone lessons stay counted
  // exactly as before (they are only relocated in the UI, not removed).
  const { standalone, modules: numberedModules } = buildSidebarStructure(modules)

  const totalLessons =
    standalone.length +
    numberedModules.reduce((s, m) => s + m.lessons.length + (modulesWithQuiz.has(m.id) ? 1 : 0), 0) +
    (hasFinalExam ? 1 : 0)
  const completedLessons =
    standalone.filter(s => !!progress[s.lesson.id]).length +
    numberedModules.reduce((s, m) => {
      const lessons = m.lessons.filter(l => !!progress[l.id]).length
      const quiz    = modulesWithQuiz.has(m.id) && validatedModules.has(m.id) ? 1 : 0
      return s + lessons + quiz
    }, 0) +
    (hasFinalExam && finalExamPassed ? 1 : 0)
  const progressPct = totalLessons > 0 ? Math.round((completedLessons / totalLessons) * 100) : 0

  // ── Shared lesson-link renderer (used by both the standalone section and the
  //    numbered modules) ─────────────────────────────────────────────────────
  function renderLessonLink(les: SidebarLessonRow, moduleId: string) {
    const isActive = les.id === activeLessonId
    const isDone   = !!progress[les.id]
    return (
      <Link
        key={les.id}
        href={`/learn/${courseSlug}/${moduleId}/${les.id}`}
        onClick={onClose}
        className={cn(
          'flex items-start gap-3 mx-2.5 px-3.5 py-3 rounded-lg transition-all duration-150 border-l-2',
          isActive
            ? 'bg-primary/[0.12] border-primary'
            : 'border-transparent hover:bg-white/[0.06] hover:border-white/20'
        )}
      >
        {/* State indicator */}
        {isDone ? (
          <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center shrink-0 mt-0.5">
            <Check className="w-3 h-3 text-white" strokeWidth={3} />
          </div>
        ) : isActive ? (
          <div className="w-5 h-5 rounded-full border-2 border-primary bg-primary/20 ring-2 ring-primary/20 shrink-0 mt-0.5" />
        ) : (
          <div className="w-5 h-5 rounded-full border-2 border-white/35 shrink-0 mt-0.5" />
        )}

        <span className={cn(
          'leading-snug line-clamp-2 text-[0.9375rem]',
          isActive  ? 'text-white font-semibold'
          : isDone  ? 'text-white/95 font-medium'
                    : 'text-white/90 font-medium'
        )}>
          {les.title}
        </span>
      </Link>
    )
  }

  return (
    <>
      {/* Mobile backdrop */}
      {sideOpen && (
        <div
          className="md:hidden fixed inset-0 z-30 bg-black/60"
          onClick={onClose}
          aria-hidden
        />
      )}

      <aside className={cn(
        'lms-sidebar bg-[#1a1d27] border-r border-white/10 overflow-y-auto overflow-x-hidden shrink-0',
        'transition-all duration-300 z-40',
        'fixed md:static top-[48px] md:top-0 bottom-0 left-0 md:h-full',
        sideOpen ? 'w-[21.5rem] shadow-2xl shadow-black/50' : 'w-0 md:w-[21.5rem]',
      )}>
        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="px-6 pt-5 pb-6 border-b border-white/[0.08]">
          <Link
            href={pilotMode ? '/courses' : '/dashboard'}
            className="text-xs text-white/60 hover:text-white transition-colors"
          >
            ← {pilotMode ? 'Les formations' : 'Mon espace'}
          </Link>

          {totalLessons > 0 && (
            <div className="mt-6">
              <div className="flex items-center justify-between mb-3">
                <span className="text-[11px] font-bold text-white/60 uppercase tracking-widest">
                  {pilotMode ? 'Progression' : 'Ma progression'}
                </span>
                <span className="text-xs font-bold text-primary tabular-nums">
                  {progressPct}%
                </span>
              </div>
              <div className="w-full h-2.5 bg-white/10 rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-[width] duration-700 ease-out"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <p className="text-[11px] text-white/50 mt-2.5 tabular-nums">
                {completedLessons}&nbsp;/&nbsp;{totalLessons} leçon{totalLessons > 1 ? 's' : ''} complétée{completedLessons > 1 ? 's' : ''}
              </p>
            </div>
          )}

          {pilotMode && totalLessons === 0 && (
            <p className="text-[10px] text-white/30 mt-2 leading-tight">
              Explorez librement toutes les leçons.
            </p>
          )}
        </div>

        <nav className="pt-2 pb-8">
          {/* ── Standalone intro lessons (before all modules) ──────────────── */}
          {standalone.length > 0 && (
            <div className="mt-3">
              <div className="px-6 pt-4 pb-3 bg-white/[0.03] border-t border-white/[0.06]">
                <p className="text-xs font-bold text-white/90 uppercase tracking-wide leading-tight">
                  Introduction
                </p>
              </div>
              {standalone.map(s => renderLessonLink(s.lesson, s.moduleId))}
            </div>
          )}

          {/* ── Numbered modules ────────────────────────────────────────────── */}
          {numberedModules.map((mod, mi) => {
            const isValidated = validatedModules.has(mod.id)
            const hasQuiz     = modulesWithQuiz.has(mod.id)
            const modDone     = mod.lessons.filter(l => !!progress[l.id]).length + (isValidated ? 1 : 0)
            const modTotal    = mod.lessons.length + (hasQuiz ? 1 : 0)
            const modPct      = modTotal > 0 ? Math.round((modDone / modTotal) * 100) : 0

            return (
              <div key={mod.id} className="mt-4">
                {/* Module header */}
                <div className="px-6 pt-4 pb-3 bg-white/[0.03] border-t border-white/[0.06]">
                  <div className="flex items-start justify-between gap-2 mb-2.5">
                    <p className="text-xs font-bold text-white/90 uppercase tracking-wide leading-snug flex-1 [overflow-wrap:anywhere]">
                      {mi + 1}. {mod.title}
                    </p>
                    {isValidated ? (
                      <span className="flex items-center gap-1 shrink-0 text-[10px] font-bold text-success mt-0.5">
                        <CheckCircle className="w-3 h-3" /> Validé
                      </span>
                    ) : (
                      <span className="text-[11px] text-white/50 shrink-0 mt-0.5 tabular-nums">
                        {modDone}/{modTotal}
                      </span>
                    )}
                  </div>
                  {modTotal > 0 && (
                    <div className="w-full h-2 bg-white/[0.08] rounded-full overflow-hidden">
                      <div
                        className={cn(
                          'h-full rounded-full transition-[width] duration-700 ease-out',
                          isValidated ? 'bg-success' : 'bg-success/70'
                        )}
                        style={{ width: `${modPct}%` }}
                      />
                    </div>
                  )}
                </div>

                {/* Lesson list */}
                {mod.lessons.map(les => renderLessonLink(les, mod.id))}

                {/* Quiz link */}
                {hasQuiz && (() => {
                  const isQuizActive = activeModuleId === mod.id && activeLessonId === null
                  return (
                    <Link
                      href={`/learn/${courseSlug}/${mod.id}/quiz`}
                      onClick={onClose}
                      className={cn(
                        'flex items-center gap-3 mx-2.5 px-3.5 py-2.5 rounded-lg transition-all duration-150 border-l-2',
                        isQuizActive
                          ? 'bg-secondary/[0.12] border-secondary'
                          : 'border-transparent hover:bg-white/[0.06] hover:border-white/20'
                      )}
                    >
                      {/* 3-state indicator matching lessons */}
                      {isValidated ? (
                        <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center shrink-0">
                          <Check className="w-3 h-3 text-white" strokeWidth={3} />
                        </div>
                      ) : isQuizActive ? (
                        <div className="w-5 h-5 rounded-full border-2 border-secondary bg-secondary/20 ring-2 ring-secondary/20 shrink-0" />
                      ) : (
                        <ClipboardList className="w-4 h-4 shrink-0 text-white/50" />
                      )}
                      <span className={cn(
                        'leading-snug text-[0.9375rem] italic',
                        isQuizActive  ? 'text-secondary font-semibold'
                        : isValidated ? 'text-white/95 font-medium'
                                      : 'text-white/90 font-medium'
                      )}>
                        Quiz du module
                      </span>
                    </Link>
                  )
                })()}
              </div>
            )
          })}
          {/* ── Final exam ──────────────────────────────────────────────── */}
          {hasFinalExam && (
            <div className="border-t border-white/[0.08] mt-4">
              <div className="px-6 pt-4 pb-3 bg-white/[0.03]">
                <p className="text-xs font-bold text-white/90 uppercase tracking-wide">
                  Examen final
                </p>
              </div>
              <Link
                href={`/learn/${courseSlug}/final-exam`}
                onClick={onClose}
                className={cn(
                  'flex items-center gap-3 mx-2.5 px-3.5 py-3 rounded-lg transition-all duration-150 border-l-2',
                  isFinalExamActive
                    ? 'bg-amber-500/[0.12] border-amber-400'
                    : 'border-transparent hover:bg-white/[0.06] hover:border-white/20'
                )}
              >
                {finalExamPassed ? (
                  <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center shrink-0">
                    <Check className="w-3 h-3 text-white" strokeWidth={3} />
                  </div>
                ) : isFinalExamActive ? (
                  <div className="w-5 h-5 rounded-full border-2 border-amber-400 bg-amber-400/20 ring-2 ring-amber-400/20 shrink-0" />
                ) : (
                  <div className="w-5 h-5 rounded-full border-2 border-white/35 shrink-0" />
                )}
                <span className={cn(
                  'leading-snug text-[0.9375rem] font-semibold',
                  isFinalExamActive ? 'text-amber-300'
                  : finalExamPassed ? 'text-white/95'
                                    : 'text-white/90'
                )}>
                  Examen final
                </span>
              </Link>
            </div>
          )}
        </nav>
      </aside>
    </>
  )
}
