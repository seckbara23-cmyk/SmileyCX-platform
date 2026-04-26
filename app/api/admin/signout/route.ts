import { NextRequest, NextResponse } from 'next/server'

export async function POST(request: NextRequest) {
  const origin = new URL(request.url).origin
  const response = NextResponse.redirect(`${origin}/admin/login`, { status: 303 })
  response.cookies.set('scx_admin', '', {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  })
  return response
}
