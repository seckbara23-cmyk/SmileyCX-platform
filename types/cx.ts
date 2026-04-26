// ─────────────────────────────────────────────────────────────────────────────
// SmileyCX — Core CX SaaS Type Definitions
// ─────────────────────────────────────────────────────────────────────────────

// ── Platform roles (global, not org-specific) ────────────────────────────────
export type PlatformRole = 'user' | 'super_admin' | 'consultant'

// ── Organization roles ────────────────────────────────────────────────────────
export type OrgRole = 'org_admin' | 'cx_manager' | 'team_manager' | 'analyst' | 'viewer'

// ── Profile ───────────────────────────────────────────────────────────────────
export interface Profile {
  id: string
  email: string
  full_name: string | null
  avatar_url: string | null
  platform_role: PlatformRole
  created_at: string
  updated_at: string
}

// ── Organization ──────────────────────────────────────────────────────────────
export type OrgPlan = 'trial' | 'starter' | 'growth' | 'enterprise'
export type OrgPlanStatus = 'active' | 'suspended' | 'cancelled'

export interface Organization {
  id: string
  name: string
  slug: string
  logo_url: string | null
  industry: string | null
  country: string | null
  plan: OrgPlan
  plan_status: OrgPlanStatus
  created_at: string
  updated_at: string
}

// ── Organization Membership ───────────────────────────────────────────────────
export interface OrganizationMembership {
  id: string
  org_id: string
  user_id: string
  role: OrgRole
  invited_by: string | null
  joined_at: string
  created_at: string
  // joined relations
  organization?: Organization
  profile?: Profile
}

// ── Feedback Source ───────────────────────────────────────────────────────────
export type FeedbackSourceType = 'survey' | 'nps' | 'csat' | 'ces' | 'review' | 'social' | 'support' | 'manual'

export interface FeedbackSource {
  id: string
  org_id: string
  name: string
  type: FeedbackSourceType
  config: Record<string, unknown>
  is_active: boolean
  created_at: string
}

// ── Feedback Entry ────────────────────────────────────────────────────────────
export type ScoreType = 'nps' | 'csat' | 'ces' | 'rating' | null
export type FeedbackChannel = 'email' | 'web' | 'mobile' | 'phone' | 'in-store' | 'social' | 'app' | 'other'
export type FeedbackSentiment = 'positive' | 'neutral' | 'negative'
export type FeedbackStatus = 'unreviewed' | 'reviewed' | 'actioned' | 'archived'

export interface FeedbackEntry {
  id: string
  org_id: string
  source_id: string | null
  touchpoint_id: string | null
  journey_stage_id: string | null
  score_type: ScoreType
  score: number | null
  content: string | null
  respondent_segment: string | null
  channel: FeedbackChannel
  sentiment: FeedbackSentiment | null
  status: FeedbackStatus
  collected_at: string
  created_at: string
  metadata: Record<string, unknown>
  // joined relations
  source?: FeedbackSource
  touchpoint?: Touchpoint
  tags?: FeedbackTag[]
}

// ── Feedback Tag ──────────────────────────────────────────────────────────────
export interface FeedbackTag {
  id: string
  org_id: string
  name: string
  color: string
  created_at: string
}

// ── Journey ───────────────────────────────────────────────────────────────────
export type JourneyStatus = 'active' | 'draft' | 'archived'

export interface Journey {
  id: string
  org_id: string
  name: string
  description: string | null
  segment: string | null
  status: JourneyStatus
  created_by: string
  created_at: string
  updated_at: string
  // joined relations
  stages?: JourneyStage[]
}

// ── Journey Stage ─────────────────────────────────────────────────────────────
export interface JourneyStage {
  id: string
  journey_id: string
  name: string
  description: string | null
  order_index: number
  created_at: string
  // joined relations
  touchpoints?: Touchpoint[]
}

// ── Touchpoint ────────────────────────────────────────────────────────────────
export type TouchpointChannel = 'email' | 'web' | 'phone' | 'in-store' | 'social' | 'app' | 'other'

export interface Touchpoint {
  id: string
  org_id: string
  stage_id: string | null
  journey_id: string | null
  name: string
  description: string | null
  channel: TouchpointChannel
  owner: string | null
  avg_score: number | null
  feedback_count: number
  status: 'active' | 'inactive'
  created_at: string
  updated_at: string
  // joined relations
  stage?: JourneyStage
}

// ── KPI ───────────────────────────────────────────────────────────────────────
export type MetricType = 'nps' | 'csat' | 'ces' | 'custom'

export interface KpiDefinition {
  id: string
  org_id: string
  name: string
  metric_type: MetricType
  target_value: number | null
  created_at: string
}

export interface KpiSnapshot {
  id: string
  org_id: string
  kpi_id: string
  period_start: string
  period_end: string
  value: number
  sample_size: number
  created_at: string
  kpi?: KpiDefinition
}

// ── Issue ─────────────────────────────────────────────────────────────────────
export type IssuePriority = 'critical' | 'high' | 'medium' | 'low'
export type IssueStatus = 'open' | 'in_progress' | 'resolved' | 'closed'

export interface Issue {
  id: string
  org_id: string
  title: string
  description: string | null
  touchpoint_id: string | null
  journey_stage_id: string | null
  priority: IssuePriority
  status: IssueStatus
  created_by: string
  assigned_to: string | null
  created_at: string
  updated_at: string
  // joined relations
  touchpoint?: Touchpoint
  assignee?: Profile
  action_plans?: ActionPlan[]
}

// ── Action Plan ───────────────────────────────────────────────────────────────
export type ActionStatus = 'planned' | 'in_progress' | 'completed' | 'cancelled'

export interface ActionPlan {
  id: string
  org_id: string
  issue_id: string | null
  title: string
  description: string | null
  owner_id: string
  status: ActionStatus
  priority: IssuePriority
  due_date: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
  // joined relations
  owner?: Profile
  issue?: Issue
  updates?: ActionUpdate[]
}

// ── Action Update ─────────────────────────────────────────────────────────────
export interface ActionUpdate {
  id: string
  action_plan_id: string
  author_id: string
  content: string
  status_change: ActionStatus | null
  created_at: string
  author?: Profile
}

// ── Dashboard summary types ───────────────────────────────────────────────────
export interface DashboardStats {
  nps: number | null
  csat: number | null
  ces: number | null
  feedback_count: number
  open_issues: number
  overdue_actions: number
  top_pain_points: Array<{ name: string; count: number }>
  worst_touchpoints: Array<{ name: string; avg_score: number; count: number }>
  recent_feedback: FeedbackEntry[]
}

// ── Context types used throughout app ────────────────────────────────────────
export interface OrgContext {
  org: Organization
  membership: OrganizationMembership
  role: OrgRole
}

// ── Permission helpers ────────────────────────────────────────────────────────
export const ORG_ROLE_RANKS: Record<OrgRole, number> = {
  org_admin:    5,
  cx_manager:   4,
  team_manager: 3,
  analyst:      2,
  viewer:       1,
}

export function hasOrgPermission(userRole: OrgRole, requiredRole: OrgRole): boolean {
  return ORG_ROLE_RANKS[userRole] >= ORG_ROLE_RANKS[requiredRole]
}

export function canManageOrg(role: OrgRole): boolean {
  return hasOrgPermission(role, 'org_admin')
}

export function canManageCX(role: OrgRole): boolean {
  return hasOrgPermission(role, 'cx_manager')
}

export function canEdit(role: OrgRole): boolean {
  return hasOrgPermission(role, 'team_manager')
}

export function canAnalyze(role: OrgRole): boolean {
  return hasOrgPermission(role, 'analyst')
}

// ── Utility types ─────────────────────────────────────────────────────────────
export type ApiResponse<T> = { data: T; error: null } | { data: null; error: string }

export type SortDirection = 'asc' | 'desc'

export interface PaginationParams {
  page: number
  perPage: number
}

export interface FilterParams {
  search?: string
  status?: string
  priority?: string
  channel?: string
  dateFrom?: string
  dateTo?: string
}
