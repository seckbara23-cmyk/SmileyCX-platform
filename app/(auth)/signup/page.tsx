'use client'
import { Suspense, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Eye, EyeOff, CheckCircle, Lock } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Input } from '@/components/ui/Input'
import Button from '@/components/ui/Button'
import { PLATFORM_MODE } from '@/lib/pilot'
import { joinWaitlist } from '@/app/actions/waitlist'

// ── Waitlist form — shown in private mode ────────────────────────────────────

function WaitlistForm() {
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
    if (result.error) {
      setError(result.error)
    } else {
      setDone(true)
    }
  }

  if (done) {
    return (
      <div className="w-full max-w-md px-2 sm:px-0">
        <div className="bg-white rounded-2xl shadow-md border border-black/[0.06] p-8 text-center">
          <CheckCircle className="w-16 h-16 text-success mx-auto mb-5" />
          <h2 className="text-2xl font-extrabold text-dark mb-2">Demande enregistrée !</h2>
          <p className="text-cx-gray text-sm mb-6">
            Merci <strong className="text-dark">{form.name}</strong>, nous avons bien reçu votre demande.
            Vous serez contacté à <strong className="text-dark">{form.email}</strong> dès que l&apos;accès est ouvert.
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
            La plateforme est actuellement en accès limité. Laissez vos coordonnées pour être notifié à l&apos;ouverture.
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
            Rejoindre la liste d&apos;attente
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
        Vos données sont utilisées uniquement pour vous contacter lors de l&apos;ouverture.
      </p>
    </div>
  )
}

// ── Signup form — shown in pilot/public mode ─────────────────────────────────

function SignupForm() {
  const router       = useRouter()
  const searchParams = useSearchParams()
  const rawNext      = searchParams.get('next') || '/dashboard'
  const nextUrl      = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/dashboard'
  const supabase     = createClient()

  const [form,     setForm]    = useState({ full_name: '', email: '', password: '' })
  const [errors,   setErrors]  = useState<Record<string, string>>({})
  const [loading,  setLoading] = useState(false)
  const [showPass, setShowPass] = useState(false)
  const [done,     setDone]    = useState(false)

  function validate() {
    const e: Record<string, string> = {}
    if (!form.full_name.trim())       e.full_name = 'Votre nom complet est requis'
    if (!form.email.includes('@'))    e.email     = 'Email invalide'
    if (form.password.length < 8)     e.password  = 'Minimum 8 caractères'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!validate()) return
    setLoading(true)

    const { error } = await supabase.auth.signUp({
      email:    form.email,
      password: form.password,
      options: {
        data: { full_name: form.full_name, platform_role: 'user' },
        emailRedirectTo: `${location.origin}/auth/callback?next=${encodeURIComponent(nextUrl)}`,
      },
    })

    setLoading(false)
    if (error) {
      setErrors({ general: error.message })
    } else {
      setDone(true)
    }
  }

  void router

  if (done) {
    return (
      <div className="w-full max-w-md px-2 sm:px-0">
        <div className="bg-white rounded-2xl shadow-md border border-black/[0.06] p-8 text-center">
          <CheckCircle className="w-16 h-16 text-success mx-auto mb-5" />
          <h2 className="text-2xl font-extrabold text-dark mb-2">Bienvenue dans XP Client Academy !</h2>
          <p className="text-cx-gray text-sm mb-4">
            Un email de confirmation a été envoyé à{' '}
            <strong className="text-dark">{form.email}</strong>.
          </p>

          <div className="bg-light rounded-xl p-4 text-left mb-6 space-y-2">
            {[
              'Vérifiez votre boîte de réception (et le dossier spam)',
              'Cliquez sur le lien de confirmation dans l\'email',
              'Connectez-vous et commencez votre parcours CX',
            ].map((step, i) => (
              <div key={i} className="flex items-start gap-3">
                <span className="w-5 h-5 rounded-full bg-primary text-white text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">
                  {i + 1}
                </span>
                <p className="text-sm text-dark">{step}</p>
              </div>
            ))}
          </div>

          <p className="text-xs text-cx-gray mb-4">
            Le lien expire dans <strong>24 heures</strong>.
          </p>

          <Link
            href="/login"
            className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-white font-bold rounded-cx hover:opacity-90 transition-opacity text-sm"
          >
            Aller à la connexion
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="w-full max-w-md px-2 sm:px-0">
      <div className="bg-white rounded-2xl shadow-md border border-black/[0.06] p-5 sm:p-8">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-extrabold text-dark mb-1">Créer un compte</h1>
          <p className="text-sm text-cx-gray">Accédez à toutes les formations XP Client</p>
        </div>

        {errors.general && (
          <div className="mb-4 px-4 py-3 rounded-cx bg-red-50 border border-red-200 text-sm text-red-700">
            {errors.general}
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-5" noValidate>
          <Input
            label="Nom complet"
            type="text"
            placeholder="Votre prénom et nom"
            value={form.full_name}
            onChange={e => setForm(f => ({ ...f, full_name: e.target.value }))}
            error={errors.full_name}
            required
            autoComplete="name"
          />

          <Input
            label="Email"
            type="email"
            placeholder="votre@email.com"
            value={form.email}
            onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
            error={errors.email}
            required
            autoComplete="email"
          />

          <div className="flex flex-col gap-1.5">
            <label htmlFor="password" className="text-sm font-semibold text-dark">
              Mot de passe <span className="text-error">*</span>
            </label>
            <div className="relative">
              <input
                id="password"
                type={showPass ? 'text' : 'password'}
                placeholder="Minimum 8 caractères"
                value={form.password}
                onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                autoComplete="new-password"
                className="w-full pr-10 px-3.5 py-3 rounded-cx border border-[#dde2f0] text-dark text-sm focus:border-primary focus:ring-3 focus:ring-primary/15 outline-none transition-all"
              />
              <button
                type="button"
                onClick={() => setShowPass(s => !s)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-cx-gray hover:text-dark transition-colors"
                aria-label={showPass ? 'Masquer' : 'Afficher'}
              >
                {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            {errors.password && <p className="text-xs text-error font-medium">{errors.password}</p>}
          </div>

          {/* Account type note — not a form control, just informational text */}
          <div className="flex flex-col gap-1">
            <p className="text-sm font-semibold text-dark">Type de compte</p>
            <p className="text-sm text-cx-gray">
              Votre compte sera créé comme utilisateur individuel. Pour une offre équipe,
              contactez le support une fois votre compte activé.
            </p>
          </div>

          <Button type="submit" loading={loading} fullWidth className="mt-1">
            Créer mon compte
          </Button>
        </form>

        <p className="text-center text-sm text-cx-gray mt-6">
          Déjà un compte ?{' '}
          <Link href={`/login?next=${encodeURIComponent(nextUrl)}`} className="text-primary font-semibold hover:underline">
            Se connecter
          </Link>
        </p>
      </div>

      <p className="text-center text-xs text-cx-gray mt-4">
        En créant un compte, vous acceptez nos{' '}
        <Link href="/terms" className="underline hover:text-dark">CGU</Link>
      </p>
    </div>
  )
}

// ── Page entry point ─────────────────────────────────────────────────────────

export default function SignupPage() {
  if (PLATFORM_MODE === 'private') {
    return (
      <Suspense fallback={<div className="w-full max-w-md h-96 animate-pulse bg-white/5 rounded-2xl" />}>
        <WaitlistForm />
      </Suspense>
    )
  }
  return (
    <Suspense fallback={<div className="w-full max-w-md h-96 animate-pulse bg-white/5 rounded-2xl" />}>
      <SignupForm />
    </Suspense>
  )
}
