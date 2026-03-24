/**
 * Pure, testable handler functions extracted from the MCP server.
 */

export interface AttributionLogEntry {
  entity_type: "job_posting" | "application";
  entity_id: string;
  action: string;
  actor: string;
  reason: string | null;
  old_value?: string | null;
  new_value?: string | null;
}

/**
 * Build attribution log entries for an application update by comparing
 * current state with the incoming updates.
 */
export function buildUpdateApplicationLogs(
  current: {
    status: string;
    resume_path: string | null;
    cover_letter_path: string | null;
  },
  updates: {
    status?: string;
    resume_path?: string | null;
    cover_letter_path?: string | null;
  },
  application_id: string,
  actor: string,
  actor_reason?: string,
): AttributionLogEntry[] {
  const logs: AttributionLogEntry[] = [];

  // Always include structured transition so pipeline-stats ILIKE queries match.
  // Append actor_reason as additional context rather than replacing the transition.
  if (updates.status !== undefined && updates.status !== current.status) {
    const transition = `${current.status} -> ${updates.status}`;
    logs.push({
      entity_type: "application",
      entity_id: application_id,
      action: "status_changed",
      actor,
      reason: actor_reason ? `${transition} — ${actor_reason}` : transition,
      old_value: current.status,
      new_value: updates.status,
    });
  }

  if (
    updates.resume_path !== undefined &&
    updates.resume_path !== current.resume_path
  ) {
    logs.push({
      entity_type: "application",
      entity_id: application_id,
      action: updates.resume_path === null ? "resume_removed" : "resume_added",
      actor,
      reason: actor_reason ?? null,
      old_value: current.resume_path ?? null,
      new_value: updates.resume_path ?? null,
    });
  }

  if (
    updates.cover_letter_path !== undefined &&
    updates.cover_letter_path !== current.cover_letter_path
  ) {
    logs.push({
      entity_type: "application",
      entity_id: application_id,
      action:
        updates.cover_letter_path === null
          ? "cover_letter_removed"
          : "cover_letter_added",
      actor,
      reason: actor_reason ?? null,
      old_value: current.cover_letter_path ?? null,
      new_value: updates.cover_letter_path ?? null,
    });
  }

  return logs;
}
