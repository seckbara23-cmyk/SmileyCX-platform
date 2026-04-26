import { createClient } from '@/lib/supabase/server'
import type { Organization, OrganizationMembership } from '@/types/cx'

export async function getOrgBySlug(slug: string): Promise<Organization | null> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('organizations')
    .select('*')
    .eq('slug', slug)
    .single()
  return data as Organization | null
}

export async function getOrgMembers(orgId: string): Promise<OrganizationMembership[]> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('organization_memberships')
    .select('*, profile:profiles(id, email, full_name, avatar_url)')
    .eq('org_id', orgId)
    .order('created_at', { ascending: true })
  return (data ?? []) as OrganizationMembership[]
}

export async function createOrganization(
  name: string,
  slug: string,
  userId: string
): Promise<Organization | null> {
  const supabase = await createClient()

  const { data: org, error } = await supabase
    .from('organizations')
    .insert({ name, slug })
    .select()
    .single()

  if (error || !org) return null

  // Add creator as org_admin
  await supabase.from('organization_memberships').insert({
    org_id: org.id,
    user_id: userId,
    role: 'org_admin',
  })

  return org as Organization
}

export async function generateOrgSlug(name: string): Promise<string> {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 48)

  const supabase = await createClient()
  const { data } = await supabase
    .from('organizations')
    .select('slug')
    .like('slug', `${base}%`)

  const existing = new Set((data ?? []).map((r: { slug: string }) => r.slug))
  if (!existing.has(base)) return base

  let i = 2
  while (existing.has(`${base}-${i}`)) i++
  return `${base}-${i}`
}
