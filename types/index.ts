// ── User & Auth ──────────────────────────────────────────────────────────────

// Legacy role kept for UI labels only (e.g. signup form "type de compte").
// NOT stored in the profiles table — the DB uses platform_role.
export type UserRole = 'learner' | 'company_admin'

export interface Profile {
  id: string
  email: string
  full_name: string | null
  avatar_url: string | null
  /** DB column: profiles.platform_role */
  platform_role: 'user' | 'super_admin' | 'consultant'
  created_at: string
  updated_at: string
}

// ── Company ──────────────────────────────────────────────────────────────────

export interface Company {
  id: string
  name: string
  email: string
  phone: string | null
  address: string | null
  subscription_status: 'inactive' | 'active' | 'trial'
  created_at: string
}

// ── Course Catalog ────────────────────────────────────────────────────────────

export type CourseLevel = 'beginner' | 'intermediate' | 'advanced'

export interface Course {
  id: string
  slug: string
  title: string
  title_fr: string | null
  description: string
  description_fr: string | null
  cover_url: string | null
  price: number
  currency: string
  is_published: boolean
  is_free: boolean
  level: CourseLevel
  duration_hours: number | null
  language: string
  created_at: string
  updated_at: string
  // Computed / joined
  modules?: Module[]
  enrollment_count?: number
}

export interface Module {
  id: string
  course_id: string
  slug: string
  title: string
  title_fr: string | null
  description: string | null
  order_index: number
  created_at: string
  // Computed
  lessons?: Lesson[]
  lesson_count?: number
}

export interface Lesson {
  id: string
  module_id: string
  slug: string
  title: string
  title_fr: string | null
  content: string | null
  duration_minutes: number | null
  order_index: number
  is_preview: boolean
  created_at: string

  // ── Media, browser-safe (XPA-8 WC-2 / migration 054) ──────────────────────
  //
  // What a browser is allowed to know: WHAT KIND of asset a lesson has, never
  // where a protected one is stored.
  //
  //   *_source        'protected' → request /api/media/lesson/<id>/<kind>,
  //                                 which re-checks the entitlement and signs
  //                   'external'   → use *_external_url
  //                   null         → no asset
  //   *_external_url  the URL, and only for 'external'. The database refuses
  //                   to put an internal Storage location here.
  //
  // Derived by the database from the raw columns below, on every write.
  video_source?: 'protected' | 'external' | null
  video_external_url?: string | null
  pdf_source?: 'protected' | 'external' | null
  pdf_external_url?: string | null
  subtitle_source?: 'protected' | 'external' | null
  subtitle_external_url?: string | null

  // ── Media locations — TRUSTED SERVER / ADMIN ONLY (XPA-8 W3 / F-2) ────────
  //
  //   *_url          an absolute URL to something we do NOT host — a YouTube
  //                  embed, a partner CDN.
  //   *_object_path  an object in the PRIVATE `course-content` bucket. There is
  //                  no durable URL for it: delivery is minted per request by
  //                  /api/media/lesson/... behind an entitlement check.
  //
  // A path wins over a URL. These stay on the server: uploading, replacing,
  // signing and administrative editing all need them, and they reach those
  // paths through the service-role client. Migration 055 withdraws SELECT on
  // all six from `anon` and `authenticated`, so no browser query may name them.
  video_url?: string | null
  video_object_path?: string | null
  pdf_url?: string | null
  pdf_object_path?: string | null
  subtitle_url?: string | null
  subtitle_object_path?: string | null
}

// ── Quiz ──────────────────────────────────────────────────────────────────────

export interface Quiz {
  id: string
  lesson_id: string | null
  module_id: string | null
  title: string
  created_at: string
  questions?: QuizQuestion[]
}

export interface QuizQuestion {
  id: string
  quiz_id: string
  question: string
  options: string[]
  correct_answer: number
  explanation: string | null
  order_index: number
}

export interface QuizAttempt {
  id: string
  user_id: string
  quiz_id: string
  answers: Record<string, number>
  score: number
  max_score: number
  passed: boolean
  created_at: string
}

// ── Enrollment ────────────────────────────────────────────────────────────────

export type EnrollmentStatus = 'active' | 'expired' | 'suspended'

export interface Enrollment {
  id: string
  user_id: string
  course_id: string
  payment_id: string | null
  enrolled_at: string
  expires_at: string | null
  status: EnrollmentStatus
  // Joined
  course?: Course
  progress?: LearnerProgress
}

// ── Payment ───────────────────────────────────────────────────────────────────

/**
 * The payment instrument. Deliberately NOT the aggregator: 'paydunya' is a
 * value of `Payment.provider`, never of `method`. The database CHECK on
 * public.payments.method admits exactly these three.
 */
export type PaymentMethod = 'orange_money' | 'wave' | 'card'

/**
 * The seven states migration 060 installed as `payments_status_valid`.
 *
 * 'cancelled' is the provider's (its confirm endpoint returns
 * pending/completed/cancelled/failed); 'expired' is ours, for an abandoned
 * intent no notification will ever resolve. Both are TERMINAL and therefore
 * outside 058's in-flight predicate, which is what makes a retry possible
 * without weakening the one-live-intent rule.
 *
 * This union previously listed only five, so the two terminal states the
 * database already accepts were unrepresentable in TypeScript.
 */
export type PaymentStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'refunded'
  | 'cancelled'
  | 'expired'

/** The provider environment a transaction was taken in. 058 admits only these. */
export type PaymentProviderMode = 'test' | 'live'

/**
 * A row of public.payments, as it stands after migrations 058 and 060.
 *
 * All nine columns added by those migrations are nullable in the database and
 * are typed `| null` here accordingly — every pre-existing field keeps exactly
 * the contract it had, so this widens the type without weakening it.
 *
 * Declaring a field is not the same as reading one. Nothing in the application
 * reads the provider or reconciliation columns yet; the completion authority
 * (migration 062) is the only thing that writes them, and the trusted caller
 * that will record forensics does not exist. The guards in
 * pay-2b-payment-completion-contract.test.ts enforce that distinction.
 */
export interface Payment {
  id: string
  user_id: string
  course_id: string
  amount: number
  currency: string
  method: PaymentMethod
  status: PaymentStatus
  reference: string
  provider_reference: string | null
  metadata: Record<string, unknown> | null
  created_at: string
  completed_at: string | null
  /** 058. Which provider handled this transaction, e.g. 'paydunya'. */
  provider: string | null
  /** 058. NULL only when `provider` is also NULL (payments_provider_mode_required). */
  provider_mode: PaymentProviderMode | null
  /** 058. The provider's own identifier for the transaction. Server data, never shown to a learner. */
  provider_token: string | null
  /** 058. The entitlement this payment produced, once one exists. */
  entitlement_id: string | null
  /** 060. Why a completion was refused. Written by the trusted caller, not by migration 062. */
  failure_reason: string | null
  /** 060. When the most recent provider notification arrived. */
  last_ipn_at: string | null
}

// Orange Money payload
export interface OrangeMoneyPayload {
  phone_number: string
  amount: number
  reference: string
}

// Wave payload
export interface WavePayload {
  phone_number: string
  amount: number
  reference: string
}

// Card payload
export interface CardPayload {
  card_number: string
  expiry: string
  cvv: string
  cardholder_name: string
}

// ── Progress ──────────────────────────────────────────────────────────────────

export interface LessonProgress {
  id: string
  user_id: string
  lesson_id: string
  is_completed: boolean
  watched_seconds: number
  completed_at: string | null
  created_at: string
}

export interface LearnerProgress {
  total_lessons: number
  completed_lessons: number
  percentage: number
  last_lesson_id: string | null
  last_module_id: string | null
}

// ── Certificate ───────────────────────────────────────────────────────────────

export interface Certificate {
  id: string
  user_id: string
  course_id: string
  issued_at: string
  certificate_number: string
  // Joined
  course?: Course
  profile?: Profile
}

// ── Checkout ──────────────────────────────────────────────────────────────────

export interface CheckoutSession {
  course: Course
  user: Profile
  selected_method: PaymentMethod | null
  amount: number
  currency: string
}

// ── API Responses ─────────────────────────────────────────────────────────────

export interface ApiResponse<T = unknown> {
  data: T | null
  error: string | null
  success: boolean
}
