'use client'

import { useState, useTransition, useRef } from 'react'
import Link from 'next/link'
import { Plus, Trash2, Loader2 } from 'lucide-react'
import { createQuiz } from './actions'

interface Lesson { id: string; title: string; order_index: number }
interface Module { id: string; title: string; order_index: number; lessons: Lesson[] }
interface Course { id: string; title: string; modules: Module[] }

type QuestionType = 'multiple_choice' | 'drag_match'

interface DragMatchCategory { id: string; label: string }
interface DragMatchItem    { id: string; label: string; correctCategoryId: string }

interface QuestionDraft {
  question_type: QuestionType
  question:      string
  explanation:   string
  // MC only
  options?:        [string, string, string, string]
  correct_answer?: number
  // DM only
  dm_categories?: DragMatchCategory[]
  dm_items?:      DragMatchItem[]
}

const LETTERS = ['A', 'B', 'C', 'D']

function blankMCQuestion(): QuestionDraft {
  return { question_type: 'multiple_choice', question: '', options: ['', '', '', ''], correct_answer: 0, explanation: '' }
}

function blankDMQuestion(): QuestionDraft {
  const catId1 = crypto.randomUUID()
  const catId2 = crypto.randomUUID()
  return {
    question_type: 'drag_match', question: '', explanation: '',
    dm_categories: [{ id: catId1, label: '' }, { id: catId2, label: '' }],
    dm_items: [
      { id: crypto.randomUUID(), label: '', correctCategoryId: catId1 },
      { id: crypto.randomUUID(), label: '', correctCategoryId: catId2 },
    ],
  }
}

export default function NewQuizForm({ courses }: { courses: Course[] }) {
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)

  const [courseId,   setCourseId]   = useState('')
  const [moduleId,   setModuleId]   = useState('')
  const [lessonId,   setLessonId]   = useState('')
  const [questions,  setQuestions]  = useState<QuestionDraft[]>([blankMCQuestion()])

  const selectedCourse = courses.find(c => c.id === courseId)
  const modules  = (selectedCourse?.modules ?? []).slice().sort((a, b) => a.order_index - b.order_index)
  const selectedModule = modules.find(m => m.id === moduleId)
  const lessons  = (selectedModule?.lessons ?? []).slice().sort((a, b) => a.order_index - b.order_index)

  function handleCourseChange(id: string) { setCourseId(id); setModuleId(''); setLessonId('') }
  function handleModuleChange(id: string) { setModuleId(id); setLessonId('') }

  function removeQuestion(i: number) {
    setQuestions(prev => prev.filter((_, idx) => idx !== i))
  }

  function updateQuestion(i: number, patch: Record<string, unknown>) {
    setQuestions(prev => prev.map((q, idx) => idx === i ? { ...q, ...patch } : q))
  }

  function changeQuestionType(i: number, type: QuestionType) {
    setQuestions(prev => prev.map((q, idx) => {
      if (idx !== i) return q
      if (type === 'multiple_choice') {
        return { question_type: 'multiple_choice', question: q.question, explanation: q.explanation, options: ['', '', '', ''] as [string, string, string, string], correct_answer: 0 }
      }
      const catId1 = crypto.randomUUID()
      const catId2 = crypto.randomUUID()
      return { question_type: 'drag_match', question: q.question, explanation: q.explanation, dm_categories: [{ id: catId1, label: '' }, { id: catId2, label: '' }], dm_items: [{ id: crypto.randomUUID(), label: '', correctCategoryId: catId1 }, { id: crypto.randomUUID(), label: '', correctCategoryId: catId2 }] }
    }))
  }

  function updateMCOption(qi: number, oi: number, val: string) {
    setQuestions(prev => prev.map((q, idx) => {
      if (idx !== qi) return q
      const options = [...(q.options ?? ['', '', '', ''])] as [string, string, string, string]
      options[oi] = val
      return { ...q, options }
    }))
  }

  function addDMCategory(qi: number) {
    setQuestions(prev => prev.map((q, idx) => {
      if (idx !== qi) return q
      return { ...q, dm_categories: [...(q.dm_categories ?? []), { id: crypto.randomUUID(), label: '' }] }
    }))
  }

  function updateDMCategory(qi: number, ci: number, label: string) {
    setQuestions(prev => prev.map((q, idx) => {
      if (idx !== qi) return q
      const dm_categories = (q.dm_categories ?? []).map((c, i) => i === ci ? { ...c, label } : c)
      return { ...q, dm_categories }
    }))
  }

  function removeDMCategory(qi: number, catId: string) {
    setQuestions(prev => prev.map((q, idx) => {
      if (idx !== qi) return q
      return { ...q, dm_categories: (q.dm_categories ?? []).filter(c => c.id !== catId) }
    }))
  }

  function addDMItem(qi: number) {
    setQuestions(prev => prev.map((q, idx) => {
      if (idx !== qi) return q
      const firstCatId = (q.dm_categories ?? [])[0]?.id ?? ''
      return { ...q, dm_items: [...(q.dm_items ?? []), { id: crypto.randomUUID(), label: '', correctCategoryId: firstCatId }] }
    }))
  }

  function updateDMItem(qi: number, ii: number, patch: Partial<DragMatchItem>) {
    setQuestions(prev => prev.map((q, idx) => {
      if (idx !== qi) return q
      const dm_items = (q.dm_items ?? []).map((item, i) => i === ii ? { ...item, ...patch } : item)
      return { ...q, dm_items }
    }))
  }

  function removeDMItem(qi: number, ii: number) {
    setQuestions(prev => prev.map((q, idx) => {
      if (idx !== qi) return q
      return { ...q, dm_items: (q.dm_items ?? []).filter((_, i) => i !== ii) }
    }))
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    const fd = new FormData()
    fd.set('title', titleRef.current?.value.trim() ?? '')
    if (lessonId) {
      fd.set('lesson_id', lessonId)
    } else {
      fd.set('module_id', moduleId)
    }
    fd.set('questions_json', JSON.stringify(questions.map((q, i) => ({ ...q, order_index: i }))))
    startTransition(async () => {
      const result = await createQuiz(fd)
      if (result?.error) setError(result.error)
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Basic info */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 sm:p-6 space-y-5">
        <h2 className="text-sm font-bold text-gray-700 pb-2 border-b border-gray-100">Informations générales</h2>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="title" className="text-sm font-semibold text-gray-700">
            Titre du quiz <span className="text-red-500">*</span>
          </label>
          <input
            id="title"
            ref={titleRef}
            type="text"
            required
            placeholder="Quiz — Module 1"
            className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
          />
        </div>

        <div className="grid sm:grid-cols-3 gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="new-course" className="text-sm font-semibold text-gray-700">
              Formation <span className="text-red-500">*</span>
            </label>
            <select
              id="new-course"
              value={courseId}
              onChange={e => handleCourseChange(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm bg-white focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
            >
              <option value="">— Choisir —</option>
              {courses.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="new-module" className="text-sm font-semibold text-gray-700">
              Module <span className="text-red-500">*</span>
            </label>
            <select
              id="new-module"
              value={moduleId}
              onChange={e => handleModuleChange(e.target.value)}
              disabled={!courseId}
              className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm bg-white focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <option value="">— Choisir —</option>
              {modules.map(m => <option key={m.id} value={m.id}>{m.title}</option>)}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="new-lesson" className="text-sm font-semibold text-gray-700">
              Leçon <span className="text-xs text-gray-400 font-normal">(optionnel)</span>
            </label>
            <select
              id="new-lesson"
              value={lessonId}
              onChange={e => setLessonId(e.target.value)}
              disabled={!moduleId}
              className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm bg-white focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <option value="">— Attacher au module —</option>
              {lessons.map(l => <option key={l.id} value={l.id}>{l.title}</option>)}
            </select>
            <p className="text-xs text-gray-400">Laissez vide pour attacher le quiz au module.</p>
          </div>
        </div>
      </div>

      {/* Questions */}
      <div className="space-y-4">
        <h2 className="text-sm font-bold text-gray-700">Questions</h2>

        {questions.map((q, qi) => (
          <div key={qi} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-4">
            {/* Header */}
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-gray-800">Question {qi + 1}</h3>
              {questions.length > 1 && (
                <button type="button" onClick={() => removeQuestion(qi)} className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors">
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* Question type selector */}
            <div className="flex gap-2">
              {(['multiple_choice', 'drag_match'] as QuestionType[]).map(type => (
                <button
                  key={type}
                  type="button"
                  onClick={() => changeQuestionType(qi, type)}
                  className={`px-3 py-1 rounded-lg text-xs font-semibold transition-colors ${
                    q.question_type === type ? 'bg-primary text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                  }`}
                >
                  {type === 'multiple_choice' ? 'Choix multiple' : 'Glisser-Déposer'}
                </button>
              ))}
            </div>

            {/* Question text */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`q-text-${qi}`} className="text-xs font-semibold text-gray-600">
                Texte <span className="text-red-500">*</span>
              </label>
              <textarea
                id={`q-text-${qi}`}
                value={q.question}
                onChange={e => updateQuestion(qi, { question: e.target.value })}
                rows={2}
                placeholder="Quel est l'objectif principal de l'expérience client ?"
                className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all resize-none"
              />
            </div>

            {/* ── Multiple choice fields ─────────────────────────────────── */}
            {q.question_type === 'multiple_choice' && (
              <>
                <div className="grid sm:grid-cols-2 gap-3">
                  {(q.options ?? ['', '', '', '']).map((opt, oi) => (
                    <div key={oi} className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => updateQuestion(qi, { correct_answer: oi })}
                        title={q.correct_answer === oi ? 'Bonne réponse' : 'Marquer comme bonne réponse'}
                        className={`w-7 h-7 rounded-full border-2 flex items-center justify-center text-xs font-bold shrink-0 transition-all ${
                          q.correct_answer === oi ? 'border-green-500 bg-green-500 text-white' : 'border-gray-300 text-gray-400 hover:border-primary hover:text-primary'
                        }`}
                      >
                        {LETTERS[oi]}
                      </button>
                      <input
                        type="text"
                        value={opt}
                        onChange={e => updateMCOption(qi, oi, e.target.value)}
                        placeholder={`Option ${LETTERS[oi]}`}
                        className="flex-1 px-3 py-2 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                      />
                    </div>
                  ))}
                </div>
                <p className="text-xs text-gray-400">Cliquez sur A/B/C/D pour sélectionner la bonne réponse (cercle vert).</p>
              </>
            )}

            {/* ── Drag-match fields ──────────────────────────────────────── */}
            {q.question_type === 'drag_match' && (
              <div className="space-y-4">
                {/* Categories */}
                <div>
                  <p className="text-xs font-semibold text-gray-600 mb-2">
                    Catégories <span className="text-red-500">*</span>{' '}
                    <span className="text-gray-400 font-normal">(min. 2)</span>
                  </p>
                  <div className="space-y-2">
                    {(q.dm_categories ?? []).map((cat, ci) => (
                      <div key={cat.id} className="flex items-center gap-2">
                        <input
                          type="text"
                          value={cat.label}
                          onChange={e => updateDMCategory(qi, ci, e.target.value)}
                          placeholder={`Catégorie ${ci + 1}`}
                          className="flex-1 px-3 py-2 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                        />
                        {(q.dm_categories ?? []).length > 2 && (
                          <button type="button" onClick={() => removeDMCategory(qi, cat.id)} className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  <button type="button" onClick={() => addDMCategory(qi)} className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-primary hover:text-primary/80 transition-colors">
                    <Plus className="w-3.5 h-3.5" /> Ajouter une catégorie
                  </button>
                </div>

                {/* Items */}
                <div>
                  <p className="text-xs font-semibold text-gray-600 mb-2">
                    Éléments à placer <span className="text-red-500">*</span>{' '}
                    <span className="text-gray-400 font-normal">(min. 2)</span>
                  </p>
                  <div className="space-y-2">
                    {(q.dm_items ?? []).map((item, ii) => (
                      <div key={item.id} className="flex items-center gap-2">
                        <input
                          type="text"
                          value={item.label}
                          onChange={e => updateDMItem(qi, ii, { label: e.target.value })}
                          placeholder={`Élément ${ii + 1}`}
                          className="flex-1 px-3 py-2 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                        />
                        <select
                          value={item.correctCategoryId}
                          onChange={e => updateDMItem(qi, ii, { correctCategoryId: e.target.value })}
                          className="w-40 px-2 py-2 rounded-xl border border-gray-200 text-sm bg-white focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                        >
                          <option value="">— Catégorie correcte —</option>
                          {(q.dm_categories ?? []).map(cat => (
                            <option key={cat.id} value={cat.id}>
                              {cat.label || `Catégorie (sans titre)`}
                            </option>
                          ))}
                        </select>
                        {(q.dm_items ?? []).length > 2 && (
                          <button type="button" onClick={() => removeDMItem(qi, ii)} className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  <button type="button" onClick={() => addDMItem(qi)} className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-primary hover:text-primary/80 transition-colors">
                    <Plus className="w-3.5 h-3.5" /> Ajouter un élément
                  </button>
                </div>
              </div>
            )}

            {/* Explanation (both types) */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`q-expl-${qi}`} className="text-xs font-semibold text-gray-600">
                Explication <span className="text-gray-400 font-normal">(optionnel)</span>
              </label>
              <input
                id={`q-expl-${qi}`}
                type="text"
                value={q.explanation}
                onChange={e => updateQuestion(qi, { explanation: e.target.value })}
                placeholder="Affiché après la réponse pour expliquer le bon choix."
                className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
              />
            </div>
          </div>
        ))}

        {/* Add question buttons */}
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => setQuestions(prev => [...prev, blankMCQuestion()])}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-2xl border-2 border-dashed border-gray-200 text-sm font-semibold text-gray-500 hover:border-primary hover:text-primary transition-colors"
          >
            <Plus className="w-4 h-4" /> Choix multiple
          </button>
          <button
            type="button"
            onClick={() => setQuestions(prev => [...prev, blankDMQuestion()])}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-2xl border-2 border-dashed border-gray-200 text-sm font-semibold text-gray-500 hover:border-primary hover:text-primary transition-colors"
          >
            <Plus className="w-4 h-4" /> Glisser-Déposer
          </button>
        </div>
      </div>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-3">{error}</p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={isPending}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 transition-colors"
        >
          {isPending && <Loader2 className="w-4 h-4 animate-spin" />}
          Créer le quiz
        </button>
        <Link
          href="/admin/quizzes"
          className="px-5 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-gray-600 hover:bg-gray-50 transition-colors"
        >
          Annuler
        </Link>
      </div>
    </form>
  )
}
