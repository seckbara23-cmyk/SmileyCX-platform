'use client'

import { useState, useTransition, useRef } from 'react'
import Link from 'next/link'
import { Plus, Trash2, Loader2 } from 'lucide-react'
import { createQuiz } from './actions'

interface Lesson { id: string; title: string; order_index: number }
interface Module { id: string; title: string; order_index: number; lessons: Lesson[] }
interface Course { id: string; title: string; modules: Module[] }

type QuestionType = 'multiple_choice' | 'multiple_answer' | 'true_false' | 'drag_match' | 'visual_choice'

interface DragMatchCategory { id: string; label: string }
interface DragMatchItem    { id: string; label: string; correctCategoryId: string }

interface QuestionDraft {
  _id:                 string
  question_type:       QuestionType
  question:            string
  explanation:         string
  options?:            string[]
  correct_answer?:     number
  correct_indices?:    number[]
  question_image_url?: string
  dm_categories?:      DragMatchCategory[]
  dm_items?:           DragMatchItem[]
}

function genId() { return Math.random().toString(36).slice(2) }

const TYPE_LABELS: Record<QuestionType, string> = {
  multiple_choice: 'Choix multiple',
  multiple_answer: 'Plusieurs réponses',
  true_false:      'Vrai / Faux',
  drag_match:      'Glisser-Déposer',
  visual_choice:   'Choix visuel',
}

const LETTERS = ['A', 'B', 'C', 'D']

function blankMCQuestion(): QuestionDraft {
  return { _id: genId(), question_type: 'multiple_choice', question: '', options: ['', '', '', ''], correct_answer: 0, explanation: '' }
}

function blankMAQuestion(): QuestionDraft {
  return { _id: genId(), question_type: 'multiple_answer', question: '', options: ['', '', '', ''], correct_indices: [], explanation: '' }
}

function blankTFQuestion(): QuestionDraft {
  return { _id: genId(), question_type: 'true_false', question: '', correct_answer: 0, explanation: '' }
}

function blankDMQuestion(): QuestionDraft {
  const catId1 = genId()
  const catId2 = genId()
  return {
    _id: genId(), question_type: 'drag_match', question: '', explanation: '',
    dm_categories: [{ id: catId1, label: '' }, { id: catId2, label: '' }],
    dm_items: [
      { id: genId(), label: '', correctCategoryId: catId1 },
      { id: genId(), label: '', correctCategoryId: catId2 },
    ],
  }
}

function blankVCQuestion(): QuestionDraft {
  return { _id: genId(), question_type: 'visual_choice', question: '', options: ['', '', '', ''], correct_answer: 0, question_image_url: '', explanation: '' }
}

function blankForType(t: QuestionType): QuestionDraft {
  if (t === 'multiple_answer') return blankMAQuestion()
  if (t === 'true_false')      return blankTFQuestion()
  if (t === 'drag_match')      return blankDMQuestion()
  if (t === 'visual_choice')   return blankVCQuestion()
  return blankMCQuestion()
}

export default function NewQuizForm({ courses }: { courses: Course[] }) {
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)

  const [courseId,  setCourseId]  = useState('')
  const [moduleId,  setModuleId]  = useState('')
  const [lessonId,  setLessonId]  = useState('')
  const [questions, setQuestions] = useState<QuestionDraft[]>([blankMCQuestion()])

  const selectedCourse  = courses.find(c => c.id === courseId)
  const modules  = (selectedCourse?.modules ?? []).slice().sort((a, b) => a.order_index - b.order_index)
  const selectedModule  = modules.find(m => m.id === moduleId)
  const lessons  = (selectedModule?.lessons ?? []).slice().sort((a, b) => a.order_index - b.order_index)

  function handleCourseChange(id: string) { setCourseId(id); setModuleId(''); setLessonId('') }
  function handleModuleChange(id: string) { setModuleId(id); setLessonId('') }

  function addQuestion(type: QuestionType) {
    setQuestions(prev => [...prev, blankForType(type)])
  }

  function removeQuestion(id: string) {
    setQuestions(prev => prev.filter(q => q._id !== id))
  }

  function updateQuestion(id: string, patch: Record<string, unknown>) {
    setQuestions(prev => prev.map(q => q._id === id ? { ...q, ...patch } : q))
  }

  function changeQuestionType(id: string, type: QuestionType) {
    setQuestions(prev => prev.map(q => {
      if (q._id !== id) return q
      const draft = blankForType(type)
      draft._id         = q._id
      draft.question    = q.question
      draft.explanation = q.explanation
      return draft
    }))
  }

  function updateOption(id: string, oi: number, val: string) {
    setQuestions(prev => prev.map(q => {
      if (q._id !== id) return q
      const options = [...(q.options ?? ['', '', '', ''])]
      options[oi] = val
      return { ...q, options }
    }))
  }

  function toggleMACorrect(id: string, oi: number) {
    setQuestions(prev => prev.map(q => {
      if (q._id !== id) return q
      const curr = q.correct_indices ?? []
      const next = curr.includes(oi) ? curr.filter(x => x !== oi) : [...curr, oi]
      return { ...q, correct_indices: next }
    }))
  }

  function addDMCategory(id: string) {
    setQuestions(prev => prev.map(q => {
      if (q._id !== id) return q
      return { ...q, dm_categories: [...(q.dm_categories ?? []), { id: genId(), label: '' }] }
    }))
  }

  function updateDMCategory(id: string, ci: number, label: string) {
    setQuestions(prev => prev.map(q => {
      if (q._id !== id) return q
      const dm_categories = (q.dm_categories ?? []).map((c, i) => i === ci ? { ...c, label } : c)
      return { ...q, dm_categories }
    }))
  }

  function removeDMCategory(id: string, catId: string) {
    setQuestions(prev => prev.map(q => {
      if (q._id !== id) return q
      return { ...q, dm_categories: (q.dm_categories ?? []).filter(c => c.id !== catId) }
    }))
  }

  function addDMItem(id: string) {
    setQuestions(prev => prev.map(q => {
      if (q._id !== id) return q
      const firstCatId = (q.dm_categories ?? [])[0]?.id ?? ''
      return { ...q, dm_items: [...(q.dm_items ?? []), { id: genId(), label: '', correctCategoryId: firstCatId }] }
    }))
  }

  function updateDMItem(id: string, ii: number, patch: Partial<DragMatchItem>) {
    setQuestions(prev => prev.map(q => {
      if (q._id !== id) return q
      const dm_items = (q.dm_items ?? []).map((item, i) => i === ii ? { ...item, ...patch } : item)
      return { ...q, dm_items }
    }))
  }

  function removeDMItem(id: string, ii: number) {
    setQuestions(prev => prev.map(q => {
      if (q._id !== id) return q
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
          <div key={q._id} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-gray-800">Question {qi + 1}</h3>
              {questions.length > 1 && (
                <button type="button" onClick={() => removeQuestion(q._id)} className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors">
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* Type selector */}
            <div className="flex flex-wrap gap-2">
              {(Object.keys(TYPE_LABELS) as QuestionType[]).map(type => (
                <button
                  key={type}
                  type="button"
                  onClick={() => changeQuestionType(q._id, type)}
                  className={`px-3 py-1 rounded-lg text-xs font-semibold transition-colors ${
                    q.question_type === type ? 'bg-primary text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                  }`}
                >
                  {TYPE_LABELS[type]}
                </button>
              ))}
            </div>

            {/* Question text */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`q-text-${q._id}`} className="text-xs font-semibold text-gray-600">
                Texte <span className="text-red-500">*</span>
              </label>
              <textarea
                id={`q-text-${q._id}`}
                value={q.question}
                onChange={e => updateQuestion(q._id, { question: e.target.value })}
                rows={2}
                placeholder="Quel est l'objectif principal de l'expérience client ?"
                className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all resize-none"
              />
            </div>

            {/* ── Visual choice image ───────────────────────────────────── */}
            {q.question_type === 'visual_choice' && (
              <div className="flex flex-col gap-1.5">
                <label htmlFor={`q-img-${q._id}`} className="text-xs font-semibold text-gray-600">
                  URL de l&apos;image
                </label>
                <input
                  id={`q-img-${q._id}`}
                  type="url"
                  value={q.question_image_url ?? ''}
                  onChange={e => updateQuestion(q._id, { question_image_url: e.target.value })}
                  placeholder="https://…/image.jpg"
                  className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                />
                {q.question_image_url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={q.question_image_url} alt="preview" className="mt-1 h-32 w-auto rounded-lg object-contain border border-gray-100" />
                )}
              </div>
            )}

            {/* ── Multiple choice / Multiple answer / Visual choice options ── */}
            {(q.question_type === 'multiple_choice' || q.question_type === 'multiple_answer' || q.question_type === 'visual_choice') && (
              <>
                <div className="grid sm:grid-cols-2 gap-3">
                  {(q.options ?? ['', '', '', '']).map((opt, oi) => {
                    const isCorrectMC = q.question_type !== 'multiple_answer' && q.correct_answer === oi
                    const isCorrectMA = q.question_type === 'multiple_answer' && (q.correct_indices ?? []).includes(oi)
                    const isCorrect   = isCorrectMC || isCorrectMA
                    return (
                      <div key={oi} className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            q.question_type === 'multiple_answer'
                              ? toggleMACorrect(q._id, oi)
                              : updateQuestion(q._id, { correct_answer: oi })
                          }
                          title={isCorrect ? 'Bonne réponse' : 'Marquer comme bonne réponse'}
                          className={`w-7 h-7 rounded-full border-2 flex items-center justify-center text-xs font-bold shrink-0 transition-all ${
                            isCorrect ? 'border-green-500 bg-green-500 text-white' : 'border-gray-300 text-gray-400 hover:border-primary hover:text-primary'
                          }`}
                        >
                          {LETTERS[oi]}
                        </button>
                        <input
                          type="text"
                          value={opt}
                          onChange={e => updateOption(q._id, oi, e.target.value)}
                          placeholder={`Option ${LETTERS[oi]}`}
                          className="flex-1 px-3 py-2 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                        />
                      </div>
                    )
                  })}
                </div>
                <p className="text-xs text-gray-400">
                  {q.question_type === 'multiple_answer'
                    ? 'Cliquez sur A/B/C/D pour marquer les bonnes réponses (plusieurs possibles).'
                    : 'Cliquez sur A/B/C/D pour sélectionner la bonne réponse (cercle vert).'}
                </p>
              </>
            )}

            {/* ── True / False ──────────────────────────────────────────── */}
            {q.question_type === 'true_false' && (
              <div className="flex gap-3">
                {['Vrai', 'Faux'].map((label, oi) => (
                  <button
                    key={oi}
                    type="button"
                    onClick={() => updateQuestion(q._id, { correct_answer: oi })}
                    className={`flex-1 py-2.5 rounded-xl text-sm font-semibold border-2 transition-all ${
                      q.correct_answer === oi
                        ? 'border-green-500 bg-green-50 text-green-700'
                        : 'border-gray-200 text-gray-500 hover:border-primary hover:text-primary'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}

            {/* ── Drag-match fields ──────────────────────────────────────── */}
            {q.question_type === 'drag_match' && (
              <div className="space-y-4">
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
                          onChange={e => updateDMCategory(q._id, ci, e.target.value)}
                          placeholder={`Catégorie ${ci + 1}`}
                          className="flex-1 px-3 py-2 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                        />
                        {(q.dm_categories ?? []).length > 2 && (
                          <button type="button" onClick={() => removeDMCategory(q._id, cat.id)} className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  <button type="button" onClick={() => addDMCategory(q._id)} className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-primary hover:text-primary/80 transition-colors">
                    <Plus className="w-3.5 h-3.5" /> Ajouter une catégorie
                  </button>
                </div>

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
                          onChange={e => updateDMItem(q._id, ii, { label: e.target.value })}
                          placeholder={`Élément ${ii + 1}`}
                          className="flex-1 px-3 py-2 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
                        />
                        <select
                          value={item.correctCategoryId}
                          onChange={e => updateDMItem(q._id, ii, { correctCategoryId: e.target.value })}
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
                          <button type="button" onClick={() => removeDMItem(q._id, ii)} className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  <button type="button" onClick={() => addDMItem(q._id)} className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-primary hover:text-primary/80 transition-colors">
                    <Plus className="w-3.5 h-3.5" /> Ajouter un élément
                  </button>
                </div>
              </div>
            )}

            {/* Explanation */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`q-expl-${q._id}`} className="text-xs font-semibold text-gray-600">
                Explication <span className="text-gray-400 font-normal">(optionnel)</span>
              </label>
              <input
                id={`q-expl-${q._id}`}
                type="text"
                value={q.explanation}
                onChange={e => updateQuestion(q._id, { explanation: e.target.value })}
                placeholder="Affiché après la réponse pour expliquer le bon choix."
                className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all"
              />
            </div>
          </div>
        ))}

        {/* Add question buttons */}
        <div className="flex flex-wrap gap-2">
          {(Object.keys(TYPE_LABELS) as QuestionType[]).map(type => (
            <button
              key={type}
              type="button"
              onClick={() => addQuestion(type)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-dashed border-gray-200 text-xs font-semibold text-gray-500 hover:border-primary hover:text-primary transition-colors"
            >
              <Plus className="w-3.5 h-3.5" /> {TYPE_LABELS[type]}
            </button>
          ))}
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
