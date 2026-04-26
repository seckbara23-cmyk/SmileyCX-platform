import { requireAuth, requireOrgMembership } from '@/lib/auth/session'
import { createClient } from '@/lib/supabase/server'
import { EmptyState } from '@/components/ui/EmptyState'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { Map, Plus, ArrowRight, Layers } from 'lucide-react'
import Link from 'next/link'

interface PageProps {
  params: { orgSlug: string }
}

export default async function JourneysPage({ params }: PageProps) {
  const profile = await requireAuth()
  const { org } = await requireOrgMembership(profile.id, params.orgSlug)

  const supabase = await createClient()
  const { data: journeys } = await supabase
    .from('journeys')
    .select('*, stages:journey_stages(id)')
    .eq('org_id', org.id)
    .order('created_at', { ascending: false })

  const journeyList = journeys ?? []

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-gray-900">Customer Journeys</h1>
          <p className="text-sm text-gray-400 mt-0.5">Map and analyze your customer experience journeys</p>
        </div>
        <button className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#4a6de5] text-white text-sm font-semibold hover:bg-[#3a5dd5] transition-colors">
          <Plus className="w-4 h-4" /> New Journey
        </button>
      </div>

      {journeyList.length === 0 ? (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm">
          <EmptyState
            icon={Map}
            title="No journeys mapped yet"
            description="Create your first customer journey to start identifying touchpoints and pain points."
            size="lg"
            action={
              <button className="flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-[#4a6de5] text-white text-sm font-semibold hover:bg-[#3a5dd5] transition-colors">
                <Plus className="w-4 h-4" /> Create your first journey
              </button>
            }
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {journeyList.map((journey: {
            id: string
            name: string
            description: string | null
            segment: string | null
            status: string
            stages: { id: string }[]
            created_at: string
          }) => (
            <Link
              key={journey.id}
              href={`/app/${params.orgSlug}/journeys/${journey.id}`}
              className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 hover:border-[#4a6de5]/40 hover:shadow-md transition-all group"
            >
              <div className="flex items-start justify-between mb-4">
                <div className="w-10 h-10 rounded-xl bg-[#4a6de5]/10 flex items-center justify-center shrink-0">
                  <Map className="w-5 h-5 text-[#4a6de5]" />
                </div>
                <StatusBadge status={journey.status} size="sm" />
              </div>
              <h3 className="font-bold text-gray-900 mb-1 group-hover:text-[#4a6de5] transition-colors">
                {journey.name}
              </h3>
              {journey.description && (
                <p className="text-sm text-gray-400 line-clamp-2 mb-4">{journey.description}</p>
              )}
              <div className="flex items-center justify-between text-xs text-gray-400 mt-auto pt-3 border-t border-gray-50">
                <span className="flex items-center gap-1">
                  <Layers className="w-3.5 h-3.5" />
                  {journey.stages?.length ?? 0} stages
                </span>
                {journey.segment && <span className="capitalize">{journey.segment}</span>}
                <ArrowRight className="w-3.5 h-3.5 group-hover:text-[#4a6de5] transition-colors" />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
