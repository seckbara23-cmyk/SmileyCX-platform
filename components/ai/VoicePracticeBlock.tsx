'use client'

import { useState, useEffect, useTransition } from 'react'
import { Mic, Target, Loader2, Info } from 'lucide-react'
import {
  createAiSession,
  completeAiSession,
  saveSelfAssessment,
  type VoiceScenario,
} from '@/app/actions/ai-practice'
import VoicePracticeSession from './VoicePracticeSession'
import SelfAssessmentForm from './SelfAssessmentForm'
import SessionSummary from './SessionSummary'
import CoachBriefing from './CoachBriefing'
import CoachDebrief from './CoachDebrief'
import { AI_COACH_ENABLED } from '@/lib/ai/flags'

const ANON_ID_KEY = 'ai_practice_anon_id'

/** Stable per-browser id for pilot (anonymous) learners; kept only in localStorage. */
function getAnonId(): string | undefined {
  try {
    let id = localStorage.getItem(ANON_ID_KEY)
    if (!id) {
      id = crypto.randomUUID()
      localStorage.setItem(ANON_ID_KEY, id)
    }
    return id
  } catch {
    return undefined
  }
}

type Phase = 'intro' | 'voice' | 'coached' | 'assessment' | 'summary'

interface Props {
  scenario:  VoiceScenario
  pilotMode: boolean
}

export default function VoicePracticeBlock({ scenario, pilotMode }: Props) {
  const [phase,     setPhase]     = useState<Phase>('intro')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [answers,   setAnswers]   = useState<Record<string, number | string>>({})
  const [error,     setError]     = useState('')
  const [startedAt, setStartedAt] = useState(0)
  const [isPending, startTransition] = useTransition()
  const [anonId,    setAnonId]    = useState<string | undefined>(undefined)

  useEffect(() => {
    if (pilotMode) setAnonId(getAnonId())
  }, [pilotMode])

  // Self-assessment fallback path (no live voice): create a session up front so
  // the self-assessment feedback has a session to attach to.
  function handleStartSelfAssessment() {
    setError('')
    startTransition(async () => {
      const { sessionId: id, error: err } = await createAiSession({
        scenarioId: scenario.id,
        anonId:     pilotMode ? anonId : undefined,
      })
      if (err || !id) {
        setError(err ?? 'Impossible de démarrer la session.')
        return
      }
      setSessionId(id)
      setStartedAt(Date.now())
      setPhase('assessment')
    })
  }

  // Live voice completed → coach debrief when the coach flag is on (Phase 2A),
  // otherwise straight to the deterministic self-assessment (Phase 1 behavior).
  function handleVoiceComplete(voiceSessionId: string) {
    setSessionId(voiceSessionId)
    setStartedAt(Date.now())
    setError('')
    setPhase(AI_COACH_ENABLED ? 'coached' : 'assessment')
  }

  function handleSubmit(submitted: Record<string, number | string>) {
    if (!sessionId) return
    setError('')
    startTransition(async () => {
      const durationSeconds = startedAt ? Math.round((Date.now() - startedAt) / 1000) : undefined
      const [complete, feedback] = await Promise.all([
        completeAiSession({ sessionId, anonId: pilotMode ? anonId : undefined, status: 'completed', durationSeconds }),
        saveSelfAssessment({ sessionId, anonId: pilotMode ? anonId : undefined, answers: submitted }),
      ])
      if (feedback.error || complete.error) {
        setError(feedback.error ?? complete.error ?? 'Enregistrement impossible.')
        return
      }
      setAnswers(submitted)
      setPhase('summary')
    })
  }

  function handleRetry() {
    setSessionId(null)
    setAnswers({})
    setError('')
    setPhase('intro')
  }

  return (
    <div className="mt-10 pt-8 border-t border-white/10">

      {/* Section header */}
      <div className="flex items-center gap-2.5 mb-4">
        <div className="w-7 h-7 rounded-lg bg-primary/20 flex items-center justify-center">
          <Mic className="w-4 h-4 text-primary" />
        </div>
        <div>
          <p className="text-[11px] font-bold text-white/40 uppercase tracking-widest">Pratique — Relation client</p>
          <h3 className="text-base font-bold text-white leading-snug">{scenario.title}</h3>
        </div>
      </div>

      {/* Scenario brief (all phases) */}
      {scenario.situation && (
        <p className="text-sm text-white/70 leading-relaxed mb-4">{scenario.situation}</p>
      )}

      {error && (
        <div className="mb-4 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/30 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Phase 2A: coach briefing replaces the plain intro when configured */}
      {phase === 'intro' && AI_COACH_ENABLED && scenario.briefing && (
        <div className="flex flex-col gap-5">
          {!scenario.voiceAvailable && (
            <div className="flex items-start gap-2.5 px-4 py-3 rounded-xl bg-white/[0.03] border border-white/10">
              <Info className="w-4 h-4 text-primary shrink-0 mt-0.5" />
              <p className="text-xs text-white/55 leading-relaxed">
                La conversation vocale avec {scenario.personaName} est en cours de configuration.
                En attendant, préparez votre approche puis évaluez-vous.
              </p>
            </div>
          )}
          <CoachBriefing
            briefing={scenario.briefing}
            pending={isPending}
            disabled={pilotMode && !anonId}
            startLabel={scenario.voiceAvailable ? 'Commencer la conversation' : "Commencer l'auto-évaluation"}
            onStart={scenario.voiceAvailable ? () => setPhase('voice') : handleStartSelfAssessment}
          />
        </div>
      )}

      {phase === 'intro' && !(AI_COACH_ENABLED && scenario.briefing) && (
        <div className="flex flex-col gap-5">
          {scenario.objectives.length > 0 && (
            <div>
              <p className="text-[11px] font-bold text-white/40 uppercase tracking-widest mb-2 flex items-center gap-1.5">
                <Target className="w-3.5 h-3.5" /> Vos objectifs
              </p>
              <ul className="flex flex-col gap-1.5">
                {scenario.objectives.map((o, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-white/70 leading-relaxed">
                    <span className="text-primary mt-0.5">•</span> {o}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {scenario.voiceAvailable ? (
            <>
              <div className="flex items-start gap-2.5 px-4 py-3 rounded-xl bg-white/[0.03] border border-white/10">
                <Info className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                <p className="text-xs text-white/55 leading-relaxed">
                  Vous allez parler avec {scenario.personaName} à voix haute. Autorisez votre
                  microphone, gérez l&apos;échange, puis évaluez-vous. Cliquez sur «&nbsp;Terminer&nbsp;»
                  quand vous avez fini.
                </p>
              </div>
              <div>
                <button
                  type="button"
                  onClick={() => setPhase('voice')}
                  disabled={pilotMode && !anonId}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                >
                  <Mic className="w-4 h-4" /> Commencer la conversation
                </button>
              </div>
            </>
          ) : (
            <>
              {/* No agent configured / voice unavailable → French setup notice + self-assessment fallback */}
              <div className="flex items-start gap-2.5 px-4 py-3 rounded-xl bg-white/[0.03] border border-white/10">
                <Info className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                <p className="text-xs text-white/55 leading-relaxed">
                  La conversation vocale avec {scenario.personaName} est en cours de configuration.
                  En attendant, préparez votre approche puis évaluez-vous ci-dessous.
                </p>
              </div>
              <div>
                <button
                  type="button"
                  onClick={handleStartSelfAssessment}
                  disabled={isPending || (pilotMode && !anonId)}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                >
                  {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mic className="w-4 h-4" />}
                  Commencer l&apos;auto-évaluation
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {phase === 'voice' && (
        <VoicePracticeSession
          scenarioId={scenario.id}
          personaName={scenario.personaName}
          pilotMode={pilotMode}
          anonId={anonId}
          onComplete={handleVoiceComplete}
          onCancel={() => setPhase('intro')}
        />
      )}

      {/* Phase 2A: deterministic coach debrief (summary + replay), then the
          Phase 1 self-assessment continues below. */}
      {phase === 'coached' && sessionId && (
        <CoachDebrief
          sessionId={sessionId}
          anonId={pilotMode ? anonId : undefined}
          personaName={scenario.personaName}
          onRetry={handleRetry}
          onContinue={() => setPhase('assessment')}
        />
      )}

      {phase === 'assessment' && (
        <SelfAssessmentForm
          questions={scenario.selfAssessment}
          submitting={isPending}
          onSubmit={handleSubmit}
        />
      )}

      {phase === 'summary' && (
        <SessionSummary
          questions={scenario.selfAssessment}
          answers={answers}
          onRetry={handleRetry}
        />
      )}
    </div>
  )
}
