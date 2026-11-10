import { Play } from 'lucide-react'
import { startFreeCourse } from '@/app/actions/free-course'

/**
 * XP-LAUNCH-FINAL-18 — the free course's call to action for a signed-in learner
 * without access yet. A form, not a link: granting access is a POST, never a GET
 * a prefetch could trigger.
 */
export default function FreeCourseStartForm({
  courseId,
  slug,
  className,
}: {
  courseId: string
  slug: string
  className: string
}) {
  return (
    <form action={startFreeCourse}>
      <input type="hidden" name="courseId" value={courseId} />
      <input type="hidden" name="slug" value={slug} />
      <button type="submit" className={className}>
        <Play className="w-4 h-4" />
        Commencer gratuitement
      </button>
    </form>
  )
}
