import { z } from 'zod'

// ── Shared primitives ─────────────────────────────────────────────────────────

export const UuidSchema = z.string().uuid()

export const EmailSchema = z.string().email().max(254).toLowerCase()

export const PasswordSchema = z
  .string()
  .min(8, 'Le mot de passe doit contenir au moins 8 caractères')
  .max(128)

/**
 * Password rules for NEW learner accounts (XPA-6A).
 *
 * Stricter than PasswordSchema, which stays as-is because it also governs
 * sign-IN, where re-validating an existing password would lock out accounts
 * created under the old rules.
 *
 * Length is weighted over character-class gymnastics deliberately: 12 characters
 * with three of four classes resists offline cracking far better than 8
 * characters with a mandatory punctuation mark, and produces fewer
 * `Password1!`-shaped passwords.
 */
export const NewPasswordSchema = z
  .string()
  .min(12, 'Le mot de passe doit contenir au moins 12 caractères')
  .max(128, 'Le mot de passe ne peut pas dépasser 128 caractères')
  .refine(
    v => {
      const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(re => re.test(v)).length
      return classes >= 3
    },
    'Utilisez au moins trois types de caractères parmi : minuscules, majuscules, chiffres, symboles.',
  )

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

/**
 * Public learner registration (XPA-6A).
 *
 * Collects the minimum that the profile model actually uses. Notably absent,
 * and each absence is a decision: no date of birth, no phone number, no
 * address, no company, no marketing consent bundled into the terms checkbox.
 *
 * Legal acceptance is carried as the accepted VERSION, not a boolean. A boolean
 * proves a checkbox was ticked; a version proves what was agreed to. The server
 * re-checks the submitted version against the current one, so a stale form
 * cannot record acceptance of a document the user never saw.
 */
const NameSchema = z
  .string()
  .trim()
  .min(2, 'Au moins 2 caractères')
  .max(80, 'Au maximum 80 caractères')

export const RegistrationSchema = z
  .object({
    firstName:       NameSchema,
    lastName:        NameSchema,
    email:           EmailSchema,
    password:        NewPasswordSchema,
    confirmPassword: z.string(),
    acceptedTermsVersion:   z.string().min(1).max(64),
    acceptedPrivacyVersion: z.string().min(1).max(64),
    captchaToken:    z.string().max(4096).optional(),
  })
  .refine(v => v.password === v.confirmPassword, {
    message: 'Les mots de passe ne correspondent pas.',
    path:    ['confirmPassword'],
  })
  .refine(v => !v.password.toLowerCase().includes(v.email.split('@')[0].toLowerCase()), {
    message: 'Le mot de passe ne doit pas contenir votre adresse email.',
    path:    ['password'],
  })

export const ResendVerificationSchema = z.object({
  email:        EmailSchema,
  captchaToken: z.string().max(4096).optional(),
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
export type RegistrationInput    = z.infer<typeof RegistrationSchema>
export type ResendVerificationInput = z.infer<typeof ResendVerificationSchema>
export type ForgotPasswordInput  = z.infer<typeof ForgotPasswordSchema>
export type ResetPasswordInput   = z.infer<typeof ResetPasswordSchema>
export type AdminLoginInput      = z.infer<typeof AdminLoginSchema>
export type EnrollInput          = z.infer<typeof EnrollSchema>
export type UploadUrlInput       = z.infer<typeof UploadUrlSchema>
export type CourseCreateInput    = z.infer<typeof CourseCreateSchema>
export type CourseUpdateInput    = z.infer<typeof CourseUpdateSchema>
