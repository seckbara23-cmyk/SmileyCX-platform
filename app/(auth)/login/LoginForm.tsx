'use client'
import { useState, useMemo } from 'react'
import Link from 'next/link'
import { Eye, EyeOff, Loader2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Input } from '@/components/ui/Input'

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  reset_expired: 'Votre lien de réinitialisation a expiré. Demandez-en un nouveau ci-dessous.',
  auth_error:    "Le lien de confirmation est invalide ou a déjà été utilisé. Essayez de vous connecter.",
}

interface Props {
  next?: string
  error?: string
}

export default function LoginForm({ next, error: callbackErrorProp }: Props) {
  const rawNext      = next || '/dashboard'
  const nextUrl      =
    rawNext.startsWith('/') && !rawNext.startsWith('//') && !rawNext.startsWith('/login')
      ? rawNext
      : '/dashboard'
  const callbackError = callbackErrorProp ?? ''

  const supabase = useMemo(() => createClient(), [])

  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [showPass, setShowPass] = useState(false)
  const [error,    setError]    = useState('')
  const [loading,  setLoading]  = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Auth timeout 10 s')), 10_000)
      )

      const result = await Promise.race([
        supabase.auth.signInWithPassword({ email, password }),
        timeout,
      ])

      setLoading(false)

      const { data, error: authError } = result as Awaited<ReturnType<typeof supabase.auth.signInWithPassword>>

      if (authError) {
        setError('Email ou mot de passe incorrect. Vérifiez vos identifiants.')
        return
      }

      window.location.href = nextUrl

    } catch (err) {
      setLoading(false)
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="w-full max-w-md px-2 sm:px-0">
      <div className="bg-white rounded-2xl shadow-md border border-black/[0.06] p-5 sm:p-8">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-extrabold text-dark mb-1">Connexion</h1>
          <p className="text-sm text-cx-gray">Accédez à votre espace XP Client Academy</p>
        </div>

        {callbackError && AUTH_ERROR_MESSAGES[callbackError] && (
          <div className="mb-4 px-4 py-3 rounded-cx bg-amber-50 border border-amber-200 text-sm text-amber-800">
            {AUTH_ERROR_MESSAGES[callbackError]}
            {callbackError === 'reset_expired' && (
              <> {' '}<Link href="/forgot-password" className="font-semibold underline">Réinitialiser</Link></>
            )}
          </div>
        )}

        {error && (
          <div className="mb-4 px-4 py-3 rounded-cx bg-red-50 border border-red-200 text-sm text-red-700 break-all">
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
              <label htmlFor="password" className="text-sm font-semibold text-dark">
                Mot de passe
              </label>
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

          <button
            type="submit"
            disabled={loading}
            className="mt-1 w-full inline-flex items-center justify-center gap-2 font-semibold rounded-cx px-6 py-3 text-base transition-all duration-300 select-none bg-secondary text-white border-2 border-secondary hover:bg-secondary-dark hover:border-secondary-dark hover:-translate-y-0.5 hover:shadow-btn active:translate-y-0 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {loading ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Connexion en cours…</>
            ) : (
              'Se connecter'
            )}
          </button>
        </form>

        <p className="text-center text-sm text-cx-gray mt-6">
          Pas encore de compte ?{' '}
          <Link
            href={`/signup?next=${encodeURIComponent(nextUrl)}`}
            className="text-primary font-semibold hover:underline"
          >
            S&apos;inscrire gratuitement
          </Link>
        </p>
      </div>
    </div>
  )
}
