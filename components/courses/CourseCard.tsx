import Link from 'next/link'
import { Clock, BookOpen, Award, Users, Lock } from 'lucide-react'
import Badge from '@/components/ui/Badge'
import { formatPrice, LEVEL_LABELS } from '@/lib/utils/cn'
import type { Course } from '@/types'

interface CourseCardProps {
  course: Course
  enrolled?: boolean
  progress?: number
  available?: boolean
  audience?: string
  outcome?: string
}

export default function CourseCard({
  course,
  enrolled = false,
  progress,
  available = true,
  audience,
  outcome,
}: CourseCardProps) {
  const levelLabel = LEVEL_LABELS[course.level] ?? course.level

  return (
    <Link
      href={`/courses/${course.slug}`}
      className={`cx-card cx-card-hover flex flex-col overflow-hidden group${!available ? ' opacity-75' : ''}`}
    >
      {/* Thumbnail */}
      <div className="relative bg-gradient-to-br from-primary/20 to-secondary/20 h-40 flex items-center justify-center overflow-hidden">
        {course.cover_url ? (
          <img src={course.cover_url} alt={course.title} className="w-full h-full object-cover" />
        ) : (
          <div className="text-5xl font-extrabold text-primary/20 select-none">CX</div>
        )}
        {!available && (
          <div className="absolute inset-0 bg-dark/30 flex items-center justify-center">
            <span className="bg-white text-dark text-xs font-bold px-3 py-1.5 rounded-full flex items-center gap-1.5">
              <Lock className="w-3 h-3" /> Bientôt disponible
            </span>
          </div>
        )}
        {course.is_free && available && (
          <span className="absolute top-3 left-3 cx-badge bg-success text-white text-[11px] font-bold">
            GRATUIT
          </span>
        )}
        <Badge variant="level" className="absolute top-3 right-3 text-[11px]">
          {levelLabel}
        </Badge>
      </div>

      {/* Body */}
      <div className="p-5 flex flex-col flex-1">
        {/* Availability chip */}
        <div className="mb-2">
          {available ? (
            <span className="text-[11px] font-bold text-success bg-success/10 px-2.5 py-0.5 rounded-full">
              Disponible
            </span>
          ) : (
            <span className="text-[11px] font-semibold text-cx-gray bg-light px-2.5 py-0.5 rounded-full border border-black/[0.06]">
              Bientôt disponible
            </span>
          )}
        </div>

        <h3 className="font-bold text-dark text-sm leading-snug mb-1.5 group-hover:text-primary transition-colors line-clamp-2">
          {course.title}
        </h3>

        {/* Outcome */}
        {outcome && (
          <p className="text-xs text-primary font-medium mb-1.5 leading-relaxed">
            Vous apprendrez à : {outcome.replace(/^[A-Z]/, c => c.toLowerCase())}
          </p>
        )}

        <p className="text-xs text-cx-gray leading-relaxed mb-3 line-clamp-2 flex-1">
          {course.description}
        </p>

        {/* Audience */}
        {audience && (
          <p className="text-[11px] text-cx-gray mb-3 flex items-center gap-1.5">
            <Users className="w-3 h-3 shrink-0" />
            <span className="truncate">{audience}</span>
          </p>
        )}

        {/* Meta */}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-cx-gray mb-3">
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
        </div>

        {/* Progress bar (when enrolled) */}
        {enrolled && progress !== undefined && (
          <div className="mb-3">
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
          ) : available ? (
            <span className="text-lg font-extrabold text-dark">
              {course.is_free ? 'Gratuit' : formatPrice(course.price, course.currency)}
            </span>
          ) : (
            <span className="text-sm text-cx-gray">—</span>
          )}
          <span className="text-xs font-semibold text-primary group-hover:underline">
            {enrolled ? 'Continuer →' : available ? 'Voir la formation →' : 'En savoir plus →'}
          </span>
        </div>
      </div>
    </Link>
  )
}
