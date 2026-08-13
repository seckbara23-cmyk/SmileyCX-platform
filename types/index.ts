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

  // ── Media (XPA-8 W3 / F-2) ────────────────────────────────────────────────
  //
  // Two columns per asset, meaning two different things:
  //
  //   *_url          an absolute URL to something we do NOT host — a YouTube
  //                  embed, a partner CDN. Handed to the player untouched.
  //   *_object_path  an object in the PRIVATE `course-content` bucket. There is
  //                  no durable URL for it: delivery is minted per request by
  //                  /api/media/lesson/... behind an entitlement check.
  //
  // A path wins over a URL. Both are null until migration 042 backfills them,
  // which is what lets the application ship before the objects have moved.
  video_url: string | null
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

export type PaymentMethod = 'orange_money' | 'wave' | 'card'
export type PaymentStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'refunded'

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
