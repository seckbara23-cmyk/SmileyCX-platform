import { requirePlatformAdmin } from '@/lib/auth/session'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import type { Metadata } from 'next'
import { createUser } from './actions'

export const metadata: Metadata = { title: 'Admin — Nouvel utilisateur' }

export default async function AdminNewUserPage() {
  await requirePlatformAdmin()

  return (
    <div className="p-4 sm:p-6 max-w-lg mx-auto space-y-6">
      <Link
        href="/admin/users"
        className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-700 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" /> Retour aux utilisateurs
      </Link>

      <div>
        <h1 className="text-xl font-extrabold text-gray-900">Nouvel utilisateur</h1>
        <p className="text-sm text-gray-400 mt-0.5">
          Crée un compte Supabase Auth + profil via la clé service.
        </p>
      </div>

      <form action={createUser} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 sm:p-6 space-y-5">

        <div className="flex flex-col gap-1.5">
          <label htmlFor="fullName" className="text-sm font-semibold text-gray-700">Nom complet</label>
          <input
            id="fullName"
            type="text"
            name="fullName"
            placeholder="Marie Dupont"
            className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="email" className="text-sm font-semibold text-gray-700">
            Email <span className="text-red-500">*</span>
          </label>
          <input
            id="email"
            type="email"
            name="email"
            required
            placeholder="marie@exemple.com"
            className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="password" className="text-sm font-semibold text-gray-700">
            Mot de passe <span className="text-red-500">*</span>
          </label>
          <input
            id="password"
            type="password"
            name="password"
            required
            minLength={8}
            placeholder="Min. 8 caractères"
            className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="platformRole" className="text-sm font-semibold text-gray-700">Rôle plateforme</label>
          <select
            id="platformRole"
            name="platformRole"
            defaultValue="user"
            className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all bg-white"
          >
            <option value="user">Utilisateur</option>
            <option value="consultant">Consultant</option>
            <option value="super_admin">Super Admin</option>
          </select>
        </div>

        <div className="pt-1 flex items-center gap-3">
          <button
            type="submit"
            className="px-5 py-2.5 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition-colors"
          >
            Créer l&apos;utilisateur
          </button>
          <Link
            href="/admin/users"
            className="px-5 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-gray-600 hover:bg-gray-50 transition-colors"
          >
            Annuler
          </Link>
        </div>
      </form>
    </div>
  )
}
