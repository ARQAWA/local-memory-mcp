import type { Express, RequestHandler } from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { logger } from "../services/logger.js";
import type { MemoryService } from "../services/memory.service.js";
import { MemoryTypeSchema } from "../types/memory.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function registerAdminRoutes(app: Express, service: MemoryService, rateLimiter?: RequestHandler): void {
  app.get("/admin", (_req, res) => {
    res.sendFile("admin.html", { root: join(__dirname, "..", "..", "public") });
  });

  if (rateLimiter) app.use("/admin/api", rateLimiter);

  app.get("/admin/api/analytics", async (req, res) => {
    try {
      const daysParam = typeof req.query["days"] === "string" ? req.query["days"] : "30";
      const days = Math.min(Math.max(parseInt(daysParam, 10) || 30, 1), 365);
      res.json(service.getAdminAnalytics(days));
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
      res.json(
        service.listAdminMemories({
          limit,
          offset,
          search,
          memoryType: typeFilter,
          repository,
        }),
      );
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
      const memory = service.getAdminMemoryDetail(parsed.data);
      if (!memory) {
        res.status(404).json({ error: "Memory not found" });
        return;
      }
      res.json(memory);
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
