export interface EnrollmentEmailData {
  fullName:    string
  courseTitle: string
  courseUrl:   string
}

export function enrollmentEmailHtml({ fullName, courseTitle, courseUrl }: EnrollmentEmailData): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Inscription confirmée — ${escHtml(courseTitle)}</title>
  <style>
    body { margin: 0; padding: 0; background: #f4f6fb; font-family: Inter, Arial, sans-serif; color: #1e2235; }
    .wrapper { max-width: 600px; margin: 40px auto; background: #ffffff; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 12px rgba(0,0,0,.08); }
    .header { background: #4a6de5; padding: 32px 40px; text-align: center; }
    .header h1 { color: #ffffff; margin: 0; font-size: 28px; letter-spacing: -0.5px; }
    .header p { color: rgba(255,255,255,.75); margin: 8px 0 0; font-size: 14px; }
    .body { padding: 40px; }
    .body h2 { font-size: 20px; margin: 0 0 12px; }
    .body p { font-size: 15px; line-height: 1.65; color: #444; margin: 0 0 16px; }
    .course-box { background: #f4f6fb; border-left: 4px solid #4a6de5; padding: 16px 20px; border-radius: 6px; margin: 24px 0; }
    .course-box p { margin: 0; font-weight: 600; font-size: 16px; color: #1e2235; }
    .btn { display: inline-block; background: #ff7b54; color: #ffffff !important; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-weight: 600; font-size: 15px; margin: 8px 0; }
    .footer { padding: 24px 40px; text-align: center; font-size: 12px; color: #aaa; border-top: 1px solid #eee; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <h1>XP Client</h1>
      <p>La plateforme de formation en expérience client</p>
    </div>
    <div class="body">
      <h2>Inscription confirmée !</h2>
      <p>Bonjour ${escHtml(fullName)},</p>
      <p>Votre inscription à la formation suivante est bien confirmée :</p>
      <div class="course-box">
        <p>${escHtml(courseTitle)}</p>
      </div>
      <p>Vous pouvez commencer dès maintenant. Bonne formation !</p>
      <p style="text-align:center">
        <a class="btn" href="${escHtml(courseUrl)}">Commencer la formation</a>
      </p>
    </div>
    <div class="footer">
      © ${new Date().getFullYear()} XP Client. Tous droits réservés.
    </div>
  </div>
</body>
</html>`
}

export function enrollmentEmailText({ fullName, courseTitle, courseUrl }: EnrollmentEmailData): string {
  return `Inscription confirmée !

Bonjour ${fullName},

Votre inscription à "${courseTitle}" est confirmée. Commencez dès maintenant :
${courseUrl}

© ${new Date().getFullYear()} XP Client`
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
