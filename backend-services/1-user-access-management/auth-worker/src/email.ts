async function sendEmail(
  env: { RESEND_API_KEY: string; RESEND_FROM: string },
  to: string,
  subject: string,
  html: string
): Promise<void> {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: env.RESEND_FROM, to, subject, html }),
    });
    if (!res.ok) {
      console.error('Resend failed', res.status, await res.text());
    }
  } catch (err) {
    console.error('sendEmail error', err);
  }
}

export async function sendWelcome(
  env: { RESEND_API_KEY: string; RESEND_FROM: string },
  email: string,
  name: string
): Promise<void> {
  await sendEmail(env, email, 'Welcome to Memoza', `<p>Hi ${name}, welcome to Memoza!</p>`);
}

export async function sendPasswordReset(
  env: { RESEND_API_KEY: string; RESEND_FROM: string; FRONTEND_ORIGIN: string },
  email: string,
  token: string
): Promise<void> {
  const link = `${env.FRONTEND_ORIGIN}/#/reset?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`;
  await sendEmail(
    env,
    email,
    'Reset your Memoza password',
    `<p>Reset your password: <a href="${link}">${link}</a></p><p>This link expires soon and can only be used once.</p>`
  );
}
