'use client'

import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { useCallback, useTransition } from 'react'
import { Search, X } from 'lucide-react'

interface Course { id: string; title: string }

interface Props {
  courses: Course[]
  currentQ?: string
  currentCourse?: string
  currentStatus?: string
  currentPdf?: string
}

export default function CertSearchBar({
  courses,
  currentQ = '',
  currentCourse = '',
  currentStatus = '',
  currentPdf = '',
}: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [, startTransition] = useTransition()

  const update = useCallback((key: string, value: string) => {
    const params = new URLSearchParams(searchParams.toString())
    if (value) {
      params.set(key, value)
    } else {
      params.delete(key)
    }
    params.delete('page') // reset to page 1 on filter change
    startTransition(() => {
      router.replace(`${pathname}?${params.toString()}`, { scroll: false })
    })
  }, [router, pathname, searchParams])

  const clearAll = useCallback(() => {
    startTransition(() => {
      router.replace(pathname, { scroll: false })
    })
  }, [router, pathname])

  const hasFilters = currentQ || currentCourse || currentStatus || currentPdf

  return (
    <div className="flex flex-wrap gap-3 items-end">
      {/* Text search */}
      <div className="relative flex-1 min-w-[200px]">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
        <input
          type="text"
          placeholder="Nom, email, formation, N° certificat…"
          defaultValue={currentQ}
          onChange={e => update('q', e.target.value)}
          className="w-full pl-9 pr-3 py-2 rounded-xl border border-gray-200 text-sm focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none transition-all bg-white"
        />
      </div>

      {/* Course filter */}
      <select
        value={currentCourse}
        onChange={e => update('course', e.target.value)}
        className="px-3 py-2 rounded-xl border border-gray-200 text-sm bg-white focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none"
      >
        <option value="">Toutes les formations</option>
        {courses.map(c => (
          <option key={c.id} value={c.id}>{c.title}</option>
        ))}
      </select>

      {/* Status filter */}
      <select
        value={currentStatus}
        onChange={e => update('status', e.target.value)}
        className="px-3 py-2 rounded-xl border border-gray-200 text-sm bg-white focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none"
      >
        <option value="">Tous les statuts</option>
        <option value="valid">Valide</option>
        <option value="revoked">Révoqué</option>
        <option value="pilot">Pilote</option>
        <option value="duplicate">Doublon</option>
      </select>

      {/* PDF filter */}
      <select
        value={currentPdf}
        onChange={e => update('pdf', e.target.value)}
        className="px-3 py-2 rounded-xl border border-gray-200 text-sm bg-white focus:border-primary focus:ring-2 focus:ring-primary/20 outline-none"
      >
        <option value="">PDF — tous</option>
        <option value="generated">PDF généré</option>
        <option value="missing">PDF manquant</option>
      </select>

      {/* Clear */}
      {hasFilters && (
        <button
          onClick={clearAll}
          className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-xl transition-colors"
        >
          <X className="w-3.5 h-3.5" /> Effacer
        </button>
      )}
    </div>
  )
}
