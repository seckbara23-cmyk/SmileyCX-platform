'use client'

import { useState, useTransition, useRef } from 'react'
import Link from 'next/link'
import { Plus, Trash2, Loader2 } from 'lucide-react'
import { updateQuiz } from './actions'

interface Lesson { id: string; title: string; order_index: number }
interface Module { id: string; title: string; order_index: number; lessons: Lesson[] }
interface Course { id: string; title: string; modules: Module[] }

type QuestionType = 'multiple_choice' | 'multiple_answer' | 'true_false' | 'drag_match' | 'visual_choice'

interface DragMatchCategory { id: string; label: string }
interface DragMatchItem    { id: string; label: string; correctCategoryId: string }

interface QuestionDraft {
  id?:                 string
  order_index?:        number
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

interface Props {
  quizId:           string
  initialTitle:     string
  initialCourseId:  string
  initialModuleId:  string
  initialLessonId:  string
  initialQuestions: QuestionDraft[]
  courses:          Course[]
}

const TYPE_LABELS: Record<QuestionType, string> = {
  multiple_choice: 'Choix multiple',
  multiple_answer: 'Plusieurs réponses',
  true_false:      'Vrai / Faux',
  drag_match:      'Glisser-Déposer',
  visual_choice:   'Choix visuel',
}

const LETTERS = ['A', 'B', 'C', 'D']

function blankMCQuestion(order: number): QuestionDraft {
  return { question_type: 'multiple_choice', question: '', options: ['', '', '', ''], correct_answer: 0, explanation: '', order_index: order }
}

function blankForType(type: QuestionType, order: number): QuestionDraft {
  if (type === 'multiple_answer') return { question_type: 'multiple_answer', question: '', options: ['', '', '', ''], correct_indices: [], explanation: '', order_index: order }
  if (type === 'true_false')      return { question_type: 'true_false', question: '', correct_answer: 0, explanation: '', order_index: order }
  if (type === 'visual_choice')   return { question_type: 'visual_choice', question: '', options: ['', '', '', ''], correct_answer: 0, question_image_url: '', explanation: '', order_index: order }
  if (type === 'drag_match') {
    const catId1 = crypto.randomUUID(); const catId2 = crypto.randomUUID()
    return { question_type: 'drag_match', question: '', explanation: '', order_index: order, dm_categories: [{ id: catId1, label: '' }, { id: catId2, label: '' }], dm_items: [{ id: crypto.randomUUID(), label: '', correctCategoryId: catId1 }, { id: crypto.randomUUID(), label: '', correctCategoryId: catId2 }] }
  }
  return blankMCQuestion(order)
}

export default function EditQuizForm({
  quizId, initialTitle, initialCourseId, initialModuleId, initialLessonId, initialQuestions, courses,
}: Props) {
  const [isPending, startTransition] = useTransition()
  const [error,     setError]        = useState<string | null>(null)
  const titleRef                     = useRef<HTMLInputElement>(null)

  const [courseId,   setCourseId]   = useState(initialCourseId)
  const [moduleId,   setModuleId]   = useState(initialModuleId)
  const [lessonId,   setLessonId]   = useState(initialLessonId)
  const [questions,  setQuestions]  = useState<QuestionDraft[]>(initialQuestions)
  const [deletedIds, setDeletedIds] = useState<string[]>([])

  const selectedCourse = courses.find(c => c.id === courseId)
  const modules        = (selectedCourse?.modules ?? []).slice().sort((a, b) => a.order_index - b.order_index)
  const selectedModule = modules.find(m => m.id === moduleId)
  const lessons        = (selectedModule?.lessons ?? []).slice().sort((a, b) => a.order_index - b.order_index)

  function handleCourseChange(id: string) { setCourseId(id); setModuleId(''); setLessonId('') }
  function handleModuleChange(id: string) { setModuleId(id); setLessonId('') }

  function removeQuestion(i: number) {
    const q = questions[i]
    if (q.id) setDeletedIds(prev => [...prev, q.id!])
    setQuestions(prev => prev.filter((_, idx) => idx !== i))
  }

  function updateQuestion(i: number, patch: Record<string, unknown>) {
    setQuestions(prev => prev.map((q, idx) => idx === i ? { ...q, ...patch } : q))
  }

  function changeQuestionType(i: number, type: QuestionType) {
    setQuestions(prev => prev.map((q, idx) => {
      if (idx !== i) return q
      const draft = blankForType(type, q.order_index ?? i)
      draft.id          = q.id
      draft.question    = q.question
      draft.explanation = q.explanation
      return draft
    }))
  }

  function updateOption(qi: number, oi: number, val: string) {
    setQuestions(prev => prev.map((q, idx) => {
      if (idx !== qi) return q
      const options = [...(q.options ?? ['', '', '', ''])]
      options[oi] = val
      return { ...q, options }
    }))
  }

  function toggleMACorrect(qi: number, oi: number) {
    setQuestions(prev => prev.map((q, idx) => {
      if (idx !== qi) return q
      const curr = q.correct_indices ?? []
      const next = curr.includes(oi) ? curr.filter(x => x !== oi) : [...curr, oi]
      return { ...q, correct_indices: next }
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
    fd.set('quiz_id', quizId)
    fd.set('title', titleRef.current?.value.trim() ?? '')
    if (lessonId) { fd.set('lesson_id', lessonId) } else { fd.set('module_id', moduleId) }
    fd.set('questions_json', JSON.stringify(questions.map((q, i) => ({ ...q, order_index: i }))))
    fd.set('deleted_ids_json', JSON.stringify(deletedIds))
    startTransition(async () => {
      const result = await updateQuiz(fd)
      if (result?.error) setError(result.error)
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 sm:p-6 space-y-5">
        <h2 className="text-sm font-bold text-gray-700 pb-2 border-b border-gray-100">Informations générales</h2>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="edit-title" className="text-sm font-semibold text-gray-700">
            Titre du quiz <span className="text-red-500">*</span>
          </label>
          <input id="edit-title" ref={titleRef} type="text" required defaultValue={initialTitle}
            className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all" />
        </div>

        <div className="grid sm:grid-cols-3 gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="edit-course" className="text-sm font-semibold text-gray-700">Formation <span className="text-red-500">*</span></label>
            <select id="edit-course" value={courseId} onChange={e => handleCourseChange(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm bg-white focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all">
              <option value="">— Choisir —</option>
              {courses.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="edit-module" className="text-sm font-semibold text-gray-700">Module <span className="text-red-500">*</span></label>
            <select id="edit-module" value={moduleId} onChange={e => handleModuleChange(e.target.value)} disabled={!courseId}
              className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm bg-white focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all disabled:opacity-50 disabled:cursor-not-allowed">
              <option value="">— Choisir —</option>
              {modules.map(m => <option key={m.id} value={m.id}>{m.title}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="edit-lesson" className="text-sm font-semibold text-gray-700">Leçon <span className="text-xs text-gray-400 font-normal">(optionnel)</span></label>
            <select id="edit-lesson" value={lessonId} onChange={e => setLessonId(e.target.value)} disabled={!moduleId}
              className="w-full px-3.5 py-2.5 rounded-xl border border-gray-200 text-sm bg-white focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all disabled:opacity-50 disabled:cursor-not-allowed">
              <option value="">— Attacher au module —</option>
              {lessons.map(l => <option key={l.id} value={l.id}>{l.title}</option>)}
            </select>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <h2 className="text-sm font-bold text-gray-700">Questions</h2>

        {questions.map((q, qi) => (
          <div key={q.id ?? `new-${qi}`} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-gray-800">Question {qi + 1}</h3>
              {questions.length > 1 && (
                <button type="button" onClick={() => removeQuestion(qi)} className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors">
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              {(Object.keys(TYPE_LABELS) as QuestionType[]).map(type => (
                <button key={type} type="button" onClick={() => changeQuestionType(qi, type)}
                  className={`px-3 py-1 rounded-lg text-xs font-semibold transition-colors ${
                    q.question_type === type ? 'bg-primary text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                  }`}>
                  {TYPE_LABELS[type]}
                </button>
              ))}
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor={`eq-text-${qi}`} className="text-xs font-semibold text-gray-600">Texte <span className="text-red-500">*</span></label>
              <textarea id={`eq-text-${qi}`} value={q.question} onChange={e => updateQuestion(qi, { question: e.target.value })} rows={2}
                placeholder="Quel est l'objectif principal de l'expérience client ?"
                className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all resize-none" />
            </div>

            {q.question_type === 'visual_choice' && (
              <div className="flex flex-col gap-1.5">
                <label htmlFor={`eq-img-${qi}`} className="text-xs font-semibold text-gray-600">URL de l&apos;image</label>
                <input id={`eq-img-${qi}`} type="url" value={q.question_image_url ?? ''} onChange={e => updateQuestion(qi, { question_image_url: e.target.value })}
                  placeholder="https://…/image.jpg"
                  className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all" />
                {q.question_image_url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={q.question_image_url} alt="preview" className="mt-1 h-32 w-auto rounded-lg object-contain border border-gray-100" />
                )}
              </div>
            )}

            {(q.question_type === 'multiple_choice' || q.question_type === 'multiple_answer' || q.question_type === 'visual_choice') && (
              <>
                <div className="grid sm:grid-cols-2 gap-3">
                  {(q.options ?? ['', '', '', '']).map((opt, oi) => {
                    const isCorrectMC = q.question_type !== 'multiple_answer' && q.correct_answer === oi
                    const isCorrectMA = q.question_type === 'multiple_answer' && (q.correct_indices ?? []).includes(oi)
                    const isCorrect   = isCorrectMC || isCorrectMA
                    return (
                      <div key={oi} className="flex items-center gap-2">
                        <button type="button"
                          onClick={() => q.question_type === 'multiple_answer' ? toggleMACorrect(qi, oi) : updateQuestion(qi, { correct_answer: oi })}
                          className={`w-7 h-7 rounded-full border-2 flex items-center justify-center text-xs font-bold shrink-0 transition-all ${
                            isCorrect ? 'border-green-500 bg-green-500 text-white' : 'border-gray-300 text-gray-400 hover:border-primary hover:text-primary'
                          }`}>
                          {LETTERS[oi]}
                        </button>
                        <input type="text" value={opt} onChange={e => updateOption(qi, oi, e.target.value)} placeholder={`Option ${LETTERS[oi]}`}
                          className="flex-1 px-3 py-2 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all" />
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

            {q.question_type === 'true_false' && (
              <div className="flex gap-3">
                {['Vrai', 'Faux'].map((label, oi) => (
                  <button key={oi} type="button" onClick={() => updateQuestion(qi, { correct_answer: oi })}
                    className={`flex-1 py-2.5 rounded-xl text-sm font-semibold border-2 transition-all ${
                      q.correct_answer === oi ? 'border-green-500 bg-green-50 text-green-700' : 'border-gray-200 text-gray-500 hover:border-primary hover:text-primary'
                    }`}>
                    {label}
                  </button>
                ))}
              </div>
            )}

            {q.question_type === 'drag_match' && (
              <div className="space-y-4">
                <div>
                  <p className="text-xs font-semibold text-gray-600 mb-2">Catégories <span className="text-red-500">*</span> <span className="text-gray-400 font-normal">(min. 2)</span></p>
                  <div className="space-y-2">
                    {(q.dm_categories ?? []).map((cat, ci) => (
                      <div key={cat.id} className="flex items-center gap-2">
                        <input type="text" value={cat.label} onChange={e => updateDMCategory(qi, ci, e.target.value)} placeholder={`Catégorie ${ci + 1}`}
                          className="flex-1 px-3 py-2 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all" />
                        {(q.dm_categories ?? []).length > 2 && (
                          <button type="button" onClick={() => removeDMCategory(qi, cat.id)} className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"><Trash2 className="w-3.5 h-3.5" /></button>
                        )}
                      </div>
                    ))}
                  </div>
                  <button type="button" onClick={() => addDMCategory(qi)} className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-primary hover:text-primary/80 transition-colors">
                    <Plus className="w-3.5 h-3.5" /> Ajouter une catégorie
                  </button>
                </div>
                <div>
                  <p className="text-xs font-semibold text-gray-600 mb-2">Éléments à placer <span className="text-red-500">*</span> <span className="text-gray-400 font-normal">(min. 2)</span></p>
                  <div className="space-y-2">
                    {(q.dm_items ?? []).map((item, ii) => (
                      <div key={item.id} className="flex items-center gap-2">
                        <input type="text" value={item.label} onChange={e => updateDMItem(qi, ii, { label: e.target.value })} placeholder={`Élément ${ii + 1}`}
                          className="flex-1 px-3 py-2 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all" />
                        <select value={item.correctCategoryId} onChange={e => updateDMItem(qi, ii, { correctCategoryId: e.target.value })}
                          className="w-40 px-2 py-2 rounded-xl border border-gray-200 text-sm bg-white focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all">
                          <option value="">— Catégorie correcte —</option>
                          {(q.dm_categories ?? []).map(cat => <option key={cat.id} value={cat.id}>{cat.label || 'Catégorie (sans titre)'}</option>)}
                        </select>
                        {(q.dm_items ?? []).length > 2 && (
                          <button type="button" onClick={() => removeDMItem(qi, ii)} className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"><Trash2 className="w-3.5 h-3.5" /></button>
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

            <div className="flex flex-col gap-1.5">
              <label htmlFor={`eq-expl-${qi}`} className="text-xs font-semibold text-gray-600">Explication <span className="text-gray-400 font-normal">(optionnel)</span></label>
              <input id={`eq-expl-${qi}`} type="text" value={q.explanation} onChange={e => updateQuestion(qi, { explanation: e.target.value })}
                placeholder="Affiché après la réponse pour expliquer le bon choix."
                className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all" />
            </div>
          </div>
        ))}

        <div className="flex flex-wrap gap-2">
          {(Object.keys(TYPE_LABELS) as QuestionType[]).map(type => (
            <button key={type} type="button" onClick={() => setQuestions(prev => [...prev, blankForType(type, prev.length)])}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-dashed border-gray-200 text-xs font-semibold text-gray-500 hover:border-primary hover:text-primary transition-colors">
              <Plus className="w-3.5 h-3.5" /> {TYPE_LABELS[type]}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-3">{error}</p>
      )}

      <div className="flex items-center gap-3">
        <button type="submit" disabled={isPending}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-white text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 transition-colors">
          {isPending && <Loader2 className="w-4 h-4 animate-spin" />}
          Enregistrer les modifications
        </button>
        <Link href={`/admin/quizzes/${quizId}`}
          className="px-5 py-2.5 rounded-xl border border-gray-200 text-sm font-semibold text-gray-600 hover:bg-gray-50 transition-colors">
          Annuler
        </Link>
      </div>
    </form>
  )
}
