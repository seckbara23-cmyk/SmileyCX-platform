'use client'

import { useTransition } from 'react'
import { Loader2 } from 'lucide-react'
import { deleteCourse } from './actions'

export default function DeleteCourseButton({
  courseId,
  courseTitle,
}: {
  courseId: string
  courseTitle: string
}) {
  const [isPending, startTransition] = useTransition()

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!confirm(`Supprimer "${courseTitle}" ? Cette action est irréversible.`)) return
    const formData = new FormData(e.currentTarget)
    startTransition(async () => {
      await deleteCourse(formData)
    })
  }

  return (
    <form onSubmit={handleSubmit}>
      <input type="hidden" name="id" value={courseId} />
      <button
        type="submit"
        disabled={isPending}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-red-600 text-white text-xs font-semibold hover:bg-red-700 disabled:opacity-60 transition-colors"
      >
        {isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
        Supprimer la formation
      </button>
    </form>
  )
}
