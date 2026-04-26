import { z } from 'zod'

// ── Shared primitives ─────────────────────────────────────────────────────────

export const UuidSchema = z.string().uuid()

export const EmailSchema = z.string().email().max(254).toLowerCase()

export const PasswordSchema = z
  .string()
  .min(8, 'Le mot de passe doit contenir au moins 8 caractères')
  .max(128)

// ── Auth ──────────────────────────────────────────────────────────────────────

export const SignInSchema = z.object({
  email:    EmailSchema,
  password: PasswordSchema,
})

export const SignUpSchema = z.object({
  email:     EmailSchema,
  password:  PasswordSchema,
  full_name: z.string().min(2).max(100).trim(),
})

export const ForgotPasswordSchema = z.object({
  email: EmailSchema,
})

export const ResetPasswordSchema = z.object({
  password: PasswordSchema,
})

// ── Admin login ───────────────────────────────────────────────────────────────

export const AdminLoginSchema = z.object({
  username: z.string().min(1).max(100).trim(),
  password: z.string().min(1).max(128),
})

// ── Enrollment ────────────────────────────────────────────────────────────────

export const EnrollSchema = z.object({
  courseId: UuidSchema,
})

// ── File upload ───────────────────────────────────────────────────────────────

export const UploadUrlSchema = z.object({
  filename:    z.string().min(1).max(255),
  contentType: z.string().min(1),
  folder:      z.enum(['cover', 'video', 'pdf']),
})

// ── Course management (admin) ─────────────────────────────────────────────────

export const CourseSlugSchema = z
  .string()
  .min(2)
  .max(100)
  .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens only')

export const CourseCreateSchema = z.object({
  title:          z.string().min(3).max(200).trim(),
  slug:           CourseSlugSchema,
  description:    z.string().min(10).max(5000).trim(),
  price:          z.number().min(0),
  currency:       z.string().length(3).toUpperCase(),
  level:          z.enum(['beginner', 'intermediate', 'advanced']),
  duration_hours: z.number().min(0).max(1000).nullable(),
  is_published:   z.boolean(),
  is_free:        z.boolean(),
  cover_url:      z.string().url().nullable().optional(),
})

export const CourseUpdateSchema = CourseCreateSchema.partial()

// ── Type exports ──────────────────────────────────────────────────────────────

export type SignInInput          = z.infer<typeof SignInSchema>
export type SignUpInput          = z.infer<typeof SignUpSchema>
export type ForgotPasswordInput  = z.infer<typeof ForgotPasswordSchema>
export type ResetPasswordInput   = z.infer<typeof ResetPasswordSchema>
export type AdminLoginInput      = z.infer<typeof AdminLoginSchema>
export type EnrollInput          = z.infer<typeof EnrollSchema>
export type UploadUrlInput       = z.infer<typeof UploadUrlSchema>
export type CourseCreateInput    = z.infer<typeof CourseCreateSchema>
export type CourseUpdateInput    = z.infer<typeof CourseUpdateSchema>
