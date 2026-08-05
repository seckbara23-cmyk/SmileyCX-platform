'use client'
/**
 * Public learner registration form (XPA-6A).
 *
 * ── THE ONE THING THIS COMPONENT MUST NEVER DO ───────────────────────────
 * Call Supabase. There is no `createClient()` here and no `auth.signUp()`
 * anywhere in the file. That call — made from the browser, straight to Supabase
 * — WAS security finding SEC-1/F-1: unvalidated, unrated, unaudited, and with a
 * client-supplied role. A regression test asserts it never returns to any source
 * file in the project.
 *
 * Everything below submits to `registerLearner`, a server action. The browser
 * sends field values and nothing else: no role, no status, no entitlement.
 */
import { useState } from 'react'
import Link from 'next/link'
import { CheckCircle, UserPlus, AlertCircle, Mail } from 'lucide-react'
import { Input } from '@/components/ui/Input'
import Button from '@/components/ui/Button'
import { registerLearner, resendVerification } from '@/app/actions/auth'

interface Props {
  termsVersion:   string
  privacyVersion: string
}

const EMPTY = {
  firstName:       '',
  lastName:        '',
  email:           '',
  password:        '',
  confirmPassword: '',
}

export default function RegisterForm({ termsVersion, privacyVersion }: Props) {
  const [form,     setForm]     = useState(EMPTY)
  const [accepted, setAccepted] = useState(false)
  const [loading,  setLoading]  = useState(false)
  const [done,     setDone]     = useState(false)
  const [message,  setMessage]  = useState('')
  const [errors,   setErrors]   = useState<Record<string, string>>({})
  const [resent,   setResent]   = useState(false)

  function set<K extends keyof typeof EMPTY>(key: K, value: string) {
    setForm(f => ({ ...f, [key]: value }))
    if (errors[key]) setErrors(e => ({ ...e, [key]: '' }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setErrors({})
    setMessage('')

    if (!accepted) {
      setErrors({ accepted: 'Vous devez accepter les conditions et la politique de confidentialité.' })
      return
    }

    setLoading(true)
    const result = await registerLearner({
      ...form,
      acceptedTermsVersion:   termsVersion,
      acceptedPrivacyVersion: privacyVersion,
    })
    setLoading(false)

    if (result.errors) setErrors(result.errors)
    if (result.ok) {
      setDone(true)
      setMessage(result.message ?? '')
    } else if (!result.errors) {
      setMessage(result.message ?? 'Une erreur est survenue.')
    } else {
      setMessage(result.message ?? '')
    }
  }

  async function handleResend() {
    setLoading(true)
    await resendVerification({ email: form.email })
    setLoading(false)
    setResent(true)
  }

  // ── Post-submit: identical screen for every non-validation outcome ──────
  // Success and "this address is already registered" render exactly the same,
  // because telling them apart is how account enumeration works.
  if (done) {
    return (
      <div className="w-full max-w-md px-2 sm:px-0">
        <div className="bg-white rounded-2xl shadow-md border border-black/[0.06] p-8 text-center">
          <Mail className="w-16 h-16 text-primary mx-auto mb-5" />
          <h2 className="text-2xl font-extrabold text-dark mb-3">Vérifiez votre email</h2>
          <p className="text-cx-gray text-sm mb-6 leading-relaxed">{message}</p>

          <div className="text-left bg-light rounded-cx p-4 mb-6">
            <p className="text-xs text-cx-gray leading-relaxed">
              <strong className="text-dark">À savoir :</strong> la création d&apos;un compte ne donne
              pas accès aux formations. L&apos;accès à une formation est activé séparément.
            </p>
          </div>

          {resent ? (
            <p className="text-sm text-success font-semibold mb-4">
              Si un email était en attente, il a été renvoyé.
            </p>
          ) : (
            <button
              type="button"
              onClick={handleResend}
              disabled={loading}
              className="text-sm text-primary font-semibold hover:underline disabled:opacity-50 mb-4"
            >
              Renvoyer l&apos;email de confirmation
            </button>
          )}

          <div>
            <Link href="/login" className="inline-flex items-center gap-2 text-sm text-cx-gray hover:text-dark">
              Retour à la connexion
            </Link>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="w-full max-w-md px-2 sm:px-0">
      <div className="bg-white rounded-2xl shadow-md border border-black/[0.06] p-5 sm:p-8">
        <div className="text-center mb-7">
          <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
            <UserPlus className="w-7 h-7 text-primary" />
          </div>
          <h1 className="text-2xl font-extrabold text-dark mb-2">Créer votre compte</h1>
          <p className="text-sm text-cx-gray leading-relaxed">
            Créez un compte gratuit pour suivre votre progression et accéder à votre espace.
          </p>
        </div>

        {message && !done && (
          <div className="mb-4 px-4 py-3 rounded-cx bg-red-50 border border-red-200 text-sm text-red-700 flex gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{message}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input
              label="Prénom"
              type="text"
              value={form.firstName}
              onChange={e => set('firstName', e.target.value)}
              error={errors.firstName}
              required
              autoComplete="given-name"
            />
            <Input
              label="Nom"
              type="text"
              value={form.lastName}
              onChange={e => set('lastName', e.target.value)}
              error={errors.lastName}
              required
              autoComplete="family-name"
            />
          </div>

          <Input
            label="Email"
            type="email"
            placeholder="votre@email.com"
            value={form.email}
            onChange={e => set('email', e.target.value)}
            error={errors.email}
            required
            autoComplete="email"
          />

          <div>
            <Input
              label="Mot de passe"
              type="password"
              value={form.password}
              onChange={e => set('password', e.target.value)}
              error={errors.password}
              required
              autoComplete="new-password"
            />
            <p className="text-[11px] text-cx-gray mt-1.5 leading-relaxed">
              Au moins 12 caractères, avec au moins trois types parmi : minuscules, majuscules,
              chiffres, symboles.
            </p>
          </div>

          <Input
            label="Confirmer le mot de passe"
            type="password"
            value={form.confirmPassword}
            onChange={e => set('confirmPassword', e.target.value)}
            error={errors.confirmPassword}
            required
            autoComplete="new-password"
          />

          <div>
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={accepted}
                onChange={e => { setAccepted(e.target.checked); setErrors(x => ({ ...x, accepted: '' })) }}
                className="mt-0.5 w-4 h-4 shrink-0 accent-primary"
                required
              />
              <span className="text-xs text-cx-gray leading-relaxed">
                J&apos;accepte les{' '}
                <Link href="/terms" target="_blank" className="text-primary font-semibold hover:underline">
                  conditions générales d&apos;utilisation
                </Link>{' '}
                et la{' '}
                <Link href="/privacy" target="_blank" className="text-primary font-semibold hover:underline">
                  politique de confidentialité
                </Link>
                .
              </span>
            </label>
            {errors.accepted && (
              <p className="text-xs text-red-600 mt-1.5">{errors.accepted}</p>
            )}
          </div>

          <Button type="submit" loading={loading} fullWidth className="mt-1">
            Créer mon compte
          </Button>
        </form>

        <div className="mt-6 pt-5 border-t border-black/[0.06]">
          <div className="flex gap-2 text-xs text-cx-gray leading-relaxed">
            <CheckCircle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-cx-gray/60" />
            <span>
              La création d&apos;un compte ne donne pas accès aux formations et n&apos;entraîne aucun
              paiement. L&apos;accès à une formation est activé séparément.
            </span>
          </div>
        </div>

        <p className="text-center text-sm text-cx-gray mt-6">
          Déjà un compte ?{' '}
          <Link href="/login" className="text-primary font-semibold hover:underline">
            Se connecter
          </Link>
        </p>
      </div>
    </div>
  )
}
