import Link from 'next/link'
import Image from 'next/image'
import { ArrowRight, Clock, GraduationCap, Lock } from 'lucide-react'
import type { CourseItem } from '../content'

export default function CourseCard({ course }: { course: CourseItem }) {
  return (
    <div className="cx-card flex flex-col rounded-2xl overflow-hidden hover:-translate-y-1 hover:shadow-md transition-all duration-300">

      {/* Image */}
      <div className="relative w-full h-44 bg-light shrink-0">
        {course.image ? (
          <Image
            src={course.image}
            alt=""
            fill
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
            className="object-cover"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <GraduationCap className="w-12 h-12 text-primary/20" aria-hidden />
          </div>
        )}
        {!course.available && (
          <div className="absolute inset-0 bg-dark/35 flex items-center justify-center">
            <span className="bg-white text-dark text-xs font-bold px-3 py-1.5 rounded-full inline-flex items-center gap-1.5">
              <Lock className="w-3 h-3" aria-hidden /> Bient&ocirc;t disponible
            </span>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex flex-col flex-1 p-5">
        <h3 className="text-[15px] font-bold text-dark leading-snug mb-2">{course.title}</h3>
        <p className="text-[13px] text-cx-gray leading-relaxed line-clamp-3 flex-1 mb-4">{course.desc}</p>

        {/* Footer: meta + CTA */}
        <div className="border-t border-black/[0.06] pt-4 flex items-center justify-between gap-3 flex-wrap">
          <span className="flex items-center gap-3 text-xs text-cx-gray">
            {course.duration && (
              <span className="flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5" aria-hidden /> {course.duration}
              </span>
            )}
            <span className="font-medium">{course.level}</span>
          </span>

          {course.available && course.slug ? (
            <Link
              href={`/courses/${course.slug}`}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-secondary text-white text-[13px] font-bold rounded-cx hover:bg-secondary-dark transition-all"
            >
              Voir la formation <ArrowRight className="w-3.5 h-3.5" aria-hidden />
            </Link>
          ) : (
            <Link
              href={`/contact?parcours=${course.parcours}`}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-light border border-black/[0.08] text-cx-gray text-[13px] font-semibold rounded-cx hover:bg-white transition-colors"
            >
              &Ecirc;tre notifi&eacute;
            </Link>
          )}
        </div>
      </div>

    </div>
  )
}
