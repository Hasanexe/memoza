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

export async function sendActivation(
  env: { RESEND_API_KEY: string; RESEND_FROM: string; FRONTEND_ORIGIN: string },
  email: string,
  name: string,
  token: string
): Promise<void> {
  const link = `${env.FRONTEND_ORIGIN}/#/activate?token=${encodeURIComponent(token)}`;
  await sendEmail(
    env,
    email,
    'Activate your Memoza account',
    `<p>Hi ${name}, activate your account: <a href="${link}">${link}</a></p><p>This link expires soon and can only be used once.</p>`
  );
}

export async function sendAlreadyRegistered(
  env: { RESEND_API_KEY: string; RESEND_FROM: string; FRONTEND_ORIGIN: string },
  email: string
): Promise<void> {
  const link = `${env.FRONTEND_ORIGIN}/#/reset`;
  await sendEmail(
    env,
    email,
    'You already have a Memoza account',
    `<p>You already have an account with this email. <a href="${link}">Forgot your password?</a></p>`
  );
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
