export interface WelcomeEmailData {
  fullName:  string
  loginUrl:  string
}

export function welcomeEmailHtml({ fullName, loginUrl }: WelcomeEmailData): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Bienvenue sur XP Client</title>
  <style>
    body { margin: 0; padding: 0; background: #f4f6fb; font-family: Inter, Arial, sans-serif; color: #1e2235; }
    .wrapper { max-width: 600px; margin: 40px auto; background: #ffffff; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 12px rgba(0,0,0,.08); }
    .header { background: #4a6de5; padding: 32px 40px; text-align: center; }
    .header h1 { color: #ffffff; margin: 0; font-size: 28px; letter-spacing: -0.5px; }
    .header p { color: rgba(255,255,255,.75); margin: 8px 0 0; font-size: 14px; }
    .body { padding: 40px; }
    .body h2 { font-size: 20px; margin: 0 0 12px; }
    .body p { font-size: 15px; line-height: 1.65; color: #444; margin: 0 0 16px; }
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
      <h2>Bienvenue, ${escHtml(fullName)} !</h2>
      <p>Nous sommes ravis de vous accueillir sur XP Client. Votre compte est maintenant actif et prêt à l'emploi.</p>
      <p>Découvrez nos formations et commencez votre parcours vers l'excellence en expérience client.</p>
      <p style="text-align:center">
        <a class="btn" href="${escHtml(loginUrl)}">Accéder à la plateforme</a>
      </p>
      <p style="font-size:13px;color:#aaa">Si vous n'avez pas créé ce compte, ignorez cet email.</p>
    </div>
    <div class="footer">
      © ${new Date().getFullYear()} XP Client. Tous droits réservés.
    </div>
  </div>
</body>
</html>`
}

export function welcomeEmailText({ fullName, loginUrl }: WelcomeEmailData): string {
  return `Bienvenue sur XP Client, ${fullName} !

Votre compte est maintenant actif. Accédez à la plateforme ici :
${loginUrl}

Si vous n'avez pas créé ce compte, ignorez cet email.

© ${new Date().getFullYear()} XP Client`
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
