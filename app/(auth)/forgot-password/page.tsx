'use client'
import { Suspense, useState } from 'react'
import Link from 'next/link'
import { Mail, ArrowLeft, CheckCircle } from 'lucide-react'
import { Input } from '@/components/ui/Input'
import Button from '@/components/ui/Button'
import { requestPasswordReset } from '@/app/actions/auth'

/**
 * Password recovery request (XPA-6A).
 *
 * Moved from a direct browser→Supabase `resetPasswordForEmail` call to a server
 * action. Two defects went away with it:
 *
 *   1. `redirectTo` was `${location.origin}/...`, so a request made while on the
 *      internal deployment host produced a recovery link on that host. The
 *      server action composes the target from PUBLIC_SITE_URL and never reads
 *      the request origin.
 *   2. The application server was not in the request path, so recovery could not
 *      be rate limited or audited at all. Both now apply.
 *
 * Enumeration resistance is unchanged in appearance and stronger underneath:
 * the neutral message is now produced by the server for every outcome,
 * including the rate-limited one, rather than by the client swallowing an error.
 */
function ForgotPasswordForm() {
  const [email,   setEmail]   = useState('')
  const [loading, setLoading] = useState(false)
  const [done,    setDone]    = useState(false)
  const [error,   setError]   = useState('')
  const [notice,  setNotice]  = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!email.includes('@')) { setError('Veuillez entrer un email valide.'); return }

    setError('')
    setLoading(true)
    const result = await requestPasswordReset({ email })
    setLoading(false)

    if (!result.ok) { setError(result.message ?? 'Une erreur est survenue.'); return }
    setNotice(result.message ?? '')
    setDone(true)
  }

  if (done) {
    return (
      <div className="w-full max-w-md text-center px-2 sm:px-0">
        <div className="bg-white rounded-2xl shadow-md border border-black/[0.06] p-8">
          <CheckCircle className="w-14 h-14 text-success mx-auto mb-4" />
          <h2 className="text-2xl font-extrabold text-dark mb-2">Email envoyé !</h2>
          <p className="text-cx-gray text-sm mb-2">{notice}</p>
          <p className="text-cx-gray text-sm mb-6">
            Vérifiez aussi votre dossier <em>spam</em> si vous ne le voyez pas.
          </p>
          <Link
            href="/login"
            className="inline-flex items-center gap-2 text-sm text-primary font-semibold hover:underline"
          >
            <ArrowLeft className="w-4 h-4" /> Retour à la connexion
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="w-full max-w-md px-2 sm:px-0">
      <div className="bg-white rounded-2xl shadow-md border border-black/[0.06] p-5 sm:p-8">
        <div className="text-center mb-8">
          <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
            <Mail className="w-6 h-6 text-primary" />
          </div>
          <h1 className="text-2xl font-extrabold text-dark mb-1">Mot de passe oublié ?</h1>
          <p className="text-sm text-cx-gray">
            Entrez votre email et nous vous enverrons un lien de réinitialisation.
          </p>
        </div>

        {error && (
          <div className="mb-4 px-4 py-3 rounded-cx bg-red-50 border border-red-200 text-sm text-red-700">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-5" noValidate>
          <Input
            label="Email"
            type="email"
            placeholder="votre@email.com"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            autoComplete="email"
          />

          <Button type="submit" loading={loading} fullWidth>
            Envoyer le lien
          </Button>
        </form>

        <p className="text-center text-sm text-cx-gray mt-6">
          <Link
            href="/login"
            className="inline-flex items-center gap-1.5 text-primary font-semibold hover:underline"
          >
            <ArrowLeft className="w-4 h-4" /> Retour à la connexion
          </Link>
        </p>
      </div>
    </div>
  )
}

export default function ForgotPasswordPage() {
  return (
    <Suspense fallback={<div className="w-full max-w-md h-64 animate-pulse bg-white/5 rounded-2xl" />}>
      <ForgotPasswordForm />
    </Suspense>
  )
}
