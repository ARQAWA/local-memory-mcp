import { z } from "zod";
import type { OrgId, TeamSlug, UserId } from "./branded.js";

export const roleValues = ["reader", "writer", "admin"] as const;

export const AuthContextSchema = z
  .object({
    org_id: z.string().min(1).max(200).default("default"),
    team_slug: z.string().min(1).max(100).optional(),
    user_id: z.string().min(1).max(200),
    role: z.enum(roleValues),
  })
  .strict();

export type Role = (typeof roleValues)[number];

// AuthContext is derived from Zod but uses plain strings for runtime compatibility
export type AuthContext = z.infer<typeof AuthContextSchema>;

// Branded version for internal use
export interface AuthContextBranded {
  org_id: OrgId;
  team_slug?: TeamSlug;
  user_id: UserId;
  role: Role;
}
