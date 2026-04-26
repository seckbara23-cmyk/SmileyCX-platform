import { describe, it, expect } from 'vitest'
import {
  SignInSchema,
  SignUpSchema,
  AdminLoginSchema,
  EnrollSchema,
  UploadUrlSchema,
  CourseCreateSchema,
  ForgotPasswordSchema,
} from '@/lib/validation/schemas'

describe('SignInSchema', () => {
  it('accepts valid credentials', () => {
    const result = SignInSchema.safeParse({ email: 'user@example.com', password: 'password123' })
    expect(result.success).toBe(true)
  })

  it('rejects invalid email', () => {
    const result = SignInSchema.safeParse({ email: 'not-an-email', password: 'password123' })
    expect(result.success).toBe(false)
  })

  it('rejects short password', () => {
    const result = SignInSchema.safeParse({ email: 'user@example.com', password: 'short' })
    expect(result.success).toBe(false)
  })

  it('normalises email to lowercase', () => {
    const result = SignInSchema.safeParse({ email: 'USER@EXAMPLE.COM', password: 'password123' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.email).toBe('user@example.com')
  })
})

describe('SignUpSchema', () => {
  it('accepts valid registration data', () => {
    const result = SignUpSchema.safeParse({
      email:     'new@example.com',
      password:  'strongpass1',
      full_name: 'Test User',
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty full_name', () => {
    const result = SignUpSchema.safeParse({
      email:     'new@example.com',
      password:  'strongpass1',
      full_name: 'X', // too short (min 2)
    })
    expect(result.success).toBe(false)
  })
})

describe('AdminLoginSchema', () => {
  it('accepts valid admin credentials', () => {
    const result = AdminLoginSchema.safeParse({ username: 'Admin', password: 'adminpass' })
    expect(result.success).toBe(true)
  })

  it('rejects empty username', () => {
    const result = AdminLoginSchema.safeParse({ username: '', password: 'adminpass' })
    expect(result.success).toBe(false)
  })

  it('rejects empty password', () => {
    const result = AdminLoginSchema.safeParse({ username: 'Admin', password: '' })
    expect(result.success).toBe(false)
  })
})

describe('EnrollSchema', () => {
  it('accepts a valid UUID', () => {
    const result = EnrollSchema.safeParse({ courseId: '550e8400-e29b-41d4-a716-446655440000' })
    expect(result.success).toBe(true)
  })

  it('rejects a non-UUID string', () => {
    const result = EnrollSchema.safeParse({ courseId: 'not-a-uuid' })
    expect(result.success).toBe(false)
  })

  it('rejects an empty string', () => {
    const result = EnrollSchema.safeParse({ courseId: '' })
    expect(result.success).toBe(false)
  })
})

describe('UploadUrlSchema', () => {
  it('accepts valid upload request', () => {
    const result = UploadUrlSchema.safeParse({
      filename:    'course-thumbnail.jpg',
      contentType: 'image/jpeg',
      folder:      'cover',
    })
    expect(result.success).toBe(true)
  })

  it('rejects invalid folder enum', () => {
    const result = UploadUrlSchema.safeParse({
      filename:    'file.exe',
      contentType: 'application/octet-stream',
      folder:      'malicious',
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty filename', () => {
    const result = UploadUrlSchema.safeParse({ filename: '', contentType: 'image/jpeg', folder: 'cover' })
    expect(result.success).toBe(false)
  })
})

describe('CourseCreateSchema', () => {
  const valid = {
    title:          'Introduction to CX',
    slug:           'intro-to-cx',
    description:    'A 10-character+ description here.',
    price:          0,
    currency:       'xof',
    level:          'beginner' as const,
    duration_hours: 4,
    is_published:   false,
    is_free:        true,
    cover_url:      null,
  }

  it('accepts valid course data', () => {
    expect(CourseCreateSchema.safeParse(valid).success).toBe(true)
  })

  it('rejects slug with uppercase letters', () => {
    const result = CourseCreateSchema.safeParse({ ...valid, slug: 'Intro-To-CX' })
    expect(result.success).toBe(false)
  })

  it('rejects slug with spaces', () => {
    const result = CourseCreateSchema.safeParse({ ...valid, slug: 'intro to cx' })
    expect(result.success).toBe(false)
  })

  it('rejects negative price', () => {
    const result = CourseCreateSchema.safeParse({ ...valid, price: -1 })
    expect(result.success).toBe(false)
  })

  it('rejects unknown level', () => {
    const result = CourseCreateSchema.safeParse({ ...valid, level: 'expert' })
    expect(result.success).toBe(false)
  })
})

describe('ForgotPasswordSchema', () => {
  it('accepts valid email', () => {
    expect(ForgotPasswordSchema.safeParse({ email: 'reset@example.com' }).success).toBe(true)
  })

  it('rejects invalid email', () => {
    expect(ForgotPasswordSchema.safeParse({ email: 'notvalid' }).success).toBe(false)
  })
})
