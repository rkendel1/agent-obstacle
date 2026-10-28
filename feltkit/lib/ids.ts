import { randomBytes } from "node:crypto";

/** A new experiment lineage id ("exp_" + 12 hex). */
export function newLineageId(): string {
  return `exp_${randomBytes(6).toString("hex")}`;
}
