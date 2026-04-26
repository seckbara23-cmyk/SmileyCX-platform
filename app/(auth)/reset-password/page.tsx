'use client'
import { Suspense, useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Eye, EyeOff, KeyRound, CheckCircle, AlertTriangle, Loader2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import Button from '@/components/ui/Button'

// ─────────────────────────────────────────────────────────────────────────────
// Supabase password reset flow:
//  1. User clicks "Forgot password" → resetPasswordForEmail() sends email
//  2. Email link → /auth/callback?code=...&type=recovery → exchanges code for
//     a recovery session → redirects here (/reset-password)
//  3. This page detects the active recovery session and lets user set a new pw
// ─────────────────────────────────────────────────────────────────────────────

type PageState =
  | 'loading'      // checking session
  | 'ready'        // has valid recovery session, show form
  | 'invalid'      // no session or not a recovery session
  | 'success'      // password updated

function ResetPasswordForm() {
  const router   = useRouter()
  const supabase = createClient()

  const [pageState, setPageState] = useState<PageState>('loading')
  const [password,  setPassword]  = useState('')
  const [confirm,   setConfirm]   = useState('')
  const [showPw,    setShowPw]    = useState(false)
  const [showCfm,   setShowCfm]   = useState(false)
  const [error,     setError]     = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Detect whether we have a live session after the callback exchange
  useEffect(() => {
    let mounted = true

    async function checkSession() {
      try {
        const { data: { session } } = await supabase.auth.getSession()
        if (mounted) {
          setPageState(session ? 'ready' : 'invalid')
        }
      } catch {
        if (mounted) setPageState('invalid')
      }
    }

    checkSession()
    return () => { mounted = false }
  }, [supabase])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    if (password.length < 8) {
      setError('Le mot de passe doit contenir au moins 8 caractères.')
      return
    }
    if (password !== confirm) {
      setError('Les mots de passe ne correspondent pas.')
      return
    }

    setSubmitting(true)

    const { error: updateError } = await supabase.auth.updateUser({ password })

    setSubmitting(false)

    if (updateError) {
      setError('Une erreur est survenue. Veuillez réessayer ou demander un nouveau lien.')
    } else {
      setPageState('success')
      // Give user a moment to see success, then redirect
      setTimeout(() => router.push('/dashboard'), 2500)
    }
  }

  // ── Loading state ─────────────────────────────────────────────────────────
  if (pageState === 'loading') {
    return (
      <div className="w-full max-w-md text-center px-2">
        <div className="bg-white rounded-2xl shadow-md border border-black/[0.06] p-10">
          <Loader2 className="w-10 h-10 text-primary animate-spin mx-auto mb-4" />
          <p className="text-cx-gray text-sm">Vérification de votre lien…</p>
        </div>
      </div>
    )
  }

  // ── Invalid / expired session ─────────────────────────────────────────────
  if (pageState === 'invalid') {
    return (
      <div className="w-full max-w-md text-center px-2">
        <div className="bg-white rounded-2xl shadow-md border border-black/[0.06] p-8">
          <AlertTriangle className="w-14 h-14 text-amber-500 mx-auto mb-4" />
          <h2 className="text-xl font-extrabold text-dark mb-2">Lien invalide ou expiré</h2>
          <p className="text-cx-gray text-sm mb-6">
            Ce lien de réinitialisation est invalide ou a expiré. Les liens sont valables{' '}
            <strong>1 heure</strong> seulement.
          </p>
          <Link
            href="/forgot-password"
            className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-white font-bold rounded-cx hover:opacity-90 transition-opacity text-sm"
          >
            Demander un nouveau lien
          </Link>
          <p className="mt-4 text-sm text-cx-gray">
            <Link href="/login" className="text-primary font-semibold hover:underline">
              Retour à la connexion
            </Link>
          </p>
        </div>
      </div>
    )
  }

  // ── Success state ─────────────────────────────────────────────────────────
  if (pageState === 'success') {
    return (
      <div className="w-full max-w-md text-center px-2">
        <div className="bg-white rounded-2xl shadow-md border border-black/[0.06] p-8">
          <CheckCircle className="w-14 h-14 text-success mx-auto mb-4" />
          <h2 className="text-2xl font-extrabold text-dark mb-2">Mot de passe mis à jour !</h2>
          <p className="text-cx-gray text-sm mb-2">
            Votre mot de passe a été modifié avec succès.
          </p>
          <p className="text-xs text-cx-gray">Redirection vers votre espace…</p>
        </div>
      </div>
    )
  }

  // ── Ready: show form ──────────────────────────────────────────────────────
  return (
    <div className="w-full max-w-md px-2 sm:px-0">
      <div className="bg-white rounded-2xl shadow-md border border-black/[0.06] p-5 sm:p-8">
        <div className="text-center mb-8">
          <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
            <KeyRound className="w-6 h-6 text-primary" />
          </div>
          <h1 className="text-2xl font-extrabold text-dark mb-1">
            Nouveau mot de passe
          </h1>
          <p className="text-sm text-cx-gray">
            Choisissez un mot de passe sécurisé d&apos;au moins 8 caractères.
          </p>
        </div>

        {error && (
          <div className="mb-4 px-4 py-3 rounded-cx bg-red-50 border border-red-200 text-sm text-red-700">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-5" noValidate>
          {/* New password */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="new-password" className="text-sm font-semibold text-dark">
              Nouveau mot de passe <span className="text-error">*</span>
            </label>
            <div className="relative">
              <input
                id="new-password"
                type={showPw ? 'text' : 'password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Minimum 8 caractères"
                autoComplete="new-password"
                required
                className="w-full pr-10 px-3.5 py-3 rounded-cx border border-[#dde2f0] text-dark text-sm focus:border-primary focus:ring-3 focus:ring-primary/15 outline-none transition-all"
              />
              <button
                type="button"
                onClick={() => setShowPw(s => !s)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-cx-gray hover:text-dark transition-colors"
                aria-label={showPw ? 'Masquer' : 'Afficher'}
              >
                {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Confirm password */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="confirm-password" className="text-sm font-semibold text-dark">
              Confirmer le mot de passe <span className="text-error">*</span>
            </label>
            <div className="relative">
              <input
                id="confirm-password"
                type={showCfm ? 'text' : 'password'}
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                placeholder="Répétez votre mot de passe"
                autoComplete="new-password"
                required
                className="w-full pr-10 px-3.5 py-3 rounded-cx border border-[#dde2f0] text-dark text-sm focus:border-primary focus:ring-3 focus:ring-primary/15 outline-none transition-all"
              />
              <button
                type="button"
                onClick={() => setShowCfm(s => !s)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-cx-gray hover:text-dark transition-colors"
                aria-label={showCfm ? 'Masquer' : 'Afficher'}
              >
                {showCfm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <Button type="submit" loading={submitting} fullWidth className="mt-1">
            Mettre à jour le mot de passe
          </Button>
        </form>
      </div>
    </div>
  )
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div className="w-full max-w-md h-80 animate-pulse bg-white/5 rounded-2xl" />}>
      <ResetPasswordForm />
    </Suspense>
  )
}
