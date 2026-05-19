import { EntityRepository } from "../repositories/entity.repository.js";
import type { EntityType } from "../repositories/entity.repository.js";
import { getSamplingService } from "../context.js";
import { logger } from "./logger.js";

interface ExtractedEntity {
  name: string;
  type: EntityType;
}

interface ExtractedRelation {
  source: string;
  sourceType: EntityType;
  target: string;
  targetType: EntityType;
  relation: string;
}

/**
 * Extracts entities and relationships from memory content,
 * then persists them in the entity graph.
 */
export class EntityExtractionService {
  private entities: EntityRepository;

  constructor(entities: EntityRepository) {
    this.entities = entities;
  }

  /**
   * Extract entities from content and link them to a memory.
   * Uses LLM extraction via SamplingService when available, falls back to regex.
   */
  async extractAndLink(
    memoryId: string,
    content: string,
    repositoryId: string,
    existingTags: string[],
  ): Promise<{ entities: ExtractedEntity[]; relations: ExtractedRelation[] }> {
    // Extract entities from tags (already extracted by the remember pipeline)
    const fromTags = this.entitiesFromTags(existingTags);

    // Try LLM-based entity extraction via SamplingService, fall back to regex
    const sampling = getSamplingService();
    const llmEntities = sampling ? await this.extractEntitiesWithLLM(content) : null;

    const allEntities = llmEntities ? this.mergeEntities(fromTags, llmEntities) : fromTags;

    const relations = this.extractRelationsFromContent(content).relations;

    // Persist entities and link to memory
    for (const entity of allEntities) {
      try {
        const dbEntity = await this.entities.findOrCreate(entity.name, entity.type, repositoryId);
        await this.entities.linkMemory(memoryId, dbEntity.id, 1.0, repositoryId);
      } catch (err: unknown) {
        logger.debug("Failed to persist entity", {
          entity: entity.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Persist entity relations
    for (const rel of relations) {
      try {
        const sourceEntity = await this.entities.findOrCreate(rel.source, rel.sourceType, repositoryId);
        const targetEntity = await this.entities.findOrCreate(rel.target, rel.targetType, repositoryId);
        await this.entities.createRelation({
          repositoryId,
          sourceId: sourceEntity.id,
          targetId: targetEntity.id,
          relationType: rel.relation,
          memoryId,
        });
      } catch (err: unknown) {
        logger.debug("Failed to persist entity relation", {
          source: rel.source,
          target: rel.target,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { entities: allEntities, relations };
  }

  /**
   * Convert existing tags (file:, symbol:, pkg:, etc.) into structured entities.
   */
  private entitiesFromTags(tags: string[]): ExtractedEntity[] {
    const entities: ExtractedEntity[] = [];
    const prefixMap: Record<string, EntityType> = {
      "file:": "file",
      "symbol:": "concept",
      "pkg:": "package",
      "env:": "env_var",
      "error:": "error",
      "api:": "api",
      "lang:": "concept",
    };

    for (const tag of tags) {
      for (const [prefix, type] of Object.entries(prefixMap)) {
        if (tag.startsWith(prefix)) {
          entities.push({ name: tag.slice(prefix.length), type });
          break;
        }
      }
      // Tags matching service patterns
      if (/^[a-z][a-z0-9]+-(?:service|api|worker|gateway|proxy)$/.exec(tag)) {
        entities.push({ name: tag, type: "service" });
      }
    }

    return entities;
  }

  /**
   * LLM-based entity extraction via SamplingService.extractEntities().
   * Returns structured entities parsed from prefixed lines (file:, pkg:, etc.).
   */
  private async extractEntitiesWithLLM(content: string): Promise<ExtractedEntity[] | null> {
    const sampling = getSamplingService();
    if (!sampling) return null;

    try {
      const rawEntities = await sampling.extractEntities(content);
      if (!rawEntities || rawEntities.length === 0) return null;

      return rawEntities.map((raw) => {
        // Parse prefixed format: "file:path.ts", "pkg:name", "symbol:Foo"
        for (const [prefix, type] of Object.entries(this.prefixToType)) {
          if (raw.startsWith(prefix)) {
            return { name: raw.slice(prefix.length), type };
          }
        }
        // Unprefixed — treat as concept
        return { name: raw, type: "concept" };
      });
    } catch (err: unknown) {
      logger.debug("LLM entity extraction failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private readonly prefixToType: Record<string, EntityType> = {
    "file:": "file",
    "symbol:": "concept",
    "pkg:": "package",
    "env:": "env_var",
    "error:": "error",
    "api:": "api",
    "lang:": "concept",
  };

  /**
   * Regex-based relationship extraction from technical content.
   */
  private extractRelationsFromContent(content: string): {
    entities: ExtractedEntity[];
    relations: ExtractedRelation[];
  } {
    const relations: ExtractedRelation[] = [];
    const entities: ExtractedEntity[] = [];
    const lower = content.toLowerCase();

    // "X uses Y", "X depends on Y", "X connects to Y"
    const usesPattern =
      /\b([a-z][\w.-]+(?:-(?:service|api|worker|db)))\b\s+(?:uses|depends on|connects to|calls|requires)\s+\b([a-z][\w.-]+(?:-(?:service|api|worker|db)))\b/gi;
    for (const match of lower.matchAll(usesPattern)) {
      if (match[1] && match[2]) {
        relations.push({
          source: match[1],
          sourceType: "service",
          target: match[2],
          targetType: "service",
          relation: "depends_on",
        });
        entities.push({ name: match[1], type: "service" });
        entities.push({ name: match[2], type: "service" });
      }
    }

    // "X is deployed to Y", "X runs on Y"
    const deployPattern =
      /\b([a-z][\w.-]+(?:-(?:service|api|worker)))\b\s+(?:is deployed to|runs on|hosted on)\s+\b([\w.-]+)\b/gi;
    for (const match of lower.matchAll(deployPattern)) {
      if (match[1] && match[2]) {
        relations.push({
          source: match[1],
          sourceType: "service",
          target: match[2],
          targetType: "concept",
          relation: "deployed_to",
        });
      }
    }

    // "X implements Y", "X is based on Y"
    const implPattern = /\b([A-Z][\w]+)\b\s+(?:implements|extends|is based on)\s+\b([A-Z][\w]+)\b/g;
    for (const match of content.matchAll(implPattern)) {
      if (match[1] && match[2]) {
        relations.push({
          source: match[1],
          sourceType: "concept",
          target: match[2],
          targetType: "concept",
          relation: "implements",
        });
        entities.push({ name: match[1], type: "concept" });
        entities.push({ name: match[2], type: "concept" });
      }
    }

    return { entities, relations };
  }

  /**
   * Merge two entity lists, deduplicating by name+type.
   */
  private mergeEntities(a: ExtractedEntity[], b: ExtractedEntity[]): ExtractedEntity[] {
    const seen = new Set<string>();
    const result: ExtractedEntity[] = [];
    for (const entity of [...a, ...b]) {
      const key = `${entity.type}:${entity.name}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(entity);
      }
    }
    return result;
  }
}
