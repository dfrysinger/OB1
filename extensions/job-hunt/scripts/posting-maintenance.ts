// scripts/posting-maintenance.ts
//
// Maintains job posting data via LinkedIn.
// --mode backfill (default): scrapes posted_date for jobs missing it.
// --mode check-active: re-visits active postings, marks expired ones as closed.
// Pass --dry-run to preview without writing. Pass --limit N to cap batch size.

import { createClient } from "npm:@supabase/supabase-js@2";

const DELAY_MIN_MS = 30000;
const DELAY_MAX_MS = 90000;
const SESSION = "maintenance";

const dryRun = Deno.args.includes("--dry-run");
const limitIdx = Deno.args.indexOf("--limit");
const LIMIT = limitIdx !== -1 ? parseInt(Deno.args[limitIdx + 1], 10) : 3;

async function readOp(item: string, field: string): Promise<string> {
  const proc = new Deno.Command("bash", {
    args: ["-c", `OP_SERVICE_ACCOUNT_TOKEN=$(textutil -convert txt -stdout ~/1password\\ service.rtf) op item get "${item}" --vault ClawdBot --fields label=${field} --reveal`],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await proc.output();
  if (!output.success) {
    const stderr = new TextDecoder().decode(output.stderr).trim();
    throw new Error(`1Password lookup failed for ${item}/${field}: ${stderr}`);
  }
  return new TextDecoder().decode(output.stdout).trim();
}

async function pw(...parts: string[]): Promise<string> {
  const args = ["-s=" + SESSION, ...parts];
  const proc = new Deno.Command("playwright-cli", {
    args: args,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await proc.output();
  const stdout = new TextDecoder().decode(output.stdout).trim();
  const stderr = new TextDecoder().decode(output.stderr).trim();
  if (!output.success) {
    throw new Error(`Playwright CLI failed: ${stderr || stdout}`);
  }
  return stdout;
}

function parsePostedDate(text: string): string | null {
  const agoMatch = text.match(/(\d+)\s+(minute|hour|day|week|month)s?\s+ago/i);
  if (!agoMatch) return null;
  const num = parseInt(agoMatch[1], 10);
  const unit = agoMatch[2].toLowerCase();
  const now = new Date();
  if (unit === "minute" || unit === "hour") {
    return now.toISOString().slice(0, 10);
  } else if (unit === "day") {
    now.setDate(now.getDate() - num);
  } else if (unit === "week") {
    now.setDate(now.getDate() - num * 7);
  } else if (unit === "month") {
    now.setMonth(now.getMonth() - num);
  }
  return now.toISOString().slice(0, 10);
}

async function main() {
  console.log(`[${new Date().toISOString()}] Backfill posted dates${dryRun ? " (DRY RUN)" : ""}...`);

  const url = await readOp("Open Brain - Supabase", "project_url");
  const key = await readOp("Open Brain - Supabase", "service_role_key");
  const supabase = createClient(url, key);

  const { data: postings, error } = await supabase
    .from("job_postings")
    .select("id, url, title, companies(name)")
    .is("posted_date", null)
    .not("url", "is", null)
    .is("enrichment_error", null)
    .like("url", "%linkedin.com/jobs/view/%");

  if (error) {
    console.error("Query error:", error.message);
    return;
  }

  if (!postings || postings.length === 0) {
    console.log("No postings need posted_date backfill.");
    return;
  }

  const batch = postings.slice(0, LIMIT);
  console.log(`Found ${postings.length} total missing posted_date. Processing ${batch.length} (limit ${LIMIT}).\n`);

  // Launch browser with saved auth state
  console.log("Launching browser...");
  await pw("open", "--headed", "https://www.linkedin.com");
  try {
    await pw("state-load", "~/.playwright-auth.json");
    console.log("Auth state loaded.");
  } catch {
    console.warn("No saved auth state found.");
  }

  let updated = 0;
  let skipped = 0;
  let expired = 0;

  for (const posting of batch) {
    if (!posting.url) continue;

    const company = (posting.companies as Record<string, unknown>)?.name as string ?? "Unknown";
    const label = `${posting.title ?? "Untitled"} at ${company}`;

    try {
      console.log(`\n  Loading: ${label}`);
      await pw("goto", posting.url);

      // Wait a moment for client-side rendering
      await new Promise(r => setTimeout(r, 3000));

      // Check current URL for redirect (expired postings redirect away from /jobs/view/)
      const currentUrl = await pw("eval", "() => window.location.href");

      // Get the page content via eval
      const pageText = await pw("eval", "() => document.body.innerText.slice(0, 3000)");

      // Check for expired/404/redirect
      const isRedirect = !currentUrl.includes("/jobs/view/");
      const is404 = pageText.includes("Page not found") || pageText.includes("no longer available");
      if (isRedirect) {
        console.log(`  CLOSED ${label} — posting redirected (expired)`);
        if (!dryRun) {
          await supabase
            .from("job_postings")
            .update({ enrichment_error: "Expired (redirected)", status: "closed" })
            .eq("id", posting.id);
          await supabase.from("attribution_log").insert({
            entity_type: "job_posting",
            entity_id: posting.id,
            action: "updated",
            actor: "posting-maintenance",
            reason: "status: active -> closed — posting redirected (expired)",
            old_value: "active",
            new_value: "closed",
          });
        } else {
          console.log(`  WOULD SET status=closed and enrichment_error (redirect)`);
        }
        expired++;
      } else if (is404) {
        console.log(`  FLAGGED ${label} — page not found (bad link?)`);
        if (!dryRun) {
          await supabase
            .from("job_postings")
            .update({ enrichment_error: "Page not found (may be bad link)" })
            .eq("id", posting.id);
        } else {
          console.log(`  WOULD SET enrichment_error only (404, no status change)`);
        }
        expired++;
      } else {
        // Look for the "ago" text in the page
        const dateText = await pw("eval", '() => { const el = document.querySelector(".job-details-jobs-unified-top-card__primary-description-container"); return el ? el.textContent : document.body.innerText.slice(0, 1000); }');

        const postedDate = parsePostedDate(dateText);

        if (!postedDate) {
          console.log(`  SKIP ${label} — could not parse posting date`);
          console.log(`  Text sample: ${dateText.slice(0, 200)}`);
          skipped++;
        } else if (dryRun) {
          console.log(`  WOULD SET → posted_date = ${postedDate}`);
          updated++;
        } else {
          await supabase
            .from("job_postings")
            .update({ posted_date: postedDate })
            .eq("id", posting.id);
          console.log(`  SET → posted_date = ${postedDate}`);
          updated++;
        }
      }

      const delay = DELAY_MIN_MS + Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS);
      console.log(`  Waiting ${Math.round(delay / 1000)}s before next request...`);
      await new Promise(r => setTimeout(r, delay));

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ERROR ${label}: ${msg}`);
      skipped++;
    }
  }

  console.log(`\nDone${dryRun ? " (DRY RUN)" : ""}. ${updated} ${dryRun ? "would update" : "updated"}, ${expired} expired, ${skipped} skipped.`);
  console.log("Browser left open — close it manually or it will close when the process exits.");
}

main().catch((err) => {
  console.error(err);
  Deno.exit(1);
});
