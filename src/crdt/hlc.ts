/**
 * Hybrid Logical Clock (HLC) implementation based on Kulkarni et al. (2014).
 *
 * Combines physical wall-clock time with a logical counter to produce
 * monotonically increasing, causally ordered timestamps across distributed
 * nodes. Serialized form sorts lexicographically for efficient DB range queries.
 */

import { randomBytes } from "node:crypto";

/** Maximum allowed clock drift from a remote node (60 seconds). */
const MAX_DRIFT_MS = 60_000n;

/** A Hybrid Logical Clock timestamp. */
export interface HLC {
  /** Milliseconds since epoch. */
  wallTime: bigint;
  /** Logical counter (0-65535). */
  counter: number;
  /** Unique node identifier. */
  nodeId: string;
}

/**
 * A clock instance that issues monotonically increasing HLC timestamps
 * for local events and merges causality from remote timestamps.
 */
export class HybridClock {
  #last: HLC;
  readonly #nodeId: string;

  constructor(nodeId: string) {
    this.#nodeId = nodeId;
    this.#last = { wallTime: 0n, counter: 0, nodeId };
  }

  /** Generate a new timestamp for a local event. */
  now(): HLC {
    const physicalNow = BigInt(Date.now());
    let wall: bigint;
    let counter: number;

    if (physicalNow > this.#last.wallTime) {
      wall = physicalNow;
      counter = 0;
    } else {
      wall = this.#last.wallTime;
      counter = this.#last.counter + 1;
    }

    this.#last = { wallTime: wall, counter, nodeId: this.#nodeId };
    return this.#last;
  }

  /** Receive a remote HLC and merge with the local clock. */
  receive(remote: HLC): HLC {
    const physicalNow = BigInt(Date.now());

    // Clock drift protection: reject timestamps too far in the future.
    if (remote.wallTime - physicalNow > MAX_DRIFT_MS) {
      throw new Error(
        `Remote HLC wall time is ${remote.wallTime - physicalNow}ms ahead of local clock (max drift: ${MAX_DRIFT_MS}ms)`,
      );
    }

    let wall: bigint;
    let counter: number;

    // Determine the maximum wall time across all three sources.
    if (physicalNow > this.#last.wallTime && physicalNow > remote.wallTime) {
      wall = physicalNow;
      counter = 0;
    } else if (this.#last.wallTime === remote.wallTime && this.#last.wallTime >= physicalNow) {
      wall = this.#last.wallTime;
      counter = Math.max(this.#last.counter, remote.counter) + 1;
    } else if (this.#last.wallTime > remote.wallTime && this.#last.wallTime >= physicalNow) {
      wall = this.#last.wallTime;
      counter = this.#last.counter + 1;
    } else {
      // remote.wallTime is strictly greatest
      wall = remote.wallTime;
      counter = remote.counter + 1;
    }

    this.#last = { wallTime: wall, counter, nodeId: this.#nodeId };
    return this.#last;
  }

  /** Get the last issued HLC without advancing the clock. */
  peek(): HLC {
    return this.#last;
  }

  /**
   * Compare two HLCs for total ordering.
   * Returns -1 if a < b, 0 if equal, 1 if a > b.
   * Tie-breaking order: wallTime, then counter, then nodeId.
   */
  static compare(a: HLC, b: HLC): number {
    if (a.wallTime < b.wallTime) return -1;
    if (a.wallTime > b.wallTime) return 1;
    if (a.counter < b.counter) return -1;
    if (a.counter > b.counter) return 1;
    if (a.nodeId < b.nodeId) return -1;
    if (a.nodeId > b.nodeId) return 1;
    return 0;
  }

  /**
   * Serialize an HLC to a lexicographically sortable string.
   * Format: `{wallTime}-{counter as 4-char hex}-{nodeId}`
   * Example: `"1710000000000-002a-agent1"`
   */
  static serialize(hlc: HLC): string {
    const counterHex = hlc.counter.toString(16).padStart(4, "0");
    return `${hlc.wallTime.toString()}-${counterHex}-${hlc.nodeId}`;
  }

  /**
   * Parse a serialized HLC string back into an HLC object.
   * Expects the format produced by `serialize()`.
   */
  static parse(s: string): HLC {
    // Split into exactly 3 parts: wallTime, counter hex, nodeId
    // nodeId may contain hyphens, so we split on first two hyphens only.
    const firstDash = s.indexOf("-");
    if (firstDash === -1) {
      throw new Error(`Invalid HLC string: "${s}"`);
    }
    const secondDash = s.indexOf("-", firstDash + 1);
    if (secondDash === -1) {
      throw new Error(`Invalid HLC string: "${s}"`);
    }

    const wallTimeStr = s.slice(0, firstDash);
    const counterHex = s.slice(firstDash + 1, secondDash);
    const nodeId = s.slice(secondDash + 1);

    if (counterHex.length !== 4) {
      throw new Error(`Invalid HLC counter in string: "${s}"`);
    }

    return {
      wallTime: BigInt(wallTimeStr),
      counter: parseInt(counterHex, 16),
      nodeId,
    };
  }

  /** Check if an HLC is the zero/unset value. */
  static isZero(hlc: HLC): boolean {
    return hlc.wallTime === 0n && hlc.counter === 0;
  }

  /** The zero HLC constant (represents an unset timestamp). */
  static readonly ZERO: HLC = { wallTime: 0n, counter: 0, nodeId: "" };
}

/**
 * Generate a unique node ID for this process.
 * Format: `{userId}-{pid}-{random4hex}`
 * Example: `"aleksandr.lisenko-12345-a7f2"`
 */
export function generateNodeId(userId: string): string {
  const pid = process.pid;
  const random = randomBytes(2).toString("hex");
  return `${userId}-${pid}-${random}`;
}
