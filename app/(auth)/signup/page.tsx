'use client'
import { useState } from 'react'
import Link from 'next/link'
import { CheckCircle, Lock } from 'lucide-react'
import { Input } from '@/components/ui/Input'
import Button from '@/components/ui/Button'
import { joinWaitlist } from '@/app/actions/waitlist'

/**
 * /signup — access request only. The platform is INVITE-ONLY (SEC-2 §1).
 *
 * This page CANNOT create an account. There is no registration form, and no
 * client-side Supabase registration call exists anywhere in the codebase — a
 * regression test enforces that (__tests__/security/registration.test.ts).
 *
 * Accounts are provisioned exclusively by a platform administrator through the
 * admin panel (app/(admin)/admin/users/new), which is authenticated,
 * authorized, rate-limited and audited.
 *
 * Backend enforcement does not depend on this page: Supabase's own
 * `disable_signup` setting closes POST /auth/v1/signup, and the server refuses
 * to start in production when that setting is off
 * (lib/security/auth-config.ts + instrumentation.ts).
 *
 * Login and password reset are unaffected and remain fully available.
 */
export default function SignupPage() {
  const [form,    setForm]    = useState({ name: '', email: '' })
  const [loading, setLoading] = useState(false)
  const [done,    setDone]    = useState(false)
  const [error,   setError]   = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    const result = await joinWaitlist(form)
    setLoading(false)
    if (result.error) setError(result.error)
    else setDone(true)
  }

  if (done) {
    return (
      <div className="w-full max-w-md px-2 sm:px-0">
        <div className="bg-white rounded-2xl shadow-md border border-black/[0.06] p-8 text-center">
          <CheckCircle className="w-16 h-16 text-success mx-auto mb-5" />
          <h2 className="text-2xl font-extrabold text-dark mb-2">Demande enregistrée !</h2>
          <p className="text-cx-gray text-sm mb-6">
            Merci <strong className="text-dark">{form.name}</strong>, nous avons bien reçu votre demande.
            Vous serez contacté à <strong className="text-dark">{form.email}</strong> dès que votre accès
            est ouvert par un administrateur.
          </p>
          <Link
            href="/"
            className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-white font-bold rounded-cx hover:opacity-90 transition-opacity text-sm"
          >
            Retour à l&apos;accueil
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="w-full max-w-md px-2 sm:px-0">
      <div className="bg-white rounded-2xl shadow-md border border-black/[0.06] p-5 sm:p-8">
        <div className="text-center mb-8">
          <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
            <Lock className="w-7 h-7 text-primary" />
          </div>
          <h1 className="text-2xl font-extrabold text-dark mb-2">Accès sur invitation</h1>
          <p className="text-sm text-cx-gray leading-relaxed">
            L&apos;inscription libre n&apos;est pas disponible : les comptes sont créés par un
            administrateur. Laissez vos coordonnées pour demander un accès.
          </p>
        </div>

        {error && (
          <div className="mb-4 px-4 py-3 rounded-cx bg-red-50 border border-red-200 text-sm text-red-700">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-5" noValidate>
          <Input
            label="Nom complet"
            type="text"
            placeholder="Votre prénom et nom"
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            required
            autoComplete="name"
          />
          <Input
            label="Email"
            type="email"
            placeholder="votre@email.com"
            value={form.email}
            onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
            required
            autoComplete="email"
          />
          <Button type="submit" loading={loading} fullWidth className="mt-1">
            Demander un accès
          </Button>
        </form>

        <p className="text-center text-sm text-cx-gray mt-6">
          Déjà un compte ?{' '}
          <Link href="/login" className="text-primary font-semibold hover:underline">
            Se connecter
          </Link>
        </p>
      </div>

      <p className="text-center text-xs text-cx-gray mt-4">
        Vos données sont utilisées uniquement pour traiter votre demande d&apos;accès.
      </p>
    </div>
  )
}
