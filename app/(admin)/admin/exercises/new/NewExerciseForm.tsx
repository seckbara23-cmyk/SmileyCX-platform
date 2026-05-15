'use client'

import { useState, useTransition, useRef } from 'react'
import Link from 'next/link'
import { Plus, Trash2, Loader2, GripVertical } from 'lucide-react'
import { createExercise } from './actions'

interface Lesson  { id: string; title: string; order_index: number }
interface Module  { id: string; title: string; order_index: number; lessons: Lesson[] }
interface Course  { id: string; title: string; modules: Module[] }

interface CategoryDraft {
  _id:   string
  name:  string
  color: string
}

interface ItemDraft {
  _id:               string
  label:             string
  correctCategoryId: string
}

interface Props { courses: Course[] }

const CATEGORY_COLORS = [
  { label: 'Aucune',  value: '' },
  { label: 'Bleu',    value: '#3b82f6' },
  { label: 'Vert',    value: '#10b981' },
  { label: 'Ambre',   value: '#f59e0b' },
  { label: 'Rouge',   value: '#ef4444' },
  { label: 'Violet',  value: '#8b5cf6' },
  { label: 'Cyan',    value: '#06b6d4' },
]

function newCat(): CategoryDraft { return { _id: crypto.randomUUID(), name: '', color: '' } }
function newItem(): ItemDraft    { return { _id: crypto.randomUUID(), label: '', correctCategoryId: '' } }

export default function NewExerciseForm({ courses }: Props) {
  const [isPending, startTransition] = useTransition()
  const [error,     setError]        = useState<string | null>(null)
  const titleRef                     = useRef<HTMLInputElement>(null)
  const instrRef                     = useRef<HTMLTextAreaElement>(null)

  const [courseId,    setCourseId]    = useState('')
  const [moduleId,    setModuleId]    = useState('')
  const [lessonId,    setLessonId]    = useState('')
  const [isPublished, setIsPublished] = useState(false)
  const [categories,  setCategories]  = useState<CategoryDraft[]>([newCat(), newCat()])
  const [items,       setItems]       = useState<ItemDraft[]>([newItem(), newItem()])

  const selectedCourse = courses.find(c => c.id === courseId)
  const modules        = (selectedCourse?.modules ?? []).slice().sort((a, b) => a.order_index - b.order_index)
  const selectedModule = modules.find(m => m.id === moduleId)
  const lessons        = (selectedModule?.lessons ?? []).slice().sort((a, b) => a.order_index - b.order_index)

  function handleCourseChange(id: string) { setCourseId(id); setModuleId(''); setLessonId('') }
  function handleModuleChange(id: string) { setModuleId(id); setLessonId('') }

  function updateCategory(idx: number, patch: Partial<CategoryDraft>) {
    setCategories(prev => prev.map((c, i) => i === idx ? { ...c, ...patch } : c))
  }
  function removeCategory(idx: number) {
    const catId = categories[idx]._id
    setCategories(prev => prev.filter((_, i) => i !== idx))
    setItems(prev => prev.map(item => item.correctCategoryId === catId
      ? { ...item, correctCategoryId: '' }
      : item
    ))
  }

  function updateItem(idx: number, patch: Partial<ItemDraft>) {
    setItems(prev => prev.map((item, i) => i === idx ? { ...item, ...patch } : item))
  }
  function removeItem(idx: number) { setItems(prev => prev.filter((_, i) => i !== idx)) }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    const fd = new FormData()
    fd.set('title',        titleRef.current?.value.trim() ?? '')
    fd.set('instructions', instrRef.current?.value.trim() ?? '')
    fd.set('lesson_id',    lessonId)
    fd.set('is_published', String(isPublished))
    fd.set('categories_json', JSON.stringify(categories.map((c, i) => ({
      id: c._id, name: c.name, color: c.color, order_index: i,
    }))))
    fd.set('items_json', JSON.stringify(items.map((item, i) => ({
      id: item._id, label: item.label, correctCategoryId: item.correctCategoryId, order_index: i,
    }))))
    startTransition(async () => {
      const result = await createExercise(fd)
      if (result?.error) setError(result.error)
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">

      {/* ── Métadonnées ─────────────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 sm:p-6 space-y-5">
        <h2 className="text-sm font-bold text-gray-700 pb-2 border-b border-gray-100">Informations générales</h2>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="ex-title" className="text-sm font-semibold text-gray-700">
            Titre <span className="text-red-500">*</span>
          </label>
          <input
            id="ex-title" ref={titleRef} type="text" required
            placeholder="ex. Classez les réactions client par type"
            className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="ex-instructions" className="text-sm font-semibold text-gray-700">
            Instructions <span className="text-gray-400 font-normal">(optionnel)</span>
          </label>
          <textarea
            id="ex-instructions" ref={instrRef} rows={3}
            placeholder="ex. Faites glisser chaque phrase dans la bonne catégorie."
            className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all resize-none"
          />
        </div>

        {/* Lesson picker: Course → Module → Lesson */}
        <div className="grid sm:grid-cols-3 gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="ex-course" className="text-sm font-semibold text-gray-700">Formation <span className="text-red-500">*</span></label>
            <select id="ex-course" value={courseId} onChange={e => handleCourseChange(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm bg-white focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all">
              <option value="">— Choisir —</option>
              {courses.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="ex-module" className="text-sm font-semibold text-gray-700">Module <span className="text-red-500">*</span></label>
            <select id="ex-module" value={moduleId} onChange={e => handleModuleChange(e.target.value)} disabled={!courseId}
              className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm bg-white focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all disabled:opacity-50 disabled:cursor-not-allowed">
              <option value="">— Choisir —</option>
              {modules.map(m => <option key={m.id} value={m.id}>{m.title}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="ex-lesson" className="text-sm font-semibold text-gray-700">Leçon <span className="text-red-500">*</span></label>
            <select id="ex-lesson" value={lessonId} onChange={e => setLessonId(e.target.value)} disabled={!moduleId}
              className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm bg-white focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all disabled:opacity-50 disabled:cursor-not-allowed">
              <option value="">— Choisir —</option>
              {lessons.map(l => <option key={l.id} value={l.id}>{l.title}</option>)}
            </select>
          </div>
        </div>

        {/* Status */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setIsPublished(p => !p)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${isPublished ? 'bg-primary' : 'bg-gray-200'}`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${isPublished ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
          <span className="text-sm font-medium text-gray-700">
            {isPublished ? 'Publié' : 'Brouillon'}
          </span>
        </div>
      </div>

      {/* ── Catégories ──────────────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 sm:p-6 space-y-4">
        <h2 className="text-sm font-bold text-gray-700 pb-2 border-b border-gray-100">
          Catégories <span className="text-gray-400 font-normal text-xs">(min. 2)</span>
        </h2>

        <div className="space-y-2">
          {categories.map((cat, ci) => (
            <div key={cat._id} className="flex items-center gap-2">
              <GripVertical className="w-4 h-4 text-gray-300 shrink-0" />
              <input
                type="text" value={cat.name} onChange={e => updateCategory(ci, { name: e.target.value })}
                placeholder={`Catégorie ${ci + 1}`}
                className="flex-1 px-3 py-2 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
              />
              <select
                value={cat.color}
                onChange={e => updateCategory(ci, { color: e.target.value })}
                className="w-28 px-2 py-2 rounded-xl border border-gray-200 text-xs bg-white focus:border-primary outline-none transition-all"
                aria-label="Couleur de la catégorie"
              >
                {CATEGORY_COLORS.map(c => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
              {cat.color && (
                <span className="w-4 h-4 rounded-full shrink-0 border border-gray-200" style={{ backgroundColor: cat.color }} />
              )}
              {categories.length > 2 && (
                <button type="button" onClick={() => removeCategory(ci)}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors">
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          ))}
        </div>
        <button type="button" onClick={() => setCategories(prev => [...prev, newCat()])}
          className="flex items-center gap-1.5 text-sm font-semibold text-primary hover:text-primary/80 transition-colors">
          <Plus className="w-4 h-4" /> Ajouter une catégorie
        </button>
      </div>

      {/* ── Éléments à placer ───────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 sm:p-6 space-y-4">
        <h2 className="text-sm font-bold text-gray-700 pb-2 border-b border-gray-100">
          Éléments à classer <span className="text-gray-400 font-normal text-xs">(min. 2)</span>
        </h2>

        <div className="space-y-2">
          {items.map((item, ii) => (
            <div key={item._id} className="flex items-center gap-2">
              <GripVertical className="w-4 h-4 text-gray-300 shrink-0" />
              <input
                type="text" value={item.label} onChange={e => updateItem(ii, { label: e.target.value })}
                placeholder={`Élément ${ii + 1}`}
                className="flex-1 px-3 py-2 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
              />
              <select
                value={item.correctCategoryId}
                onChange={e => updateItem(ii, { correctCategoryId: e.target.value })}
                className="w-44 px-2 py-2 rounded-xl border border-gray-200 text-sm bg-white focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                aria-label="Catégorie correcte"
              >
                <option value="">— Catégorie —</option>
                {categories.map(cat => (
                  <option key={cat._id} value={cat._id}>{cat.name || `Catégorie (sans titre)`}</option>
                ))}
              </select>
              {items.length > 2 && (
                <button type="button" onClick={() => removeItem(ii)}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors">
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          ))}
        </div>
        <button type="button" onClick={() => setItems(prev => [...prev, newItem()])}
          className="flex items-center gap-1.5 text-sm font-semibold text-primary hover:text-primary/80 transition-colors">
          <Plus className="w-4 h-4" /> Ajouter un élément
        </button>
      </div>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-3">{error}</p>
      )}

      <div className="flex items-center gap-3">
        <button type="submit" disabled={isPending}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 transition-colors">
          {isPending && <Loader2 className="w-4 h-4 animate-spin" />}
          Créer l&apos;exercice
        </button>
        <Link href="/admin/exercises"
          className="px-5 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-gray-600 hover:bg-gray-50 transition-colors">
          Annuler
        </Link>
      </div>
    </form>
  )
}
