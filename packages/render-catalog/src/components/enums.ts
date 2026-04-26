// Shared Zod enums used by Set A canonical signatures.
// Per FLO-657 — only enums consumed by ≥2 of the shared components live here.
// Component-specific enums (e.g. Section variant) stay inline.

import { z } from "zod";

/** Severity scale used by GapItem + RiskMatrix. */
export const severityEnum = z.enum(["critical", "warning", "info"]);

/** Gap classification for GapItem (explorer's tighter contract — door's free-form
 *  string was too permissive for prompt-time AI guidance). */
export const gapTypeEnum = z.enum([
  "stub",
  "orphan",
  "empty",
  "asymmetric",
  "unanswered",
]);

/** Confidence scale used by PatternCard (and any future component that wants
 *  the same three-bucket discrete confidence). */
export const confidenceEnum = z.enum(["high", "medium", "low"]);
