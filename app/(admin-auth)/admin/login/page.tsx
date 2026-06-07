import { Shield } from 'lucide-react'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Admin — Connexion' }

const ERROR_MESSAGES: Record<string, string> = {
  invalid:        'Identifiants invalides.',
  forbidden:      'Ce compte n\'a pas accès à l\'administration.',
  not_configured: 'Admin non configuré. Vérifiez ADMIN_USERNAME et ADMIN_EMAIL.',
  server:         'Erreur serveur. Réessayez.',
}

interface Props {
  searchParams: Promise<{ error?: string }>
}

export default async function AdminLoginPage({ searchParams }: Props) {
  const { error: errorKey } = await searchParams
  const errorMsg = errorKey ? (ERROR_MESSAGES[errorKey] ?? 'Une erreur est survenue.') : ''

  return (
    <div className="min-h-screen bg-[#0f1117] flex items-center justify-center p-4">
      <div className="w-full max-w-sm">

        <div className="text-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-primary flex items-center justify-center mx-auto mb-4 shadow-lg">
            <Shield className="w-7 h-7 text-white" />
          </div>
          <p className="text-2xl font-extrabold text-white">
            XP<span className="text-secondary"> Client</span>
          </p>
          <p className="text-sm text-white/40 mt-1">Administration Platform</p>
        </div>

        <div className="bg-[#1a1d27] border border-white/[0.08] rounded-2xl p-6 shadow-xl">
          <h1 className="text-base font-bold text-white mb-5">Connexion administrateur</h1>

          {errorMsg && (
            <div className="mb-4 px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-sm text-red-400">
              {errorMsg}
            </div>
          )}

          <form action="/api/admin/login" method="POST" className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="username" className="text-sm font-semibold text-white/70">
                Nom d&apos;utilisateur
              </label>
              <input
                id="username" name="username" type="text"
                placeholder="seckbara23@gmail.com"
                autoComplete="username" required
                className="w-full px-3.5 py-3 rounded-xl bg-white/[0.05] border border-white/[0.1] text-white text-sm placeholder:text-white/25 focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="password" className="text-sm font-semibold text-white/70">
                Mot de passe
              </label>
              <input
                id="password" name="password" type="password"
                placeholder="••••••••"
                autoComplete="current-password" required
                className="w-full px-3.5 py-3 rounded-xl bg-white/[0.05] border border-white/[0.1] text-white text-sm placeholder:text-white/25 focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
              />
            </div>

            <button type="submit"
              className="mt-1 w-full py-3 rounded-xl bg-primary text-white font-bold text-sm hover:bg-primary/90 transition-all"
            >
              Se connecter
            </button>
          </form>
        </div>

        <p className="text-center text-xs text-white/20 mt-6">
          Accès réservé aux administrateurs de la plateforme XP Client.
        </p>
      </div>
    </div>
  )
}
