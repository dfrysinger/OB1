# Posting Health Check

Add a weekly health check that re-visits active LinkedIn postings and marks expired ones as closed.

## Problem

The enrichment cron only checks postings that are missing data. Once a posting is enriched, it is never re-visited. If a posting expires on LinkedIn weeks later, the system never notices. Active postings accumulate stale entries that pollute the pipeline, networking queue, and daily status messages.

## Design

### Script changes

Rename `backfill-posted-dates.ts` to `posting-maintenance.ts`. Add a `--mode` flag:

- `--mode backfill` (default): Current behavior. Queries postings missing `posted_date`, visits LinkedIn, scrapes the date, detects expired postings along the way.
- `--mode check-active`: New mode. Queries all active postings with LinkedIn URLs (`status = 'active'` and `url LIKE '%linkedin.com/jobs/view/%'`), excluding postings that already have `enrichment_error` set (already flagged). Visits each posting with Playwright CLI, applies the same redirect vs 404 logic:
  - Redirect (URL changes away from `/jobs/view/`): set `status = 'closed'`, set `enrichment_error`, log to `attribution_log` with `old_value`/`new_value`.
  - 404 (page shows "Page not found"): set `enrichment_error` only, leave `status = 'active'`.
  - Live posting: if `posted_date` is null, scrape it. Otherwise skip.

Both modes share the same Playwright CLI browser session, delay logic (30-90s random), dry-run flag, and limit flag.

### Scheduling

Add launchd plist `com.openbrain.posting-maintenance.plist`:
- Runs weekly on Sundays at 7:00am MT (13:00 UTC in MDT, 14:00 UTC in MST)
- Command: `deno run --allow-all scripts/posting-maintenance.ts --mode check-active`
- No `--limit` flag (processes all active LinkedIn postings)
- Same working directory and environment as the existing launchd plists

The backfill mode remains manual-only, no schedule.

### File updates

- Rename: `extensions/job-hunt/scripts/backfill-posted-dates.ts` -> `extensions/job-hunt/scripts/posting-maintenance.ts`
- Create: `extensions/job-hunt/launchd/com.openbrain.posting-maintenance.plist`
- Update: any references to the old filename in CLAUDE.md or other docs

### No other changes needed

The script already has all the infrastructure: Playwright CLI with `state-load`, Supabase client via 1Password, `--dry-run` flag, `--limit` flag, redirect detection that sets `status = 'closed'` with attribution logging, 404 detection that sets `enrichment_error` only, random delays between requests.

## Files to modify

1. `extensions/job-hunt/scripts/backfill-posted-dates.ts` -> `extensions/job-hunt/scripts/posting-maintenance.ts` (rename + add mode flag)
2. `extensions/job-hunt/launchd/com.openbrain.posting-maintenance.plist` (new)
