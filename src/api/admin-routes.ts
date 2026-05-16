import type { Express, Request, Response, NextFunction, RequestHandler } from "express";
import { z } from "zod";
import type { MemoryService } from "../services/memory.service.js";
import { MemoryTypeSchema, MemoryScopeSchema } from "../types/memory.js";
import { loadConfig } from "../config.js";
import { logger } from "../services/logger.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // Pad to equal length so timingSafeEqual always runs on same-length buffers
  const maxLen = Math.max(bufA.length, bufB.length);
  const padA = Buffer.alloc(maxLen);
  const padB = Buffer.alloc(maxLen);
  bufA.copy(padA);
  bufB.copy(padB);
  // Evaluate both checks unconditionally — use bitwise AND to avoid
  // short-circuit evaluation that would leak timing information.
  const contentsMatch = timingSafeEqual(padA, padB) ? 1 : 0;
  const lengthsMatch = bufA.length === bufB.length ? 1 : 0;
  return (contentsMatch & lengthsMatch) === 1;
}

function basicAuth(req: Request, res: Response, next: NextFunction): void {
  const config = loadConfig();
  if (!config.adminPassword) {
    res.status(403).json({
      error: "Admin dashboard not configured. Set ADMIN_PASSWORD env var.",
    });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="Local Memory Admin"');
    res.status(401).send("Authentication required");
    return;
  }

  const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf-8");
  const colonIdx = decoded.indexOf(":");
  if (colonIdx === -1) {
    res.set("WWW-Authenticate", 'Basic realm="Local Memory Admin"');
    res.status(401).send("Invalid credentials");
    return;
  }

  const user = decoded.slice(0, colonIdx);
  const pass = decoded.slice(colonIdx + 1);

  // Evaluate both comparisons unconditionally — do NOT short-circuit with ||
  // because that would leak timing information about which field failed.
  const userOk = safeCompare(user, config.adminUser);
  const passOk = safeCompare(pass, config.adminPassword);
  if (!userOk || !passOk) {
    res.set("WWW-Authenticate", 'Basic realm="Local Memory Admin"');
    res.status(401).send("Invalid credentials");
    return;
  }

  next();
}

export function registerAdminRoutes(app: Express, _service: MemoryService, rateLimiter?: RequestHandler): void {
  // Serve admin UI without auth (login is handled client-side)
  app.get("/admin", (_req, res) => {
    res.sendFile(join(__dirname, "..", "..", "public", "admin.html"));
  });

  // All /admin/api routes: rate limit first, then Basic Auth
  if (rateLimiter) app.use("/admin/api", rateLimiter);
  app.use("/admin/api", basicAuth);

  // Admin API: analytics (cross-org)
  app.get("/admin/api/analytics", async (_req, res) => {
    try {
      const daysParam = typeof _req.query["days"] === "string" ? _req.query["days"] : "30";
      const days = Math.min(Math.max(parseInt(daysParam, 10) || 30, 1), 365);
      // Pass a wildcard org — we need cross-org data
      // Use getAnalytics with a special "all" org query
      const db = (await import("../db/connection.js")).getDb();

      // Compute date boundaries in JS to avoid PG-only make_interval/interval syntax
      const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const staleDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

      const [totalRow, typeRows, scopeRows, creatorRows, tagRow, staleRow, importanceRow, recentRows] =
        await Promise.all([
          db<{ count: number }[]>`
            SELECT COUNT(*)::int AS count FROM memories
            WHERE deleted_at IS NULL AND valid_until IS NULL`,
          db<{ memory_type: string; count: number }[]>`
            SELECT memory_type, COUNT(*)::int AS count FROM memories
            WHERE deleted_at IS NULL AND valid_until IS NULL
            GROUP BY memory_type ORDER BY count DESC`,
          db<{ scope: string; count: number }[]>`
            SELECT scope, COUNT(*)::int AS count FROM memories
            WHERE deleted_at IS NULL AND valid_until IS NULL
            GROUP BY scope ORDER BY count DESC`,
          db<{ creator: string; org_id: string; count: number }[]>`
            SELECT created_by AS creator, org_id, COUNT(*)::int AS count FROM memories
            WHERE deleted_at IS NULL AND valid_until IS NULL
            GROUP BY created_by, org_id ORDER BY count DESC LIMIT 20`,
          db<{ count: number }[]>`
            SELECT COUNT(DISTINCT tag)::int AS count FROM memory_tags`,
          db<{ count: number }[]>`
            SELECT COUNT(*)::int AS count FROM memories
            WHERE deleted_at IS NULL AND valid_until IS NULL
              AND updated_at < ${staleDate}`,
          db<{ avg: string }[]>`
            SELECT COALESCE(AVG(importance), 0)::text AS avg FROM memories
            WHERE deleted_at IS NULL AND valid_until IS NULL`,
          db<{ count: number }[]>`
            SELECT COUNT(*)::int AS count FROM memories
            WHERE deleted_at IS NULL AND valid_until IS NULL
              AND created_at >= ${sinceDate}`,
        ]);

      // Org breakdown
      const orgRows = await db<{ org_id: string; count: number }[]>`
        SELECT org_id, COUNT(*)::int AS count FROM memories
        WHERE deleted_at IS NULL AND valid_until IS NULL
        GROUP BY org_id ORDER BY count DESC`;

      // Team breakdown
      const teamRows = await db<{ slug: string; count: number }[]>`
        SELECT t.slug, COUNT(*)::int AS count FROM memories m
        JOIN teams t ON t.id = m.team_id
        WHERE m.deleted_at IS NULL AND m.valid_until IS NULL
        GROUP BY t.slug ORDER BY count DESC`;

      res.json({
        total_memories: totalRow[0]?.count ?? 0,
        created_last_period: recentRows[0]?.count ?? 0,
        days,
        by_type: Object.fromEntries(typeRows.map((r) => [r.memory_type, r.count])),
        by_scope: Object.fromEntries(scopeRows.map((r) => [r.scope, r.count])),
        by_org: Object.fromEntries(orgRows.map((r) => [r.org_id, r.count])),
        by_team: Object.fromEntries(teamRows.map((r) => [r.slug, r.count])),
        by_creator: creatorRows,
        total_tags: tagRow[0]?.count ?? 0,
        stale_memories: staleRow[0]?.count ?? 0,
        avg_importance: parseFloat(importanceRow[0]?.avg ?? "0"),
      });
    } catch (err: unknown) {
      logger.error("Admin analytics error", {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: "Failed to fetch analytics" });
    }
  });

  // Admin API: list all memories (cross-org, paginated)
  app.get("/admin/api/memories", async (req, res) => {
    try {
      const limitParam = typeof req.query["limit"] === "string" ? req.query["limit"] : "50";
      const offsetParam = typeof req.query["offset"] === "string" ? req.query["offset"] : "0";
      const limit = Math.min(Math.max(parseInt(limitParam, 10) || 50, 1), 200);
      const offset = Math.max(parseInt(offsetParam, 10) || 0, 0);
      const search = typeof req.query["q"] === "string" ? req.query["q"].trim() : "";
      const rawType = typeof req.query["memory_type"] === "string" ? req.query["memory_type"].trim() : "";
      const rawScope = typeof req.query["scope"] === "string" ? req.query["scope"].trim() : "";
      const typeFilter = rawType ? (MemoryTypeSchema.safeParse(rawType).success ? rawType : "") : "";
      const scopeFilter = rawScope ? (MemoryScopeSchema.safeParse(rawScope).success ? rawScope : "") : "";

      const db = (await import("../db/connection.js")).getDb();

      // Escape LIKE metacharacters before wrapping in wildcards
      const escapeLike = (s: string) => s.replace(/[%_\\]/g, "\\$&");

      // Build dynamic filter fragments
      const searchFrag = search
        ? db`AND (content ILIKE ${`%${escapeLike(search)}%`} ESCAPE '\\' OR summary ILIKE ${`%${escapeLike(search)}%`} ESCAPE '\\')`
        : db``;
      const typeFrag = typeFilter ? db`AND memory_type = ${typeFilter}` : db``;
      const scopeFrag = scopeFilter ? db`AND scope = ${scopeFilter}` : db``;

      const countResult = await db<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM memories
        WHERE deleted_at IS NULL AND valid_until IS NULL
          ${searchFrag} ${typeFrag} ${scopeFrag}`;
      const total = countResult[0]?.count ?? 0;

      const memories = await db`
        SELECT id, summary, memory_type, scope, org_id, user_id, created_by,
               importance, access_count, created_at, updated_at
        FROM memories
        WHERE deleted_at IS NULL AND valid_until IS NULL
          ${searchFrag} ${typeFrag} ${scopeFrag}
        ORDER BY updated_at DESC
        LIMIT ${limit} OFFSET ${offset}`;

      res.json({ total, memories, limit, offset });
    } catch (err: unknown) {
      logger.error("Admin memories error", {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: "Failed to fetch memories" });
    }
  });

  // Admin API: get single memory with full content
  app.get("/admin/api/memories/:id", async (req, res) => {
    try {
      // eslint-disable-next-line @typescript-eslint/dot-notation
      const rawId = req.params["id"];
      const parsed = z.uuid().safeParse(rawId);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid memory ID format" });
        return;
      }
      const id = parsed.data;
      const db = (await import("../db/connection.js")).getDb();
      const [memory] = await db`
        SELECT id, team_id, org_id, user_id, memory_type, scope,
          content, summary, importance, created_by, source, supersedes,
          valid_from, valid_until, created_at, updated_at, expires_at,
          access_count, last_accessed_at, status, type, title, visibility,
          author, metadata, hlc, hlc_wall, field_hlcs, deleted_at,
          (embedding IS NOT NULL) AS has_embedding
        FROM memories WHERE id = ${id}`;
      if (!memory) {
        res.status(404).json({ error: "Memory not found" });
        return;
      }
      // Get tags
      const tags = await db<{ tag: string }[]>`
        SELECT tag FROM memory_tags WHERE memory_id = ${id} ORDER BY tag`;
      // Convert BigInt fields (e.g. hlc_wall) to strings for JSON serialization
      const safeMemory = Object.fromEntries(
        Object.entries(memory).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]),
      );
      res.json({ ...safeMemory, tags: tags.map((t) => t.tag) });
    } catch (err: unknown) {
      logger.error("Admin memory detail error", {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: "Failed to fetch memory" });
    }
  });

  logger.info("Admin routes registered: /admin, /admin/api/analytics, /admin/api/memories");
}
