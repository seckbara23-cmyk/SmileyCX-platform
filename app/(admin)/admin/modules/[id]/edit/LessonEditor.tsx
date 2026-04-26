'use client'

import { useState, useTransition, useRef } from 'react'
import { useRouter } from 'next/navigation'
import {
  Plus, Pencil, Trash2, Video, FileText, Eye,
  Loader2, CheckCircle2, Upload,
} from 'lucide-react'
import { createLesson, updateLesson, deleteLesson } from './actions'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Lesson {
  id: string
  title: string
  slug: string
  content: string | null
  video_url: string | null
  pdf_url: string | null
  subtitle_url: string | null
  duration_minutes: number | null
  order_index: number
  is_preview: boolean
}

interface Props {
  moduleId: string
  initialLessons: Lesson[]
}

// ── File Upload Hook ──────────────────────────────────────────────────────────

type UploadState = { status: 'idle' } | { status: 'uploading'; progress: number } | { status: 'done'; url: string } | { status: 'error'; message: string }

function useFileUpload(folder: 'video' | 'pdf' | 'cover' | 'subtitle') {
  const [state, setState] = useState<UploadState>({ status: 'idle' })

  async function upload(file: File): Promise<string | null> {
    setState({ status: 'uploading', progress: 0 })

    try {
      // 1. Request a signed upload URL
      const res = await fetch('/api/admin/upload-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, contentType: file.type, folder }),
      })
      if (!res.ok) {
        const { error } = await res.json()
        setState({ status: 'error', message: error ?? 'Erreur serveur' })
        return null
      }
      const { signedUrl, publicUrl } = await res.json()

      // 2. Upload directly to Supabase Storage (no size limit via Next.js)
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.upload.onprogress = e =>
          setState({ status: 'uploading', progress: Math.round((e.loaded / e.total) * 100) })
        xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(`HTTP ${xhr.status}`)))
        xhr.onerror = () => reject(new Error('Upload échoué'))
        xhr.open('PUT', signedUrl)
        xhr.setRequestHeader('Content-Type', file.type)
        xhr.send(file)
      })

      setState({ status: 'done', url: publicUrl })
      return publicUrl
    } catch (err) {
      setState({ status: 'error', message: err instanceof Error ? err.message : 'Erreur inconnue' })
      return null
    }
  }

  function reset() { setState({ status: 'idle' }) }
  return { state, upload, reset }
}

// ── File Upload Widget ────────────────────────────────────────────────────────

function FileUploadWidget({
  folder,
  label,
  accept,
  currentUrl,
  onUploaded,
}: {
  folder: 'video' | 'pdf' | 'cover' | 'subtitle'
  label: string
  accept: string
  currentUrl: string
  onUploaded: (url: string) => void
}) {
  const { state, upload } = useFileUpload(folder)
  const inputRef = useRef<HTMLInputElement>(null)

  async function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const url = await upload(file)
    if (url) onUploaded(url)
  }

  const filename = currentUrl ? currentUrl.split('/').pop() : null

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-semibold text-gray-700">{label}</span>

      {currentUrl && (
        <div className="flex items-center gap-2 px-3 py-2 bg-green-50 border border-green-200 rounded-lg">
          <CheckCircle2 className="w-4 h-4 text-green-600 shrink-0" />
          <span className="text-xs text-green-700 truncate flex-1">{filename}</span>
          <a href={currentUrl} target="_blank" rel="noopener noreferrer"
            className="text-xs text-green-700 underline shrink-0">Voir</a>
        </div>
      )}

      {state.status === 'uploading' && (
        <div className="flex flex-col gap-1">
          <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-200"
              style={{ width: `${state.progress}%` }}
            />
          </div>
          <span className="text-xs text-gray-400">{state.progress}% — envoi en cours…</span>
        </div>
      )}

      {state.status === 'error' && (
        <p className="text-xs text-red-500">{state.message}</p>
      )}

      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={state.status === 'uploading'}
        className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-200 text-xs font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-50 transition-colors w-fit"
      >
        <Upload className="w-3.5 h-3.5" />
        {currentUrl ? 'Remplacer' : `Choisir ${label.toLowerCase()}`}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={handleChange}
      />
    </div>
  )
}

// ── Lesson Form ───────────────────────────────────────────────────────────────

function LessonForm({
  moduleId,
  lesson,
  nextOrder,
  onDone,
  onCancel,
  onRefresh,
}: {
  moduleId: string
  lesson?: Lesson
  nextOrder: number
  onDone: () => void
  onCancel: () => void
  onRefresh: () => void
}) {
  const isNew = !lesson
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const [title, setTitle] = useState(lesson?.title ?? '')
  const [slug, setSlug] = useState(lesson?.slug ?? '')
  const [content, setContent] = useState(lesson?.content ?? '')
  const [duration, setDuration] = useState(String(lesson?.duration_minutes ?? ''))
  const [orderIndex, setOrderIndex] = useState(String(lesson?.order_index ?? nextOrder))
  const [isPreview, setIsPreview] = useState(lesson?.is_preview ?? false)
  const [videoUrl, setVideoUrl] = useState(lesson?.video_url ?? '')
  const [pdfUrl, setPdfUrl] = useState(lesson?.pdf_url ?? '')
  const [subtitleUrl, setSubtitleUrl] = useState(lesson?.subtitle_url ?? '')

  function autoSlug(t: string) {
    return t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  }

  function handleTitleChange(v: string) {
    setTitle(v)
    if (isNew) setSlug(autoSlug(v))
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    const formData = new FormData()
    formData.set('module_id', moduleId)
    formData.set('title', title)
    formData.set('slug', slug)
    formData.set('content', content)
    formData.set('video_url', videoUrl)
    formData.set('pdf_url', pdfUrl)
    formData.set('subtitle_url', subtitleUrl)
    formData.set('duration_minutes', duration)
    formData.set('order_index', orderIndex)
    formData.set('is_preview', String(isPreview))
    if (!isNew) formData.set('lesson_id', lesson.id)

    startTransition(async () => {
      const result = isNew
        ? await createLesson(formData)
        : await updateLesson(formData)

      if (result?.error) {
        setError(result.error)
      } else {
        onDone()
        onRefresh()
      }
    })
  }

  return (
    <form onSubmit={handleSubmit} className="bg-gray-50 rounded-xl border border-gray-200 p-4 space-y-4">
      <div className="grid sm:grid-cols-2 gap-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="lesson-title" className="text-xs font-semibold text-gray-600">
            Titre <span className="text-red-500">*</span>
          </label>
          <input
            id="lesson-title"
            type="text"
            value={title}
            onChange={e => handleTitleChange(e.target.value)}
            required
            placeholder="Introduction à la CX"
            className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all bg-white"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="lesson-slug" className="text-xs font-semibold text-gray-600">
            Slug <span className="text-red-500">*</span>
          </label>
          <input
            id="lesson-slug"
            type="text"
            value={slug}
            onChange={e => setSlug(e.target.value)}
            required
            placeholder="introduction-cx"
            pattern="[a-z0-9-]+"
            className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm font-mono focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all bg-white"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="lesson-duration" className="text-xs font-semibold text-gray-600">Durée (minutes)</label>
          <input
            id="lesson-duration"
            type="number"
            value={duration}
            onChange={e => setDuration(e.target.value)}
            min={1}
            placeholder="15"
            className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all bg-white"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="lesson-order" className="text-xs font-semibold text-gray-600">Ordre</label>
          <input
            id="lesson-order"
            type="number"
            value={orderIndex}
            onChange={e => setOrderIndex(e.target.value)}
            min={0}
            className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all bg-white"
          />
        </div>

        <div className="sm:col-span-2 flex flex-col gap-1.5">
          <label htmlFor="lesson-content" className="text-xs font-semibold text-gray-600">Contenu (Markdown)</label>
          <textarea
            id="lesson-content"
            value={content}
            onChange={e => setContent(e.target.value)}
            rows={5}
            placeholder="## Titre&#10;Rédigez le contenu de la leçon en Markdown…"
            className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm font-mono focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all resize-none bg-white"
          />
        </div>
      </div>

      {/* Media uploads */}
      <div className="grid sm:grid-cols-2 gap-4 pt-2 border-t border-gray-200">
        <FileUploadWidget
          folder="video"
          label="Vidéo"
          accept="video/mp4,video/quicktime,video/webm"
          currentUrl={videoUrl}
          onUploaded={setVideoUrl}
        />
        <FileUploadWidget
          folder="pdf"
          label="PDF"
          accept="application/pdf"
          currentUrl={pdfUrl}
          onUploaded={setPdfUrl}
        />
        <FileUploadWidget
          folder="subtitle"
          label="Sous-titres (.vtt)"
          accept=".vtt,text/vtt,text/plain"
          currentUrl={subtitleUrl}
          onUploaded={setSubtitleUrl}
        />
        <p className="text-xs text-gray-400 self-end pb-1">
          Format WebVTT uniquement. Les sous-titres s&apos;affichent sur la vidéo avec bouton CC activable.
        </p>
      </div>

      {/* Is preview toggle */}
      <div className="flex items-center gap-2 pt-1">
        <input
          type="checkbox"
          id={`preview-${lesson?.id ?? 'new'}`}
          checked={isPreview}
          onChange={e => setIsPreview(e.target.checked)}
          className="w-4 h-4 rounded accent-primary"
        />
        <label htmlFor={`preview-${lesson?.id ?? 'new'}`} className="text-sm text-gray-700 cursor-pointer">
          Leçon en aperçu libre (visible sans inscription)
        </label>
      </div>

      {error && (
        <p className="text-sm text-red-500 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {error}
        </p>
      )}

      <div className="flex items-center gap-3 pt-1">
        <button
          type="submit"
          disabled={isPending}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-white text-sm font-semibold hover:bg-primary/90 disabled:opacity-60 transition-colors"
        >
          {isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {isNew ? 'Ajouter la leçon' : 'Enregistrer'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 rounded-lg border border-gray-200 text-sm font-semibold text-gray-600 hover:bg-gray-50 transition-colors"
        >
          Annuler
        </button>
      </div>
    </form>
  )
}

// ── Lesson Row ────────────────────────────────────────────────────────────────

function LessonRow({
  lesson,
  moduleId,
  onEdit,
  onRefresh,
}: {
  lesson: Lesson
  moduleId: string
  onEdit: () => void
  onRefresh: () => void
}) {
  const [isPending, startTransition] = useTransition()

  function handleDelete() {
    if (!confirm(`Supprimer "${lesson.title}" ? Cette action est irréversible.`)) return
    const formData = new FormData()
    formData.set('lesson_id', lesson.id)
    formData.set('module_id', moduleId)
    startTransition(async () => {
      await deleteLesson(formData)
      onRefresh()
    })
  }

  return (
    <div className={`flex items-center gap-3 px-4 py-3 border-b border-gray-50 last:border-0 ${isPending ? 'opacity-50' : ''}`}>
      <span className="text-xs font-bold text-gray-300 w-5 shrink-0 text-right">{lesson.order_index}</span>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-medium text-gray-800 truncate">{lesson.title}</p>
          {lesson.is_preview && (
            <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-600 font-semibold shrink-0">
              <Eye className="w-2.5 h-2.5" /> Aperçu
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 mt-0.5">
          {lesson.duration_minutes && (
            <span className="text-xs text-gray-400">{lesson.duration_minutes} min</span>
          )}
          {lesson.video_url && (
            <span className="inline-flex items-center gap-1 text-[10px] text-violet-600 font-semibold">
              <Video className="w-3 h-3" /> Vidéo
            </span>
          )}
          {lesson.pdf_url && (
            <span className="inline-flex items-center gap-1 text-[10px] text-orange-600 font-semibold">
              <FileText className="w-3 h-3" /> PDF
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={onEdit}
          className="p-1.5 rounded-lg text-gray-400 hover:text-primary hover:bg-primary/5 transition-colors"
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={handleDelete}
          disabled={isPending}
          className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 disabled:opacity-50 transition-colors"
        >
          {isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
        </button>
      </div>
    </div>
  )
}

// ── Main LessonEditor ─────────────────────────────────────────────────────────

export default function LessonEditor({ moduleId, initialLessons }: Props) {
  const router = useRouter()
  const [editing, setEditing] = useState<string | null>(null) // lesson id or 'new'

  const lessons = initialLessons
  const nextOrder = lessons.length > 0 ? Math.max(...lessons.map(l => l.order_index)) + 1 : 1

  function handleDone() {
    setEditing(null)
    router.refresh()
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
        <h2 className="font-bold text-gray-800 text-sm flex items-center gap-2">
          Leçons
          <span className="text-xs font-normal text-gray-400">({lessons.length})</span>
        </h2>
        {editing !== 'new' && (
          <button
            type="button"
            onClick={() => setEditing('new')}
            className="inline-flex items-center gap-1 text-xs text-primary font-semibold hover:underline"
          >
            <Plus className="w-3.5 h-3.5" /> Ajouter une leçon
          </button>
        )}
      </div>

      {/* Lessons list */}
      {lessons.length === 0 && editing !== 'new' && (
        <p className="text-sm text-gray-400 text-center py-8">
          Aucune leçon — ajoutez-en une pour commencer.
        </p>
      )}

      {lessons.map(lesson => (
        <div key={lesson.id}>
          {editing === lesson.id ? (
            <div className="p-4">
              <LessonForm
                moduleId={moduleId}
                lesson={lesson}
                nextOrder={nextOrder}
                onDone={handleDone}
                onCancel={() => setEditing(null)}
                onRefresh={router.refresh}
              />
            </div>
          ) : (
            <LessonRow
              lesson={lesson}
              moduleId={moduleId}
              onEdit={() => setEditing(lesson.id)}
              onRefresh={router.refresh}
            />
          )}
        </div>
      ))}

      {/* Add lesson form */}
      {editing === 'new' && (
        <div className="p-4 border-t border-gray-100">
          <LessonForm
            moduleId={moduleId}
            nextOrder={nextOrder}
            onDone={handleDone}
            onCancel={() => setEditing(null)}
            onRefresh={router.refresh}
          />
        </div>
      )}
    </div>
  )
}
