'use server'

import { createClient } from '@/lib/supabase/server'
import { PILOT_MODE } from '@/lib/pilot'

export interface FeedbackPayload {
  courseId:              string
  clarityRating:         number
  practicalValueRating:  number
  easeOfUseRating:       number
  mostUseful?:           string
  confusingPart?:        string
  wouldRecommend?:       boolean
  fairPrice?:            string
  comment?:              string
}

export async function submitFeedback(
  payload: FeedbackPayload
): Promise<{ error?: string }> {
  const supabase = await createClient()

  let userId: string | null = null
  if (!PILOT_MODE) {
    const { data: { user } } = await supabase.auth.getUser()
    userId = user?.id ?? null
  }

  const { error } = await supabase.from('pilot_feedback').insert({
    user_id:                userId,
    course_id:              payload.courseId,
    clarity_rating:         payload.clarityRating,
    practical_value_rating: payload.practicalValueRating,
    ease_of_use_rating:     payload.easeOfUseRating,
    most_useful:            payload.mostUseful   || null,
    confusing_part:         payload.confusingPart || null,
    would_recommend:        payload.wouldRecommend ?? null,
    fair_price:             payload.fairPrice    || null,
    comment:                payload.comment      || null,
  })

  if (error) {
    console.error('[feedback]', error.message)
    return { error: 'Erreur lors de l\'envoi. Veuillez réessayer.' }
  }

  return {}
}
