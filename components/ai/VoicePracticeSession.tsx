'use client'

import { useEffect, useRef, useState } from 'react'
import { Mic, Loader2, PhoneOff, AlertTriangle, RotateCcw, ArrowRight } from 'lucide-react'
import {
  startVoiceSession,
  saveAiTurns,
  completeAiSession,
} from '@/app/actions/ai-practice'

// ── Voice state machine (French-labelled) ─────────────────────────────────────
type VoiceState = 'micro' | 'connexion' | 'ecoute' | 'client' | 'termine' | 'erreur'

interface StateMeta { label: string; dot: string }

function stateMeta(s: VoiceState, personaName: string): StateMeta {
  switch (s) {
    case 'micro':     return { label: 'Micro requis…',              dot: 'bg-amber-400 animate-pulse' }
    case 'connexion': return { label: 'Connexion…',                 dot: 'bg-amber-400 animate-pulse' }
    case 'ecoute':    return { label: 'Écoute — à vous de parler',  dot: 'bg-green-400 animate-pulse' }
    case 'client':    return { label: `${personaName} répond…`,     dot: 'bg-primary animate-pulse' }
    case 'termine':   return { label: 'Terminé',                    dot: 'bg-white/40' }
    case 'erreur':    return { label: 'Erreur',                     dot: 'bg-red-400' }
  }
}

interface TranscriptLine { speaker: 'learner' | 'agent'; text: string }
interface BufferedTurn { speaker: 'learner' | 'agent'; transcript: string; turnIndex: number }

interface Conversation {
  endSession: () => Promise<void>
}

interface Props {
  scenarioId:  string
  personaName: string
  pilotMode:   boolean
  anonId?:     string
  onComplete:  (_sessionId: string) => void
  onCancel:    () => void
}

export default function VoicePracticeSession({
  scenarioId, personaName, pilotMode, anonId, onComplete, onCancel,
}: Props) {
  const [state,      setState]      = useState<VoiceState>('micro')
  const [error,      setError]      = useState('')
  const [lines,      setLines]      = useState<TranscriptLine[]>([])

  const conversationRef = useRef<Conversation | null>(null)
  const sessionIdRef    = useRef<string | null>(null)
  const startedAtRef    = useRef(0)
  const bufferRef       = useRef<BufferedTurn[]>([])
  const turnIndexRef    = useRef(0)
  const saveChainRef    = useRef<Promise<void>>(Promise.resolve())
  const endingRef       = useRef(false)   // learner clicked Terminer (normal end)
  const finalizedRef    = useRef(false)
  const unmountedRef    = useRef(false)
  const transcriptRef   = useRef<HTMLDivElement>(null)

  const anon = pilotMode ? anonId : undefined

  // ── Persistence (serialized to avoid races) ────────────────────────────────
  function flushTurns(): Promise<void> {
    saveChainRef.current = saveChainRef.current.then(async () => {
      const sid = sessionIdRef.current
      if (!sid || bufferRef.current.length === 0) return
      const batch = bufferRef.current.splice(0)
      const res = await saveAiTurns({ sessionId: sid, anonId: anon, turns: batch })
      if (res.error) bufferRef.current.unshift(...batch)  // re-queue on failure
    })
    return saveChainRef.current
  }

  function addTurn(speaker: 'learner' | 'agent', text: string) {
    const trimmed = text.trim()
    if (!trimmed) return
    bufferRef.current.push({ speaker, transcript: trimmed, turnIndex: turnIndexRef.current++ })
    if (!unmountedRef.current) setLines(prev => [...prev, { speaker, text: trimmed }])
    if (bufferRef.current.length >= 2) void flushTurns()
  }

  async function finalize(status: 'completed' | 'abandoned', isError: boolean, message?: string) {
    if (finalizedRef.current) return
    finalizedRef.current = true
    await flushTurns()
    const sid = sessionIdRef.current
    const durationSeconds = startedAtRef.current
      ? Math.round((Date.now() - startedAtRef.current) / 1000)
      : undefined
    if (sid) await completeAiSession({ sessionId: sid, anonId: anon, status, durationSeconds })
    if (unmountedRef.current) return
    if (isError) { setError(message ?? 'Une erreur est survenue.'); setState('erreur') }
    else setState('termine')
  }

  // ── Start the live session ──────────────────────────────────────────────────
  async function start() {
    setError('')
    finalizedRef.current = false
    endingRef.current    = false
    setState('micro')

    // 1. Microphone permission / browser support.
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setError('Votre navigateur ne prend pas en charge le microphone. Essayez Chrome, Edge ou Firefox à jour.')
      setState('erreur')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach(t => t.stop())
    } catch {
      setError('Accès au micro refusé. Autorisez le microphone dans votre navigateur, puis réessayez.')
      setState('erreur')
      return
    }

    // 2. Server: create session + signed URL (API key never leaves the server).
    const res = await startVoiceSession({ scenarioId, anonId: anon })
    if (res.error || !res.sessionId || !res.signedUrl) {
      setError(
        res.reason === 'not_configured'
          ? "La pratique vocale n'est pas encore configurée pour cette leçon."
          : (res.error ?? 'Connexion à la pratique vocale impossible.')
      )
      setState('erreur')
      return
    }
    sessionIdRef.current = res.sessionId
    startedAtRef.current = Date.now()
    setState('connexion')

    // 3. Connect the ElevenLabs conversation.
    try {
      const { Conversation } = await import('@11labs/client')
      conversationRef.current = await Conversation.startSession({
        signedUrl: res.signedUrl,
        onConnect:      () => { if (!unmountedRef.current) setState('ecoute') },
        onStatusChange: ({ status }: { status: string }) => {
          if (!unmountedRef.current && status === 'connecting') setState('connexion')
        },
        onModeChange:   ({ mode }: { mode: 'speaking' | 'listening' }) => {
          if (!unmountedRef.current) setState(mode === 'speaking' ? 'client' : 'ecoute')
        },
        onMessage:      ({ message, source }: { message: string; source: 'user' | 'ai' }) => {
          addTurn(source === 'ai' ? 'agent' : 'learner', message)
        },
        onError:        (message: string) => {
          void finalize('abandoned', true, 'Une erreur est survenue pendant la conversation.')
          if (message) console.error('[voice] onError:', message)
        },
        onDisconnect:   () => {
          // Normal end (learner pressed Terminer) → completed; otherwise a drop.
          if (finalizedRef.current) return
          if (endingRef.current) void finalize('completed', false)
          else void finalize('abandoned', true, 'La connexion a été interrompue.')
        },
      }) as unknown as Conversation
    } catch {
      await finalize('abandoned', true, 'Connexion à la pratique vocale impossible.')
    }
  }

  async function handleEnd() {
    endingRef.current = true
    try { await conversationRef.current?.endSession() } catch { /* onDisconnect handles it */ }
    // Safety net if the SDK never fires onDisconnect.
    if (!finalizedRef.current) await finalize('completed', false)
  }

  // Auto-start on mount; clean up on unmount.
  useEffect(() => {
    void start()
    return () => {
      unmountedRef.current = true
      const conv = conversationRef.current
      if (conv && !finalizedRef.current) {
        finalizedRef.current = true
        void flushTurns().then(() => conv.endSession().catch(() => {}))
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep the transcript scrolled to the latest line.
  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight })
  }, [lines])

  const meta   = stateMeta(state, personaName)
  const active = state === 'connexion' || state === 'ecoute' || state === 'client'

  return (
    <div className="flex flex-col gap-4">
      {/* Status bar */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl bg-white/[0.03] border border-white/10">
        <span className="flex items-center gap-2.5 text-sm font-semibold text-white/85">
          <span className={`w-2.5 h-2.5 rounded-full ${meta.dot}`} />
          {meta.label}
        </span>
        {active && (
          <button
            type="button"
            onClick={handleEnd}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-red-500/15 text-red-300 text-xs font-semibold hover:bg-red-500/25 transition-colors"
          >
            <PhoneOff className="w-3.5 h-3.5" /> Terminer
          </button>
        )}
      </div>

      {/* Error */}
      {state === 'erreur' && error && (
        <div className="flex items-start gap-2.5 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/30">
          <AlertTriangle className="w-4 h-4 text-red-300 shrink-0 mt-0.5" />
          <p className="text-sm text-red-200/90 leading-relaxed">{error}</p>
        </div>
      )}

      {/* Live transcript */}
      {lines.length > 0 && (
        <div
          ref={transcriptRef}
          className="max-h-72 overflow-y-auto flex flex-col gap-3 pr-1"
        >
          {lines.map((l, i) => (
            <div key={i} className={l.speaker === 'learner' ? 'text-right' : 'text-left'}>
              <p className={`text-[10px] font-bold uppercase tracking-widest mb-0.5 ${
                l.speaker === 'learner' ? 'text-primary/70' : 'text-white/40'
              }`}>
                {l.speaker === 'learner' ? 'Vous' : personaName}
              </p>
              <p className={`inline-block text-sm leading-relaxed px-3.5 py-2 rounded-2xl ${
                l.speaker === 'learner'
                  ? 'bg-primary/15 text-white/90'
                  : 'bg-white/[0.05] text-white/80'
              }`}>
                {l.text}
              </p>
            </div>
          ))}
        </div>
      )}

      {(state === 'connexion' || state === 'micro') && lines.length === 0 && (
        <div className="flex items-center gap-2.5 text-sm text-white/45 py-4">
          <Loader2 className="w-4 h-4 animate-spin" /> Préparation de la conversation…
        </div>
      )}

      {/* Terminal actions */}
      {(state === 'termine' || state === 'erreur') && (
        <div className="flex flex-wrap items-center gap-3">
          {sessionIdRef.current && (
            <button
              type="button"
              onClick={() => onComplete(sessionIdRef.current as string)}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition-all"
            >
              Passer à l&apos;auto-évaluation <ArrowRight className="w-4 h-4" />
            </button>
          )}
          <button
            type="button"
            onClick={() => { setLines([]); bufferRef.current = []; turnIndexRef.current = 0; sessionIdRef.current = null; void start() }}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white/10 text-white/70 text-sm font-medium hover:bg-white/15 hover:text-white transition-all"
          >
            <RotateCcw className="w-4 h-4" /> Réessayer
          </button>
          {!sessionIdRef.current && (
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-white/50 text-sm font-medium hover:text-white/80 transition-colors"
            >
              Retour
            </button>
          )}
        </div>
      )}

      {/* Hint while active */}
      {state === 'ecoute' && (
        <p className="flex items-center gap-2 text-xs text-white/40">
          <Mic className="w-3.5 h-3.5" /> Parlez naturellement — {personaName} vous écoute.
        </p>
      )}
    </div>
  )
}
