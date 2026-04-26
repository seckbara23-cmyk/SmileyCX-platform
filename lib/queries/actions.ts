import { createClient } from '@/lib/supabase/server'
import type { ActionPlan, Issue } from '@/types/cx'

export async function getActionPlans(
  orgId: string,
  filters: { status?: string; priority?: string } = {}
): Promise<ActionPlan[]> {
  const supabase = await createClient()
  let query = supabase
    .from('action_plans')
    .select('*, owner:profiles(id,full_name,email,avatar_url), issue:issues(id,title,priority,status)')
    .eq('org_id', orgId)
    .order('due_date', { ascending: true, nullsFirst: false })

  if (filters.status)   query = query.eq('status', filters.status)
  if (filters.priority) query = query.eq('priority', filters.priority)

  const { data } = await query
  return (data ?? []) as ActionPlan[]
}

export async function getIssues(
  orgId: string,
  filters: { status?: string; priority?: string } = {}
): Promise<Issue[]> {
  const supabase = await createClient()
  let query = supabase
    .from('issues')
    .select('*, assignee:profiles!assigned_to(id,full_name,email), touchpoint:touchpoints(id,name,channel), action_plans(id,title,status)')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })

  if (filters.status)   query = query.eq('status', filters.status)
  if (filters.priority) query = query.eq('priority', filters.priority)

  const { data } = await query
  return (data ?? []) as Issue[]
}

export async function getOverdueActions(orgId: string): Promise<number> {
  const supabase = await createClient()
  const { count } = await supabase
    .from('action_plans')
    .select('*', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .in('status', ['planned', 'in_progress'])
    .lt('due_date', new Date().toISOString().split('T')[0])
  return count ?? 0
}

export async function getOpenIssuesCount(orgId: string): Promise<number> {
  const supabase = await createClient()
  const { count } = await supabase
    .from('issues')
    .select('*', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .in('status', ['open', 'in_progress'])
  return count ?? 0
}
