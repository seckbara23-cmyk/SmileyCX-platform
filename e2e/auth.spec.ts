import { test, expect } from '@playwright/test'

test.describe('Authentication flows', () => {
  test('login page is accessible', async ({ page }) => {
    await page.goto('/login')
    await expect(page).toHaveTitle(/SmileyCX|Login/i)
    await expect(page.locator('input[type="email"]')).toBeVisible()
    await expect(page.locator('input[type="password"]')).toBeVisible()
  })

  test('signup page is accessible', async ({ page }) => {
    await page.goto('/signup')
    await expect(page.locator('input[type="email"]')).toBeVisible()
  })

  test('forgot password page is accessible', async ({ page }) => {
    await page.goto('/forgot-password')
    await expect(page.locator('input[type="email"]')).toBeVisible()
  })

  test('unauthenticated user is redirected from /dashboard to /login', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/login/)
  })

  test('unauthenticated user is redirected from /learn to /login', async ({ page }) => {
    await page.goto('/learn')
    await expect(page).toHaveURL(/\/login/)
  })

  test('admin login page is accessible', async ({ page }) => {
    await page.goto('/admin/login')
    await expect(page.locator('input[name="username"]')).toBeVisible()
    await expect(page.locator('input[type="password"]')).toBeVisible()
  })

  test('unauthenticated user is redirected from /admin to /admin/login', async ({ page }) => {
    await page.goto('/admin')
    await expect(page).toHaveURL(/\/admin\/login/)
  })
})

test.describe('Security headers', () => {
  test('responses include X-Frame-Options header', async ({ page }) => {
    const response = await page.goto('/login')
    expect(response?.headers()['x-frame-options']).toBe('DENY')
  })

  test('responses include X-Content-Type-Options header', async ({ page }) => {
    const response = await page.goto('/login')
    expect(response?.headers()['x-content-type-options']).toBe('nosniff')
  })
})
