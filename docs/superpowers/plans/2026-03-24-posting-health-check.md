# Posting Health Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a weekly health check that re-visits active LinkedIn postings and marks expired ones as closed.

**Architecture:** Rename `backfill-posted-dates.ts` to `posting-maintenance.ts`, add a `--mode` flag to select between backfill (current behavior) and check-active (new health check), add a launchd plist for weekly Sunday runs.

**Tech Stack:** TypeScript, Deno, Playwright CLI, Supabase, launchd

**Spec:** `docs/superpowers/specs/2026-03-24-posting-health-check-design.md`

---

### Task 1: Rename script and update constants

**Files:**
- Rename: `extensions/job-hunt/scripts/backfill-posted-dates.ts` -> `extensions/job-hunt/scripts/posting-maintenance.ts`

- [ ] **Step 1: Rename the file**

```bash
git -C /Users/dfrysinger/Projects/open-brain mv extensions/job-hunt/scripts/backfill-posted-dates.ts extensions/job-hunt/scripts/posting-maintenance.ts
```

- [ ] **Step 2: Update the file header comment**

Change lines 1-5 from:
```typescript
// scripts/backfill-posted-dates.ts
//
// Scrapes posted_date from LinkedIn for jobs that are missing it.
// Uses npx @playwright/cli (same as job-applicator) for reliable rendering.
// Pass --dry-run to preview without writing to the database.
```
To:
```typescript
// scripts/posting-maintenance.ts
//
// Maintains job posting data via LinkedIn.
// --mode backfill (default): scrapes posted_date for jobs missing it.
// --mode check-active: re-visits active postings, marks expired ones as closed.
// Pass --dry-run to preview without writing. Pass --limit N to cap batch size.
```

- [ ] **Step 3: Update SESSION constant**

Change line 11 from:
```typescript
const SESSION = "backfill";
```
To:
```typescript
const SESSION = "maintenance";
```

- [ ] **Step 4: Update actor in attribution log insert**

Change line 140 from:
```typescript
            actor: "backfill-posted-dates",
```
To:
```typescript
            actor: "posting-maintenance",
```

- [ ] **Step 5: Commit**

```
git add extensions/job-hunt/scripts/posting-maintenance.ts
git commit -m "refactor: rename backfill-posted-dates to posting-maintenance"
```

---

### Task 2: Add --mode flag and check-active query

**Files:**
- Modify: `extensions/job-hunt/scripts/posting-maintenance.ts`

- [ ] **Step 1: Add mode parsing after the existing arg parsing (line 14)**

After the `LIMIT` constant (line 15), add:

```typescript
const modeIdx = Deno.args.indexOf("--mode");
const MODE = modeIdx !== -1 ? Deno.args[modeIdx + 1] : "backfill";
if (!["backfill", "check-active"].includes(MODE)) {
  console.error(`Unknown mode: ${MODE}. Must be "backfill" or "check-active".`);
  Deno.exit(1);
}
```

- [ ] **Step 2: Update the default LIMIT**

Change the LIMIT default from 3 to depend on mode. Replace line 15:
```typescript
const LIMIT = limitIdx !== -1 ? parseInt(Deno.args[limitIdx + 1], 10) : 3;
```
With:
```typescript
const DEFAULT_LIMIT = MODE === "check-active" ? 999 : 3;
const LIMIT = limitIdx !== -1 ? parseInt(Deno.args[limitIdx + 1], 10) : DEFAULT_LIMIT;
```

- [ ] **Step 3: Replace the query in main() with mode-dependent logic**

Replace lines 66-91 (from the log line through the batch/log statement) with:

```typescript
  const modeLabel = MODE === "check-active" ? "check active postings" : "backfill posted dates";
  console.log(`[${new Date().toISOString()}] Posting maintenance: ${modeLabel}${dryRun ? " (DRY RUN)" : ""}...`);

  const url = await readOp("Open Brain - Supabase", "project_url");
  const key = await readOp("Open Brain - Supabase", "service_role_key");
  const supabase = createClient(url, key);

  let query = supabase
    .from("job_postings")
    .select("id, url, title, posted_date, companies(name)")
    .not("url", "is", null)
    .is("enrichment_error", null)
    .like("url", "%linkedin.com/jobs/view/%");

  if (MODE === "check-active") {
    query = query.eq("status", "active");
  } else {
    query = query.is("posted_date", null);
  }

  const { data: postings, error } = await query;

  if (error) {
    console.error("Query error:", error.message);
    return;
  }

  if (!postings || postings.length === 0) {
    console.log("No postings to process.");
    return;
  }

  const batch = postings.slice(0, LIMIT);
  console.log(`Found ${postings.length} postings to process. Running ${batch.length} (limit ${LIMIT}).\n`);
```

- [ ] **Step 4: Update the live-posting handler for check-active mode**

In the `else` block (the live posting case, around line 160), wrap the posted_date scraping in a condition:

Replace the current else block (lines 160-181) with:

```typescript
      } else {
        if (MODE === "check-active" && (posting as any).posted_date) {
          console.log(`  OK ${label} — still active`);
        } else {
          // Scrape posted_date
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
      }
```

Note: the query in Step 3 now selects `posted_date` so the handler can check it.

- [ ] **Step 5: Commit**

```
git add extensions/job-hunt/scripts/posting-maintenance.ts
git commit -m "feat: add --mode check-active to posting-maintenance script"
```

---

### Task 3: Create launchd plist

**Files:**
- Create: `extensions/job-hunt/launchd/com.openbrain.posting-maintenance.plist`

- [ ] **Step 1: Create the plist file**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.openbrain.posting-maintenance</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/deno</string>
    <string>run</string>
    <string>--allow-all</string>
    <string>/Users/dfrysinger/Projects/open-brain/extensions/job-hunt/scripts/posting-maintenance.ts</string>
    <string>--mode</string>
    <string>check-active</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key>
    <integer>0</integer>
    <key>Hour</key>
    <integer>7</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/tmp/posting-maintenance.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/posting-maintenance.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>/Users/dfrysinger</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
```

- [ ] **Step 2: Load the plist**

```bash
cp /Users/dfrysinger/Projects/open-brain/extensions/job-hunt/launchd/com.openbrain.posting-maintenance.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.openbrain.posting-maintenance.plist
launchctl list | grep posting-maintenance
```

- [ ] **Step 3: Commit**

```
git add extensions/job-hunt/launchd/com.openbrain.posting-maintenance.plist
git commit -m "feat: add weekly launchd plist for posting health check (Sundays 7am)"
```

---

### Task 4: Test and push

**Files:**
- No file changes

- [ ] **Step 1: Test check-active mode with dry run and limit 3**

```bash
cd ~/Projects/open-brain/extensions/job-hunt && deno run --allow-all scripts/posting-maintenance.ts --mode check-active --dry-run --limit 3
```

Verify it queries active postings (not ones missing posted_date), visits them, and reports OK/CLOSED/FLAGGED status for each.

- [ ] **Step 2: Test backfill mode still works**

```bash
cd ~/Projects/open-brain/extensions/job-hunt && deno run --allow-all scripts/posting-maintenance.ts --mode backfill --dry-run --limit 3
```

Verify it queries postings missing posted_date (the original behavior).

- [ ] **Step 3: Push**

```bash
git push
```
