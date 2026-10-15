/**
 * @Author Christian Relf
 * @Date 2026-10-12
 */

import { convertFileSrc } from "@tauri-apps/api/core";

/** Joins a base directory and a relative path using the base's separator. */
export function joinPath(base: string, rel: string): string {
  const sep = base.includes("\\") ? "\\" : "/";
  return `${base.replace(/[\/]+$/, "")}${sep}${rel.replace(/[\/]+/g, sep)}`;
}

/** URL for a managed asset (relative to the attachments directory). */
export function assetUrl(attachmentsDir: string, rel: string): string {
  return convertFileSrc(joinPath(attachmentsDir, rel));
}
