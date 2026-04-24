import { createHash } from "node:crypto";

export type CodemapIdNamespace =
  | "snapshot"
  | "claim"
  | "evidence"
  | "verification"
  | "history"
  | "conflict"
  | "publish"
  | "incident";

export const CODEMAP_ID_SEPARATOR = ":" as const;

export function makeCodemapId(namespace: CodemapIdNamespace, rawId: string): string {
  const normalized = rawId.trim();
  if (!normalized) {
    throw new Error("rawId must not be empty");
  }
  return `${namespace}${CODEMAP_ID_SEPARATOR}${normalized}`;
}

export function isCodemapId(value: string, namespace?: CodemapIdNamespace): boolean {
  if (!value.includes(CODEMAP_ID_SEPARATOR)) {
    return false;
  }

  const [valueNamespace, rawId] = value.split(CODEMAP_ID_SEPARATOR, 2);
  if (!rawId) {
    return false;
  }

  return namespace ? valueNamespace === namespace : true;
}

export function makeHashedCodemapId(
  namespace: CodemapIdNamespace,
  parts: readonly string[]
): string {
  const payload = parts.join("\u0000");
  const hash = createHash("sha256").update(payload).digest("hex");
  return makeCodemapId(namespace, hash);
}

export function makeCodemapStorageBasename(value: string, extension: string): string {
  const normalizedExtension = extension.startsWith(".") ? extension : `.${extension}`;
  const hash = createHash("sha256").update(value).digest("hex");
  return `${hash}${normalizedExtension}`;
}
