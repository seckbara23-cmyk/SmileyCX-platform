'use client'
import { Suspense, useState, useMemo, useEffect, useRef } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Eye, EyeOff } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Input } from '@/components/ui/Input'
import Button from '@/components/ui/Button'

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  reset_expired: 'Votre lien de réinitialisation a expiré. Demandez-en un nouveau ci-dessous.',
  auth_error:    "Le lien de confirmation est invalide ou a déjà été utilisé. Essayez de vous connecter.",
}

const isDev = process.env.NODE_ENV === 'development'

function LoginForm() {
  const searchParams  = useSearchParams()
  const rawNext       = searchParams.get('next') || '/dashboard'
  const nextUrl       =
    rawNext.startsWith('/') && !rawNext.startsWith('//') && !rawNext.startsWith('/login')
      ? rawNext
      : '/dashboard'
  const callbackError = searchParams.get('error') ?? ''

  const supabaseUrl   = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '(undefined)'
  const anonKeyExists = !!(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)

  const supabase = useMemo(() => {
    console.log('[LOGIN] createClient()')
    return createClient()
  }, [])

  const [email,      setEmail]      = useState('')
  const [password,   setPassword]   = useState('')
  const [showPass,   setShowPass]   = useState(false)
  const [error,      setError]      = useState('')
  const [loading,    setLoading]    = useState(false)
  const [debugLines, setDebugLines] = useState<string[]>([])
  const formRef = useRef<HTMLFormElement>(null)

  function dbg(msg: string) {
    const ts = new Date().toISOString().slice(11, 23)
    console.log('[LOGIN]', msg)
    if (isDev) setDebugLines(prev => [...prev, `${ts}  ${msg}`])
  }

  useEffect(() => {
    dbg('component mounted — React hydration OK')
    if (formRef.current) {
      dbg(`form element found: ${formRef.current.tagName}`)
    } else {
      dbg('WARNING: formRef.current is null')
    }
  }, [])

  function handleButtonClick() {
    dbg('button onClick fired')
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    dbg(`submit fired — email="${email}" nextUrl="${nextUrl}"`)
    setError('')
    setLoading(true)

    try {
      dbg('calling signInWithPassword…')

      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Auth timeout after 10 s — check Supabase URL')), 10_000)
      )

      const result = await Promise.race([
        supabase.auth.signInWithPassword({ email, password }),
        timeout,
      ])

      setLoading(false)

      const { data, error: authError } = result as Awaited<ReturnType<typeof supabase.auth.signInWithPassword>>
      dbg(`result — error=${authError?.message ?? 'null'} session=${!!data?.session} user=${data?.user?.email ?? 'none'}`)

      if (authError) {
        setError('Email ou mot de passe incorrect. Vérifiez vos identifiants.')
        return
      }

      dbg(`redirecting → ${nextUrl}`)
      window.location.href = nextUrl

    } catch (err) {
      setLoading(false)
      const msg = err instanceof Error ? err.message : String(err)
      dbg(`caught: ${msg}`)
      setError(msg)
    }
  }

  return (
    <div className="w-full max-w-md px-2 sm:px-0">

      {/* Debug panel — development only, tree-shaken from production build */}
      {isDev && (
        <div className="mb-4 px-3 py-2 rounded-lg bg-yellow-50 border border-yellow-300 text-[11px] font-mono text-yellow-900 leading-relaxed break-all">
          <p className="font-bold text-xs mb-1">⚙ Debug (dev only)</p>
          <p>URL: {supabaseUrl}</p>
          <p>Anon key: {anonKeyExists ? '✓ present' : '✗ MISSING'}</p>
          <p>nextUrl: {nextUrl}</p>
          {debugLines.map((line, i) => <p key={i}>{line}</p>)}
        </div>
      )}

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

        <form ref={formRef} onSubmit={handleSubmit} className="flex flex-col gap-5" noValidate>
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

          <Button
            type="submit"
            loading={loading}
            fullWidth
            className="mt-1"
            onClick={handleButtonClick}
          >
            {loading ? 'Connexion en cours…' : 'Se connecter'}
          </Button>

          {/* Fallback submit button — development only, bypasses custom Button */}
          {isDev && (
            <button
              type="submit"
              style={{ marginTop: 4, padding: '10px', background: '#4a6de5', color: '#fff', borderRadius: 8, cursor: 'pointer', fontSize: 13 }}
              onClick={() => dbg('plain button onClick fired')}
            >
              Se connecter (fallback)
            </button>
          )}
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
