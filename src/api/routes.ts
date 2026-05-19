import type { Express } from "express";
import { z } from "zod";
import { getRequestContext } from "../context.js";
import { EngramError, ValidationError } from "../errors.js";
import { logger } from "../services/logger.js";
import type { MemoryService } from "../services/memory.service.js";
import { MemoryTypeSchema, RelatedModeSchema, RepositorySelectorSchema } from "../types/memory.js";

const ListMemoriesQuery = RepositorySelectorSchema.extend({
  memory_type: MemoryTypeSchema.optional(),
  tags: z.string().optional(),
  since: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
}).strict();

const SearchMemoriesQuery = RepositorySelectorSchema.extend({
  q: z.string().min(1).max(10_000),
  memory_type: MemoryTypeSchema.optional(),
  tags: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
}).strict();

const IdParam = z.object({ id: z.uuid() }).strict();
const IdQuery = RepositorySelectorSchema;
const RelationsQuery = RepositorySelectorSchema.extend({
  mode: RelatedModeSchema.default("active"),
}).strict();
const StatsQuery = RepositorySelectorSchema;
const RecentQuery = RepositorySelectorSchema.extend({
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

export function registerApiRoutes(app: Express, service: MemoryService): void {
  app.get("/api/repositories", async (_req, res) => {
    try {
      res.json(await service.listRepositories());
    } catch (err: unknown) {
      handleApiError(err, "GET /api/repositories", res);
    }
  });

  app.get("/api/memories", async (req, res) => {
    try {
      const query = ListMemoriesQuery.parse(req.query);
      assertCurrentRepositoryAvailable(query.repository_mode);
      const memories = await service.listMemories({ ...query, tags: parseTags(query.tags) });
      res.json(memories);
    } catch (err: unknown) {
      handleApiError(err, "GET /api/memories", res);
    }
  });

  app.get("/api/memories/search", async (req, res) => {
    try {
      const query = SearchMemoriesQuery.parse(req.query);
      assertCurrentRepositoryAvailable(query.repository_mode);
      const fetchLimit = Math.min(query.limit + query.offset, 500);
      const results = await service.searchMemories({
        query: query.q,
        repository_mode: query.repository_mode,
        repository: query.repository,
        memory_type: query.memory_type,
        tags: parseTags(query.tags),
        limit: fetchLimit,
      });
      res.json(results.slice(query.offset, query.offset + query.limit));
    } catch (err: unknown) {
      handleApiError(err, "GET /api/memories/search", res);
    }
  });

  app.get("/api/memories/:id", async (req, res) => {
    try {
      const { id } = IdParam.parse(req.params);
      const query = IdQuery.parse(req.query);
      assertCurrentRepositoryAvailable(query.repository_mode);
      const resolved = await service.resolveRepository(query);
      const memory = await service.getMemory(id, resolved.repository_id, { includeInvalidated: false });
      if (!memory) {
        res.status(404).json({ error: "Memory not found" });
        return;
      }
      res.json(memory);
    } catch (err: unknown) {
      handleApiError(err, "GET /api/memories/:id", res);
    }
  });

  app.get("/api/stats", async (req, res) => {
    try {
      const query = StatsQuery.parse(req.query);
      assertCurrentRepositoryAvailable(query.repository_mode);
      res.json(await service.getMemoryStats(query));
    } catch (err: unknown) {
      handleApiError(err, "GET /api/stats", res);
    }
  });

  app.get("/api/tags", async (req, res) => {
    try {
      const query = StatsQuery.parse(req.query);
      assertCurrentRepositoryAvailable(query.repository_mode);
      res.json(await service.getAllTags(query));
    } catch (err: unknown) {
      handleApiError(err, "GET /api/tags", res);
    }
  });

  app.get("/api/relations/:id", async (req, res) => {
    try {
      const { id } = IdParam.parse(req.params);
      const query = RelationsQuery.parse(req.query);
      assertCurrentRepositoryAvailable(query.repository_mode);
      const resolved = await service.resolveRepository(query);
      const memory = await service.getMemory(id, resolved.repository_id, {
        includeInvalidated: query.mode !== "active",
      });
      if (!memory) {
        res.status(404).json({ error: "Memory not found" });
        return;
      }
      res.json(await service.getRelated(id, resolved.repository_id ?? memory.repository_id, { mode: query.mode }));
    } catch (err: unknown) {
      handleApiError(err, "GET /api/relations/:id", res);
    }
  });

  app.get("/api/recent", async (req, res) => {
    try {
      const query = RecentQuery.parse(req.query);
      assertCurrentRepositoryAvailable(query.repository_mode);
      res.json(await service.getRecentChanges(query.limit, query));
    } catch (err: unknown) {
      handleApiError(err, "GET /api/recent", res);
    }
  });

  app.get("/api/context", async (_req, res) => {
    try {
      const ctx = getRequestContext();
      if (!ctx) {
        res.json({ current_repository: null, identity: null });
        return;
      }
      const repository = await service.currentRepository();
      res.json({ current_repository: repository, identity: { user_id: ctx.user_id, role: ctx.role } });
    } catch (err: unknown) {
      handleApiError(err, "GET /api/context", res);
    }
  });

  logger.info("API routes registered");
}

function parseTags(val: string | undefined): string[] | undefined {
  if (!val?.trim()) return undefined;
  return val
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function assertCurrentRepositoryAvailable(repositoryMode: string): void {
  if (repositoryMode === "current" && !getRequestContext()) {
    throw new ValidationError("current repository is unavailable in Web/API mode; use repository_mode=all or specific");
  }
}

function handleApiError(err: unknown, route: string, res: import("express").Response): void {
  if (res.headersSent) return;
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: "Validation error", details: err.issues });
    return;
  }
  if (err instanceof EngramError) {
    res.status(err.statusCode).json({ error: err.message, code: err.code });
    return;
  }
  logger.error(`API error: ${route}`, { error: err instanceof Error ? err.message : String(err) });
  res.status(500).json({ error: "Internal server error" });
}
