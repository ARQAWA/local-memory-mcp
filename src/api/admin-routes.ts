import type { Express, RequestHandler } from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { getDb } from "../db/connection.js";
import { logger } from "../services/logger.js";
import type { MemoryService } from "../services/memory.service.js";
import { MemoryTypeSchema } from "../types/memory.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function registerAdminRoutes(app: Express, _service: MemoryService, rateLimiter?: RequestHandler): void {
  app.get("/admin", (_req, res) => {
    res.sendFile("admin.html", { root: join(__dirname, "..", "..", "public") });
  });

  if (rateLimiter) app.use("/admin/api", rateLimiter);

  app.get("/admin/api/analytics", async (req, res) => {
    try {
      const daysParam = typeof req.query["days"] === "string" ? req.query["days"] : "30";
      const days = Math.min(Math.max(parseInt(daysParam, 10) || 30, 1), 365);
      const db = getDb();
      const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const staleDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

      const [totalRow, typeRows, repositoryRows, creatorRows, tagRow, staleRow, importanceRow, recentRows] =
        await Promise.all([
          db<{ count: number }[]>`
            SELECT COUNT(*)::int AS count FROM memories
            WHERE deleted_at IS NULL AND valid_until IS NULL`,
          db<{ memory_type: string; count: number }[]>`
            SELECT memory_type, COUNT(*)::int AS count FROM memories
            WHERE deleted_at IS NULL AND valid_until IS NULL
            GROUP BY memory_type ORDER BY count DESC`,
          db<{ slug: string; count: number }[]>`
            SELECT r.slug, COUNT(m.id)::int AS count
            FROM repositories r
            LEFT JOIN memories m ON m.repository_id = r.id
              AND m.deleted_at IS NULL AND m.valid_until IS NULL
            GROUP BY r.slug ORDER BY count DESC`,
          db<{ creator: string; repository: string; count: number }[]>`
            SELECT m.created_by AS creator, r.slug AS repository, COUNT(*)::int AS count
            FROM memories m
            JOIN repositories r ON r.id = m.repository_id
            WHERE m.deleted_at IS NULL AND m.valid_until IS NULL
            GROUP BY m.created_by, r.slug ORDER BY count DESC LIMIT 20`,
          db<{ count: number }[]>`SELECT COUNT(DISTINCT tag)::int AS count FROM memory_tags`,
          db<{ count: number }[]>`
            SELECT COUNT(*)::int AS count FROM memories
            WHERE deleted_at IS NULL AND valid_until IS NULL AND updated_at < ${staleDate}`,
          db<{ avg: string }[]>`
            SELECT COALESCE(AVG(importance), 0)::text AS avg FROM memories
            WHERE deleted_at IS NULL AND valid_until IS NULL`,
          db<{ count: number }[]>`
            SELECT COUNT(*)::int AS count FROM memories
            WHERE deleted_at IS NULL AND valid_until IS NULL AND created_at >= ${sinceDate}`,
        ]);

      res.json({
        total_memories: totalRow[0]?.count ?? 0,
        created_last_period: recentRows[0]?.count ?? 0,
        days,
        by_type: Object.fromEntries(typeRows.map((r) => [r.memory_type, r.count])),
        by_repository: Object.fromEntries(repositoryRows.map((r) => [r.slug, r.count])),
        by_creator: creatorRows,
        total_tags: tagRow[0]?.count ?? 0,
        stale_memories: staleRow[0]?.count ?? 0,
        avg_importance: parseFloat(importanceRow[0]?.avg ?? "0"),
      });
    } catch (err: unknown) {
      logger.error("Admin analytics error", { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: "Failed to fetch analytics" });
    }
  });

  app.get("/admin/api/memories", async (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(readQueryString(req.query["limit"], "50"), 10) || 50, 1), 200);
      const offset = Math.max(parseInt(readQueryString(req.query["offset"], "0"), 10) || 0, 0);
      const search = typeof req.query["q"] === "string" ? req.query["q"].trim() : "";
      const rawType = typeof req.query["memory_type"] === "string" ? req.query["memory_type"].trim() : "";
      const repository = typeof req.query["repository"] === "string" ? req.query["repository"].trim() : "";
      const typeFilter = rawType ? (MemoryTypeSchema.safeParse(rawType).success ? rawType : "") : "";
      const db = getDb();
      const escapeLike = (s: string) => s.replace(/[%_\\]/g, "\\$&");
      const searchFrag = search
        ? db`AND (m.content ILIKE ${`%${escapeLike(search)}%`} ESCAPE '\\' OR m.summary ILIKE ${`%${escapeLike(search)}%`} ESCAPE '\\')`
        : db``;
      const typeFrag = typeFilter ? db`AND m.memory_type = ${typeFilter}` : db``;
      const repoFrag = repository ? db`AND r.slug = ${repository}` : db``;

      const [countResult] = await db<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM memories m
        JOIN repositories r ON r.id = m.repository_id
        WHERE m.deleted_at IS NULL AND m.valid_until IS NULL
          ${searchFrag} ${typeFrag} ${repoFrag}`;
      const memories = await db`
        SELECT m.id, m.summary, m.memory_type, r.slug AS repository,
               m.user_id, m.created_by, m.importance, m.access_count,
               m.created_at, m.updated_at
        FROM memories m
        JOIN repositories r ON r.id = m.repository_id
        WHERE m.deleted_at IS NULL AND m.valid_until IS NULL
          ${searchFrag} ${typeFrag} ${repoFrag}
        ORDER BY m.updated_at DESC
        LIMIT ${limit} OFFSET ${offset}`;
      res.json({ total: countResult?.count ?? 0, memories, limit, offset });
    } catch (err: unknown) {
      logger.error("Admin memories error", { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: "Failed to fetch memories" });
    }
  });

  app.get("/admin/api/memories/:id", async (req, res) => {
    try {
      const parsed = z.uuid().safeParse(req.params.id);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid memory ID format" });
        return;
      }
      const db = getDb();
      const [memory] = await db`
        SELECT m.*, r.slug AS repository_slug, r.name AS repository_name, (m.embedding IS NOT NULL) AS has_embedding
        FROM memories m
        JOIN repositories r ON r.id = m.repository_id
        WHERE m.id = ${parsed.data}`;
      if (!memory) {
        res.status(404).json({ error: "Memory not found" });
        return;
      }
      const tags = await db<
        { tag: string }[]
      >`SELECT tag FROM memory_tags WHERE memory_id = ${parsed.data} ORDER BY tag`;
      res.json({ ...memory, tags: tags.map((t) => t.tag) });
    } catch (err: unknown) {
      logger.error("Admin memory detail error", { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: "Failed to fetch memory" });
    }
  });

  logger.info("Admin routes registered");
}

function readQueryString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}
