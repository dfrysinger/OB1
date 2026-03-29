// lib/credentials.ts
//
// Shared credential lookup. Checks environment variables first (set by
// launchd-wrapper.sh from cached creds), falls back to 1Password op CLI
// for interactive/manual runs. The op CLI cannot run under macOS launchd
// due to TCC restrictions — it hangs forever.

const ENV_MAP: Record<string, string> = {
  "Open Brain - Supabase|project_url": "SUPABASE_URL",
  "Open Brain - Supabase|service_role_key": "SUPABASE_SERVICE_ROLE_KEY",
  "Open Brain - Slack|credential": "SLACK_BOT_TOKEN",
  "Open Brain - Slack|channel": "SLACK_CHANNEL",
  "Daniel Gmail SMTP|email": "GMAIL_EMAIL",
  "Daniel Gmail SMTP|app_password": "GMAIL_APP_PASSWORD",
};

export async function readCredential(item: string, field: string): Promise<string> {
  const envKey = ENV_MAP[`${item}|${field}`];
  if (envKey) {
    const envVal = Deno.env.get(envKey);
    if (envVal) return envVal;
  }

  const proc = new Deno.Command("bash", {
    args: [
      "-c",
      `OP_SERVICE_ACCOUNT_TOKEN=$(textutil -convert txt -stdout ~/1password\\ service.rtf) op item get "${item}" --vault ClawdBot --fields label=${field} --reveal`,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await proc.output();
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr).trim();
    throw new Error(
      `1Password lookup failed for ${item}/${field}: ${stderr || "unknown error"}`
    );
  }
  const value = new TextDecoder().decode(output.stdout).trim();
  if (!value) {
    throw new Error(`1Password returned empty value for ${item}/${field}`);
  }
  return value;
}
