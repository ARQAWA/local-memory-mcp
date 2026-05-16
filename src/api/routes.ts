import type { Express } from "express";
import { z } from "zod";
import type { MemoryService } from "../services/memory.service.js";
import { MemoryTypeSchema, MemoryScopeSchema } from "../types/memory.js";
import { getRequestContextOrDefault } from "../context.js";
import { logger } from "../services/logger.js";
import { EngramError } from "../errors.js";

// --- API request schemas ---

const ListMemoriesQuery = z
  .object({
    all_orgs: z.enum(["true", "false"]).optional(),
    scope: MemoryScopeSchema.optional(),
    memory_type: MemoryTypeSchema.optional(),
    tags: z.string().optional(),
    team_slug: z.string().min(1).max(100).optional(),
    since: z.iso.datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

const SearchMemoriesQuery = z
  .object({
    q: z.string().min(1).max(10_000),
    all_orgs: z.enum(["true", "false"]).optional(),
    scope: MemoryScopeSchema.optional(),
    memory_type: MemoryTypeSchema.optional(),
    tags: z.string().optional(),
    team_slug: z.string().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

const IdParam = z
  .object({
    id: z.uuid(),
  })
  .strict();

const SlugParam = z
  .object({
    slug: z.string().min(1).max(100),
  })
  .strict();

const StatsQuery = z
  .object({
    all_orgs: z.enum(["true", "false"]).optional(),
    team_slug: z.string().min(1).max(100).optional(),
  })
  .strict();

const RecentQuery = z
  .object({
    team_slug: z.string().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

/**
 * Register REST API routes for the web UI.
 * These are simple JSON endpoints that delegate to MemoryService.
 */
export function registerApiRoutes(app: Express, service: MemoryService): void {
  // --- List memories ---
  app.get("/api/memories", async (req, res) => {
    try {
      const query = ListMemoriesQuery.parse(req.query);
      const ctx = getRequestContextOrDefault();
      if (query.all_orgs === "true" && ctx.role !== "admin") {
        res.status(403).json({ error: "Admin access required for all_orgs" });
        return;
      }
      const memories = await service.listMemories({
        org_id: query.all_orgs === "true" ? undefined : ctx.org_id,
        scope: query.scope,
        memory_type: query.memory_type,
        tags: parseTags(query.tags),
        team_slug: query.team_slug,
        since: query.since,
        limit: query.limit,
        offset: query.offset,
      });
      res.json(memories);
    } catch (err: unknown) {
      handleApiError(err, "GET /api/memories", res);
    }
  });

  // --- Search memories (must be before /:id to avoid route conflict) ---
  app.get("/api/memories/search", async (req, res) => {
    try {
      const query = SearchMemoriesQuery.parse(req.query);
      const ctx = getRequestContextOrDefault();
      if (query.all_orgs === "true" && ctx.role !== "admin") {
        res.status(403).json({ error: "Admin access required for all_orgs" });
        return;
      }
      const results = await service.searchMemories({
        query: query.q,
        org_id: query.all_orgs === "true" ? undefined : ctx.org_id,
        scope: query.scope,
        memory_type: query.memory_type,
        tags: parseTags(query.tags),
        team_slug: query.team_slug,
        limit: query.limit,
      });
      res.json(results);
    } catch (err: unknown) {
      handleApiError(err, "GET /api/memories/search", res);
    }
  });

  // --- Get single memory ---
  app.get("/api/memories/:id", async (req, res) => {
    try {
      const { id } = IdParam.parse(req.params);
      const ctx = getRequestContextOrDefault();
      const allOrgs = req.query["all_orgs"] === "true";
      if (allOrgs && ctx.role !== "admin") {
        res.status(403).json({ error: "Admin access required for all_orgs" });
        return;
      }
      const memory = await service.getMemory(id, allOrgs ? undefined : ctx.org_id);
      if (!memory) {
        res.status(404).json({ error: "Memory not found" });
        return;
      }
      res.json(memory);
    } catch (err: unknown) {
      handleApiError(err, "GET /api/memories/:id", res);
    }
  });

  // --- Memory stats ---
  app.get("/api/stats", async (req, res) => {
    try {
      const query = StatsQuery.parse(req.query);
      const ctx = getRequestContextOrDefault();
      if (query.all_orgs === "true" && ctx.role !== "admin") {
        res.status(403).json({ error: "Admin access required for all_orgs" });
        return;
      }
      const stats = await service.getMemoryStats(query.all_orgs === "true" ? undefined : ctx.org_id, query.team_slug);
      res.json(stats);
    } catch (err: unknown) {
      handleApiError(err, "GET /api/stats", res);
    }
  });

  // --- List teams ---
  app.get("/api/teams", async (_req, res) => {
    try {
      const ctx = getRequestContextOrDefault();
      const teams = await service.listTeams(ctx.org_id);
      res.json(teams);
    } catch (err: unknown) {
      handleApiError(err, "GET /api/teams", res);
    }
  });

  // --- Team overview ---
  app.get("/api/teams/:slug", async (req, res) => {
    try {
      const { slug } = SlugParam.parse(req.params);
      const ctx = getRequestContextOrDefault();
      const overview = await service.getTeamOverview(slug, ctx.org_id);
      if (!overview) {
        res.status(404).json({ error: "Team not found" });
        return;
      }
      res.json(overview);
    } catch (err: unknown) {
      handleApiError(err, "GET /api/teams/:slug", res);
    }
  });

  // --- List tags ---
  app.get("/api/tags", async (_req, res) => {
    try {
      const ctx = getRequestContextOrDefault();
      const tags = await service.getAllTags(ctx.org_id);
      res.json(tags);
    } catch (err: unknown) {
      handleApiError(err, "GET /api/tags", res);
    }
  });

  // --- Get relations for a memory ---
  app.get("/api/relations/:id", async (req, res) => {
    try {
      const { id } = IdParam.parse(req.params);
      const ctx = getRequestContextOrDefault();
      const allOrgs = req.query["all_orgs"] === "true";
      if (allOrgs && ctx.role !== "admin") {
        res.status(403).json({ error: "Admin access required for all_orgs" });
        return;
      }
      const relations = await service.getRelated(id, allOrgs ? undefined : ctx.org_id);
      res.json(relations);
    } catch (err: unknown) {
      handleApiError(err, "GET /api/relations/:id", res);
    }
  });

  // --- Recent audit log ---
  app.get("/api/recent", async (req, res) => {
    try {
      const query = RecentQuery.parse(req.query);
      const ctx = getRequestContextOrDefault();
      const recent = await service.getRecentChanges(query.team_slug, query.limit, ctx.org_id);
      res.json(recent);
    } catch (err: unknown) {
      handleApiError(err, "GET /api/recent", res);
    }
  });

  logger.info("API routes registered: /api/memories, /api/stats, /api/teams, /api/tags, /api/relations, /api/recent");
}

// --- Helpers ---

function parseTags(val: string | undefined): string[] | undefined {
  if (!val?.trim()) return undefined;
  return val
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function handleApiError(err: unknown, route: string, res: import("express").Response): void {
  if (res.headersSent) return;
  if (err instanceof z.ZodError) {
    const issues = err.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    }));
    logger.warn(`API validation error: ${route}`, { issues });
    res.status(400).json({ error: "Validation error", details: issues });
    return;
  }
  if (err instanceof EngramError) {
    logger.warn(`API error: ${route}`, { error: err.message, code: err.code });
    res.status(err.statusCode).json({ error: err.message, code: err.code });
    return;
  }
  const errMsg = err instanceof Error ? err.message : String(err);
  logger.error(`API error: ${route}`, { error: errMsg });
  res.status(500).json({ error: "Internal server error" });
}
