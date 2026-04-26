import { requirePlatformAdmin } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import type { Metadata } from 'next'
import { createModule } from './actions'

export const metadata: Metadata = { title: 'Admin — Nouveau module' }

export default async function AdminNewModulePage() {
  await requirePlatformAdmin()
  const supabase = createAdminClient()

  const { data: courses } = await supabase
    .from('courses')
    .select('id, title')
    .order('title')

  return (
    <div className="p-4 sm:p-6 max-w-lg mx-auto space-y-6">
      <Link
        href="/admin/modules"
        className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-700 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" /> Retour aux modules
      </Link>

      <div>
        <h1 className="text-xl font-extrabold text-gray-900">Nouveau module</h1>
      </div>

      <form action={createModule} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 sm:p-6 space-y-5">

        <div className="flex flex-col gap-1.5">
          <label htmlFor="courseId" className="text-sm font-semibold text-gray-700">
            Formation <span className="text-red-500">*</span>
          </label>
          <select
            id="courseId"
            name="courseId"
            required
            className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm bg-white focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
          >
            <option value="">Choisir une formation…</option>
            {(courses ?? []).map(c => (
              <option key={c.id} value={c.id}>{c.title}</option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="title" className="text-sm font-semibold text-gray-700">
            Titre <span className="text-red-500">*</span>
          </label>
          <input
            id="title"
            type="text"
            name="title"
            required
            placeholder="Introduction à la CX"
            className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="slug" className="text-sm font-semibold text-gray-700">
            Slug <span className="text-red-500">*</span>
          </label>
          <input
            id="slug"
            type="text"
            name="slug"
            required
            placeholder="introduction-cx"
            pattern="[a-z0-9-]+"
            className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
          />
          <p className="text-xs text-gray-400">Minuscules, chiffres et tirets uniquement.</p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="description" className="text-sm font-semibold text-gray-700">Description</label>
          <textarea
            id="description"
            name="description"
            rows={3}
            placeholder="Décrivez ce module…"
            className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all resize-none"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="orderIndex" className="text-sm font-semibold text-gray-700">Ordre</label>
          <input
            id="orderIndex"
            type="number"
            name="orderIndex"
            min={0}
            defaultValue={0}
            className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
          />
        </div>

        <div className="pt-1 flex items-center gap-3">
          <button
            type="submit"
            className="px-5 py-2.5 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition-colors"
          >
            Créer le module
          </button>
          <Link
            href="/admin/modules"
            className="px-5 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-gray-600 hover:bg-gray-50 transition-colors"
          >
            Annuler
          </Link>
        </div>
      </form>
    </div>
  )
}
