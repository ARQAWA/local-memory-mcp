import { z } from "zod";
import type { UserId } from "./branded.js";

export const roleValues = ["reader", "writer", "admin"] as const;

export const AuthContextSchema = z
  .object({
    repository: z.string().min(1).max(200),
    user_id: z.string().min(1).max(200),
    role: z.enum(roleValues),
  })
  .strict();

export type Role = (typeof roleValues)[number];
export type AuthContext = z.infer<typeof AuthContextSchema>;

export interface AuthContextBranded {
  repository: string;
  user_id: UserId;
  role: Role;
}
