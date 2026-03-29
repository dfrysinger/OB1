// lib/slack.ts
//
// Reads credentials once per process (cached for the process lifetime).

import { readCredential } from "./credentials.ts";

let _token: string | null = null;
let _channel: string | null = null;

async function getToken(): Promise<string> {
  if (!_token) _token = await readCredential("Open Brain - Slack", "credential");
  if (!_token) throw new Error("Failed to read Slack bot token from 1Password");
  return _token;
}

export async function getCaptureChannel(): Promise<string> {
  if (!_channel) _channel = await readCredential("Open Brain - Slack", "channel");
  if (!_channel) throw new Error("Failed to read Slack channel from 1Password");
  return _channel;
}

/** Send a message to a Slack channel. */
export async function sendSlackMessage(channel: string, text: string): Promise<void> {
  const token = await getToken();
  const resp = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ channel, text }),
  });
  if (!resp.ok) throw new Error(`Slack HTTP error: ${resp.status}`);
  const body = await resp.json();
  if (!body.ok) throw new Error(`Slack API error: ${body.error}`);
}
