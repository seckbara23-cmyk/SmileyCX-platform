import Link from 'next/link'
import { Clock, BookOpen, Award, Users } from 'lucide-react'
import Badge from '@/components/ui/Badge'
import { formatPrice, LEVEL_LABELS } from '@/lib/utils/cn'
import type { Course } from '@/types'

interface CourseCardProps {
  course: Course
  enrolled?: boolean
  progress?: number
}

export default function CourseCard({ course, enrolled = false, progress }: CourseCardProps) {
  const levelLabel = LEVEL_LABELS[course.level] ?? course.level

  return (
    <Link
      href={`/courses/${course.slug}`}
      className="cx-card cx-card-hover flex flex-col overflow-hidden group"
    >
      {/* Thumbnail */}
      <div className="relative bg-gradient-to-br from-primary/20 to-secondary/20 h-44 flex items-center justify-center overflow-hidden">
        {course.cover_url ? (
          <img src={course.cover_url} alt={course.title} className="w-full h-full object-cover" />
        ) : (
          <div className="text-5xl font-extrabold text-primary/20 select-none">CX</div>
        )}
        {course.is_free && (
          <span className="absolute top-3 left-3 cx-badge bg-success text-white text-[11px] font-bold">
            GRATUIT
          </span>
        )}
        <Badge
          variant="level"
          className="absolute top-3 right-3 text-[11px]"
        >
          {levelLabel}
        </Badge>
      </div>

      {/* Body */}
      <div className="p-5 flex flex-col flex-1">
        <h3 className="font-bold text-dark text-base leading-snug mb-2 group-hover:text-primary transition-colors line-clamp-2">
          {course.title}
        </h3>
        <p className="text-sm text-cx-gray leading-relaxed mb-4 line-clamp-2 flex-1">
          {course.description}
        </p>

        {/* Meta */}
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-cx-gray mb-4">
          {course.duration_hours && (
            <span className="flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5" /> {course.duration_hours}h
            </span>
          )}
          {course.modules && (
            <span className="flex items-center gap-1.5">
              <BookOpen className="w-3.5 h-3.5" /> {course.modules.length} modules
            </span>
          )}
          {course.enrollment_count !== undefined && (
            <span className="flex items-center gap-1.5">
              <Users className="w-3.5 h-3.5" /> {course.enrollment_count} apprenants
            </span>
          )}
        </div>

        {/* Progress bar (when enrolled) */}
        {enrolled && progress !== undefined && (
          <div className="mb-4">
            <div className="flex justify-between text-xs text-cx-gray mb-1.5">
              <span>Progression</span>
              <span className="font-semibold text-primary">{progress}%</span>
            </div>
            <div className="cx-progress-bar">
              <div className="cx-progress-bar-fill" style={{ width: `${progress}%` }} />
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between pt-3 border-t border-black/[0.06] mt-auto">
          {enrolled ? (
            <span className="text-sm font-semibold text-success flex items-center gap-1.5">
              <Award className="w-4 h-4" /> Inscrit
            </span>
          ) : (
            <span className="text-lg font-extrabold text-dark">
              {course.is_free ? 'Gratuit' : formatPrice(course.price, course.currency)}
            </span>
          )}
          <span className="text-xs font-semibold text-primary group-hover:underline">
            {enrolled ? 'Continuer →' : 'Voir la formation →'}
          </span>
        </div>
      </div>
    </Link>
  )
}
