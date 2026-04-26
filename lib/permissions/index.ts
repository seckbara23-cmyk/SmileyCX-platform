import type { OrgRole, PlatformRole } from '@/types/cx'
import { ORG_ROLE_RANKS } from '@/types/cx'

// ── Server-side permission checks (pass role from DB) ────────────────────────

export function checkOrgPermission(userRole: OrgRole, required: OrgRole): boolean {
  return ORG_ROLE_RANKS[userRole] >= ORG_ROLE_RANKS[required]
}

export function isPlatformAdmin(platformRole: PlatformRole): boolean {
  return platformRole === 'super_admin' || platformRole === 'consultant'
}

// ── Route-level guards ────────────────────────────────────────────────────────

export function canViewDashboard(role: OrgRole): boolean {
  return checkOrgPermission(role, 'viewer')
}

export function canManageFeedback(role: OrgRole): boolean {
  return checkOrgPermission(role, 'analyst')
}

export function canManageJourneys(role: OrgRole): boolean {
  return checkOrgPermission(role, 'cx_manager')
}

export function canManageActions(role: OrgRole): boolean {
  return checkOrgPermission(role, 'analyst')
}

export function canManageMembers(role: OrgRole): boolean {
  return checkOrgPermission(role, 'org_admin')
}

export function canManageOrg(role: OrgRole): boolean {
  return checkOrgPermission(role, 'org_admin')
}

// ── Role display helpers ──────────────────────────────────────────────────────

export const ORG_ROLE_LABELS: Record<OrgRole, string> = {
  org_admin:    'Admin',
  cx_manager:   'CX Manager',
  team_manager: 'Team Manager',
  analyst:      'Analyst',
  viewer:       'Viewer',
}

export const PLATFORM_ROLE_LABELS: Record<PlatformRole, string> = {
  user:          'User',
  super_admin:   'Super Admin',
  consultant:    'Consultant',
}
