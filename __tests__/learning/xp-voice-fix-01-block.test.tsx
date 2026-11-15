/**
 * XP-VOICE-FIX-01 — the F2 exercise as the learner sees it, rendered in jsdom.
 *
 * Server actions are mocked: these tests pin what the block shows and in which
 * order it asks for things. The attempt counter is shown before the start; a
 * learner with no attempt left cannot start; consent is asked for, explicitly,
 * before the first conversation; the microphone is checked BEFORE the server is
 * asked to start, so a refused microphone consumes no attempt.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

vi.mock('server-only', () => ({}))

const m = vi.hoisted(() => ({
  createAiSession: vi.fn(),
  completeAiSession: vi.fn(async () => ({ ok: true })),
  saveSelfAssessment: vi.fn(async () => ({ ok: true })),
  startVoiceSession: vi.fn(),
  saveAiTurns: vi.fn(async () => ({ ok: true })),
  getVoiceFeedback: vi.fn(),
  getSessionCoaching: vi.fn(async () => null),
  getVoiceConsentStatus: vi.fn(),
  acceptVoiceConsent: vi.fn(async () => ({ ok: true })),
  withdrawVoiceConsent: vi.fn(),
  deleteMyVoiceData: vi.fn(),
}))
vi.mock('@/app/actions/ai-practice', () => ({
  createAiSession: m.createAiSession, completeAiSession: m.completeAiSession, saveSelfAssessment: m.saveSelfAssessment,
  startVoiceSession: m.startVoiceSession, saveAiTurns: m.saveAiTurns, getVoiceFeedback: m.getVoiceFeedback,
  getSessionCoaching: m.getSessionCoaching,
}))
vi.mock('@/app/actions/voice-consent', () => ({
  getVoiceConsentStatus: m.getVoiceConsentStatus, acceptVoiceConsent: m.acceptVoiceConsent,
  withdrawVoiceConsent: m.withdrawVoiceConsent, deleteMyVoiceData: m.deleteMyVoiceData,
}))
vi.mock('@/app/actions/ai-coach', () => ({ getSessionReport: vi.fn(), evaluateSessionWithClaude: vi.fn() }))

import VoicePracticeBlock from '@/components/ai/VoicePracticeBlock'
import type { VoiceScenario } from '@/app/actions/ai-practice'
import { personaById, publicPersona } from '@/lib/voice/personas'
import { personaSelfAssessment } from '@/lib/voice/self-assessment'

const amara = personaById('amara')
const EXHAUSTED = 'Vous avez utilisé tous les essais prévus pour cette leçon pendant votre période d’accès.'
const NO_PERIOD = 'L’entraînement vocal est lié à une inscription active à ce cours. Contactez l’équipe XP CLIENT si vous pensez qu’il s’agit d’une erreur.'

const scenario = (over: Partial<VoiceScenario> = {}): VoiceScenario => ({
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  slug: amara.scenarioSlug,
  title: 'Client confus',
  personaName: 'Amara',
  situation: amara.customer.situationFr,
  objectives: amara.observationCriteria.map(c => c.labelFr),
  selfAssessment: personaSelfAssessment(amara),
  voiceAvailable: true,
  briefing: null,
  persona: publicPersona(amara),
  attempts: { state: 'available', remaining: 5, limit: 5 },
  ...over,
})
const startButton = () => screen.getByRole('button', { name: /Commencer la conversation/ })

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockClear()
  m.getVoiceConsentStatus.mockResolvedValue({ accepted: true, version: 'voix-1.0', textFr: 'Texte du consentement.' })
  m.createAiSession.mockResolvedValue({ sessionId: 'S-SELF' })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('before the start', () => {
  it('a published, configured scenario shows its brief, its objectives and the attempts left', () => {
    render(<VoicePracticeBlock scenario={scenario()} pilotMode={false} />)
    expect(screen.getByText('Client confus')).toBeInTheDocument()
    expect(screen.getByText(amara.customer.situationFr)).toBeInTheDocument()
    for (const c of amara.observationCriteria) expect(screen.getByText(c.labelFr, { exact: false })).toBeInTheDocument()
    expect(screen.getByText('Essais vocaux restants pour cette leçon : 5 sur 5.')).toBeInTheDocument()
    expect(startButton()).toBeEnabled()
    expect(startButton()).toHaveAttribute('aria-describedby', 'voice-attempts')
  })

  it('no attempt left: the French reason, and the conversation cannot start', () => {
    render(<VoicePracticeBlock scenario={scenario({ attempts: { state: 'attempts_exhausted', remaining: 0, limit: 5, messageFr: EXHAUSTED } })} pilotMode={false} />)
    expect(screen.getByRole('status')).toHaveTextContent(EXHAUSTED)
    expect(startButton()).toBeDisabled()
    fireEvent.click(startButton())
    expect(m.getVoiceConsentStatus).not.toHaveBeenCalled()
    expect(m.startVoiceSession).not.toHaveBeenCalled()
  })

  it('no inscription (an administrator, for instance): told why, and cannot start', () => {
    render(<VoicePracticeBlock scenario={scenario({ attempts: { state: 'no_access_period', remaining: 0, limit: 5, messageFr: NO_PERIOD } })} pilotMode={false} />)
    expect(screen.getByRole('status')).toHaveTextContent(NO_PERIOD)
    expect(startButton()).toBeDisabled()
  })

  it('voice not configured here: a French notice and the self-assessment, with the reviewed questions', async () => {
    render(<VoicePracticeBlock scenario={scenario({ voiceAvailable: false, attempts: null })} pilotMode={false} />)
    expect(screen.getByText(/est en cours de configuration/)).toBeInTheDocument()
    expect(screen.queryByText(/Essais vocaux restants/)).toBeNull()
    expect(screen.queryByRole('button', { name: /Commencer la conversation/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Commencer l'auto-évaluation/ }))
    for (const q of personaSelfAssessment(amara)) expect(await screen.findByText(q.question)).toBeInTheDocument()
    expect(m.startVoiceSession).not.toHaveBeenCalled()
  })

  it('the counter is unknown: the exercise still shows and can start; the server decides', () => {
    render(<VoicePracticeBlock scenario={scenario({ attempts: null })} pilotMode={false} />)
    expect(screen.queryByText(/Essais vocaux restants/)).toBeNull()
    expect(startButton()).toBeEnabled()
  })

  it('the learner can reach « Mes données vocales » from the exercise', () => {
    render(<VoicePracticeBlock scenario={scenario()} pilotMode={false} />)
    expect(screen.getByText(/Mes données vocales/)).toBeInTheDocument()
  })
})

describe('consent, then the microphone, then the server', () => {
  it('no consent yet: the explicit consent step, which needs the box ticked, records the version, then goes on', async () => {
    m.getVoiceConsentStatus.mockResolvedValue({ accepted: false, version: 'voix-1.0', textFr: 'Texte du consentement.' })
    render(<VoicePracticeBlock scenario={scenario()} pilotMode={false} />)
    fireEvent.click(startButton())
    const accept = await screen.findByRole('button', { name: /Accepter et commencer/ })
    expect(screen.getByText(/Texte du consentement\./)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Politique de confidentialité/ })).toHaveAttribute('href', '/privacy')
    expect(accept).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(accept)
    await waitFor(() => expect(m.acceptVoiceConsent).toHaveBeenCalledWith({ version: 'voix-1.0', accepted: true }))
    // jsdom has no microphone: the browser check fails, and the server was never asked to start.
    expect(await screen.findByText(/ne prend pas en charge le microphone/)).toBeInTheDocument()
    expect(m.startVoiceSession).not.toHaveBeenCalled()
  })

  it('microphone refused: a French message, and no attempt is consumed (the server is not called)', async () => {
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia: vi.fn(async () => { throw new DOMException('denied', 'NotAllowedError') }) } })
    render(<VoicePracticeBlock scenario={scenario()} pilotMode={false} />)
    fireEvent.click(startButton())
    expect(await screen.findByText(/Accès au micro refusé/)).toBeInTheDocument()
    expect(m.startVoiceSession).not.toHaveBeenCalled()
  })

  it('the server refuses at the start (the last attempt was used meanwhile): its French message is shown', async () => {
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [] })) } })
    m.startVoiceSession.mockResolvedValue({ error: EXHAUSTED, reason: 'attempts_exhausted' })
    render(<VoicePracticeBlock scenario={scenario()} pilotMode={false} />)
    fireEvent.click(startButton())
    expect(await screen.findByText(EXHAUSTED)).toBeInTheDocument()
    expect(m.startVoiceSession).toHaveBeenCalledTimes(1)
  })

  it('the provider cannot be reached: a French error, never a raw provider message', async () => {
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [] })) } })
    m.startVoiceSession.mockResolvedValue({ error: 'Connexion à la pratique vocale impossible.' })
    render(<VoicePracticeBlock scenario={scenario()} pilotMode={false} />)
    fireEvent.click(startButton())
    expect(await screen.findByText(/Connexion à la pratique vocale impossible\./)).toBeInTheDocument()
  })
})
