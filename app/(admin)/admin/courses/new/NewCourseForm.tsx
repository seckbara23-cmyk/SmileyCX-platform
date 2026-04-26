'use client'

import { useState } from 'react'
import Link from 'next/link'
import { createCourse } from './actions'

function toSlug(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export default function NewCourseForm() {
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)

  function handleTitleChange(v: string) {
    if (!slugEdited) setSlug(toSlug(v))
  }

  function handleSlugChange(v: string) {
    setSlug(v)
    setSlugEdited(true)
  }

  return (
    <form action={createCourse} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 sm:p-6 space-y-5">

      <div className="grid sm:grid-cols-2 gap-5">
        <div className="sm:col-span-2 flex flex-col gap-1.5">
          <label htmlFor="title" className="text-sm font-semibold text-gray-700">
            Titre <span className="text-red-500">*</span>
          </label>
          <input
            id="title"
            type="text"
            name="title"
            required
            placeholder="Comprendre le Client pour Délivrer une Expérience de Qualité"
            onChange={e => handleTitleChange(e.target.value)}
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
            value={slug}
            onChange={e => handleSlugChange(e.target.value)}
            placeholder="comprendre-client-experience"
            pattern="[a-z0-9-]+"
            className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm font-mono focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
          />
          <p className="text-xs text-gray-400">Généré automatiquement · minuscules et tirets uniquement.</p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="level" className="text-sm font-semibold text-gray-700">Niveau</label>
          <select
            id="level"
            name="level"
            defaultValue="beginner"
            className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm bg-white focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
          >
            <option value="beginner">Débutant</option>
            <option value="intermediate">Intermédiaire</option>
            <option value="advanced">Avancé</option>
          </select>
        </div>

        <div className="sm:col-span-2 flex flex-col gap-1.5">
          <label htmlFor="description" className="text-sm font-semibold text-gray-700">
            Description <span className="text-red-500">*</span>
          </label>
          <textarea
            id="description"
            name="description"
            required
            rows={4}
            placeholder="Décrivez cette formation, ses objectifs et ce que les apprenants vont acquérir…"
            className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all resize-none"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="price" className="text-sm font-semibold text-gray-700">Prix (FCFA)</label>
          <input
            id="price"
            type="number"
            name="price"
            min={0}
            step={500}
            defaultValue={45000}
            className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="duration_hours" className="text-sm font-semibold text-gray-700">Durée (heures)</label>
          <input
            id="duration_hours"
            type="number"
            name="duration_hours"
            min={1}
            defaultValue={8}
            className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
          />
        </div>
      </div>

      {/* Toggles */}
      <div className="flex flex-col gap-3 pt-2 border-t border-gray-100">
        <label className="flex items-center gap-3 cursor-pointer">
          <input type="checkbox" name="is_free" className="w-4 h-4 rounded text-primary accent-primary" />
          <span className="text-sm font-medium text-gray-700">Formation gratuite</span>
        </label>
        <label className="flex items-center gap-3 cursor-pointer">
          <input type="checkbox" name="is_published" defaultChecked className="w-4 h-4 rounded text-primary accent-primary" />
          <span className="text-sm font-medium text-gray-700">Publier immédiatement</span>
        </label>
      </div>

      <div className="pt-2 flex items-center gap-3">
        <button
          type="submit"
          className="px-5 py-2.5 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 transition-colors"
        >
          Créer la formation
        </button>
        <Link
          href="/admin/courses"
          className="px-5 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-gray-600 hover:bg-gray-50 transition-colors"
        >
          Annuler
        </Link>
      </div>
    </form>
  )
}
