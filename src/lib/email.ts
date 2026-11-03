import { appendFileSync } from "fs";

/**
 * Sends through Brevo. Set BREVO_API_KEY=console to print emails to the server log
 * and append them to OUTBOX_PATH instead (local development and tests only).
 */
async function send(to: string, subject: string, html: string) {
  if (process.env.BREVO_API_KEY === "console") {
    const line = JSON.stringify({ to, subject, html });
    console.log("[email:console]", to, subject);
    appendFileSync(process.env.OUTBOX_PATH ?? ".outbox.jsonl", line + "\n");
    return;
  }
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": process.env.BREVO_API_KEY!, "content-type": "application/json" },
    body: JSON.stringify({
      sender: { name: "ZeroTracker", email: process.env.BREVO_SENDER_EMAIL },
      to: [{ email: to }], subject, htmlContent: html,
    }),
  });
  if (!res.ok) throw new Error(`Brevo error ${res.status}`);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const sendAccessKeyEmail = (to: string, name: string, key: string) =>
  send(to, "Your ZeroTracker access key",
    `<p>Welcome, ${esc(name)}.</p><p>Your access key (shown once, keep it safe):</p>
     <p><code>${key}</code></p><p>Sign in at ${process.env.APP_URL}/login with this email and key.</p>`);

export const sendResetEmail = (to: string, token: string) =>
  send(to, "Reset your ZeroTracker access key",
    `<p>Reset your key (link expires in 30 minutes, single use):</p>
     <p><a href="${process.env.APP_URL}/reset?token=${token}">${process.env.APP_URL}/reset?token=${token}</a></p>`);
