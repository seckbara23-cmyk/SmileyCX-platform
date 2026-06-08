'use client'
import { Suspense, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Eye, EyeOff } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Input } from '@/components/ui/Input'
import Button from '@/components/ui/Button'

// Map callback error codes to human-readable French messages
const AUTH_ERROR_MESSAGES: Record<string, string> = {
  reset_expired: 'Votre lien de réinitialisation a expiré. Demandez-en un nouveau ci-dessous.',
  auth_error:    "Le lien de confirmation est invalide ou a déjà été utilisé. Essayez de vous connecter.",
}

function LoginForm() {
  const searchParams = useSearchParams()
  const rawNext      = searchParams.get('next') || '/dashboard'
  // Sanitise: must be a relative path, must not loop back to /login
  const nextUrl      =
    rawNext.startsWith('/') && !rawNext.startsWith('//') && !rawNext.startsWith('/login')
      ? rawNext
      : '/dashboard'
  const callbackError = searchParams.get('error') ?? ''
  const supabase     = createClient()

  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [showPass, setShowPass] = useState(false)
  const [error,    setError]    = useState('')
  const [loading,  setLoading]  = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    const { error: authError } = await supabase.auth.signInWithPassword({ email, password })
    setLoading(false)

    if (authError) {
      setError('Email ou mot de passe incorrect. Vérifiez vos identifiants.')
    } else {
      // Hard redirect: ensures fresh session cookies are sent with the next
      // request so the middleware sees the authenticated user immediately.
      // router.push + router.refresh() races and can cancel the navigation.
      window.location.href = nextUrl
    }
  }

  return (
    <div className="w-full max-w-md px-2 sm:px-0">
      <div className="bg-white rounded-2xl shadow-md border border-black/[0.06] p-5 sm:p-8">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-extrabold text-dark mb-1">Connexion</h1>
          <p className="text-sm text-cx-gray">Accédez à votre espace XP Client Academy</p>
        </div>

        {/* Error from auth callback (e.g. expired reset link) */}
        {callbackError && AUTH_ERROR_MESSAGES[callbackError] && (
          <div className="mb-4 px-4 py-3 rounded-cx bg-amber-50 border border-amber-200 text-sm text-amber-800">
            {AUTH_ERROR_MESSAGES[callbackError]}
            {callbackError === 'reset_expired' && (
              <> {' '}<Link href="/forgot-password" className="font-semibold underline">Réinitialiser</Link></>
            )}
          </div>
        )}

        {/* Error from login attempt */}
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

          <div className="flex flex-col gap-1.5">
            <div className="flex justify-between items-center">
              <label htmlFor="password" className="text-sm font-semibold text-dark">Mot de passe</label>
              <Link href="/forgot-password" className="text-xs text-primary hover:underline">
                Mot de passe oublié ?
              </Link>
            </div>
            <div className="relative">
              <input
                id="password"
                type={showPass ? 'text' : 'password'}
                placeholder="••••••••"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                className="w-full pr-10 px-3.5 py-3 rounded-cx border border-[#dde2f0] text-dark text-sm focus:border-primary focus:ring-3 focus:ring-primary/15 outline-none transition-all"
              />
              <button
                type="button"
                onClick={() => setShowPass(s => !s)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-cx-gray hover:text-dark"
                aria-label={showPass ? 'Masquer' : 'Afficher'}
              >
                {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <Button type="submit" loading={loading} fullWidth className="mt-1">
            Se connecter
          </Button>
        </form>

        <p className="text-center text-sm text-cx-gray mt-6">
          Pas encore de compte ?{' '}
          <Link href={`/signup?next=${encodeURIComponent(nextUrl)}`} className="text-primary font-semibold hover:underline">
            S&apos;inscrire gratuitement
          </Link>
        </p>
      </div>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="w-full max-w-md h-96 animate-pulse bg-white/5 rounded-2xl" />}>
      <LoginForm />
    </Suspense>
  )
}
