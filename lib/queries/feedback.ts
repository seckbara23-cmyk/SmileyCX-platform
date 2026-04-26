import { createClient } from '@/lib/supabase/server'
import type { FeedbackEntry, FilterParams } from '@/types/cx'

export async function getFeedbackEntries(
  orgId: string,
  filters: FilterParams = {},
  page = 1,
  perPage = 25
): Promise<{ data: FeedbackEntry[]; count: number }> {
  const supabase = await createClient()

  let query = supabase
    .from('feedback_entries')
    .select('*, source:feedback_sources(id,name,type), tags:feedback_entry_tags(tag:feedback_tags(*))', { count: 'exact' })
    .eq('org_id', orgId)
    .order('collected_at', { ascending: false })

  if (filters.status)  query = query.eq('status', filters.status)
  if (filters.channel) query = query.eq('channel', filters.channel)
  if (filters.dateFrom) query = query.gte('collected_at', filters.dateFrom)
  if (filters.dateTo)   query = query.lte('collected_at', filters.dateTo)
  if (filters.search)  query = query.ilike('content', `%${filters.search}%`)

  const from = (page - 1) * perPage
  query = query.range(from, from + perPage - 1)

  const { data, count } = await query
  return { data: (data ?? []) as FeedbackEntry[], count: count ?? 0 }
}

export async function getFeedbackById(id: string): Promise<FeedbackEntry | null> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('feedback_entries')
    .select('*, source:feedback_sources(*), touchpoint:touchpoints(*), tags:feedback_entry_tags(tag:feedback_tags(*))')
    .eq('id', id)
    .single()
  return data as FeedbackEntry | null
}

export async function getDashboardFeedbackStats(orgId: string) {
  const supabase = await createClient()
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  const [countRes, npsRes, csatRes, recentRes] = await Promise.all([
    // Total feedback last 30 days
    supabase
      .from('feedback_entries')
      .select('*', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .gte('collected_at', thirtyDaysAgo),

    // NPS scores last 30 days
    supabase
      .from('feedback_entries')
      .select('score')
      .eq('org_id', orgId)
      .eq('score_type', 'nps')
      .not('score', 'is', null)
      .gte('collected_at', thirtyDaysAgo),

    // CSAT scores last 30 days
    supabase
      .from('feedback_entries')
      .select('score')
      .eq('org_id', orgId)
      .eq('score_type', 'csat')
      .not('score', 'is', null)
      .gte('collected_at', thirtyDaysAgo),

    // Recent feedback
    supabase
      .from('feedback_entries')
      .select('*')
      .eq('org_id', orgId)
      .order('collected_at', { ascending: false })
      .limit(5),
  ])

  const npsScores = (npsRes.data ?? []).map((r: { score: number }) => r.score)
  const promoters = npsScores.filter((s: number) => s >= 9).length
  const detractors = npsScores.filter((s: number) => s <= 6).length
  const nps = npsScores.length > 0 ? Math.round(((promoters - detractors) / npsScores.length) * 100) : null

  const csatScores = (csatRes.data ?? []).map((r: { score: number }) => r.score)
  const csat = csatScores.length > 0 ? Math.round((csatScores.reduce((a: number, b: number) => a + b, 0) / csatScores.length) * 10) / 10 : null

  return {
    feedback_count: countRes.count ?? 0,
    nps,
    csat,
    recent_feedback: (recentRes.data ?? []) as FeedbackEntry[],
  }
}
