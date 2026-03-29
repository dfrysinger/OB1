// lib/email.ts
//
// Sends email via Gmail SMTP using nodemailer.
// Credentials come from 1Password at runtime.

import nodemailer from "npm:nodemailer@6";
import { readCredential } from "./credentials.ts";

export async function sendEmail(opts: {
  subject: string;
  html: string;
}): Promise<void> {
  const email = await readCredential("Daniel Gmail SMTP", "email");
  const appPassword = await readCredential("Daniel Gmail SMTP", "app_password");

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: email, pass: appPassword },
  });

  await transporter.sendMail({
    from: email,
    to: email,
    subject: opts.subject,
    html: opts.html,
  });
}
