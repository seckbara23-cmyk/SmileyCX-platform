import { requirePlatformAdmin } from '@/lib/auth/session'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import type { Metadata } from 'next'
import NewCourseForm from './NewCourseForm'
import { listAssignableCourseCodes } from '@/lib/admin/course-codes'

export const metadata: Metadata = { title: 'Admin — Nouvelle formation' }

export default async function AdminNewCoursePage() {
  await requirePlatformAdmin()

  // CAT-1: a course may be given its academic identity at creation. Optional —
  // a code can still be assigned later from the edit form, but never changed
  // once set.
  const assignableCodes = await listAssignableCourseCodes()

  return (
    <div className="p-4 sm:p-6 max-w-2xl mx-auto space-y-6">
      <Link
        href="/admin/courses"
        className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-700 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" /> Retour aux formations
      </Link>

      <div>
        <h1 className="text-xl font-extrabold text-gray-900">Nouvelle formation</h1>
        <p className="text-sm text-gray-400 mt-0.5">Créez une nouvelle formation sur la plateforme.</p>
      </div>

      <NewCourseForm assignableCodes={assignableCodes} />
    </div>
  )
}
