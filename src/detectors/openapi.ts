/**
 * OpenAPI / Swagger spec ingestion.
 * Parses openapi.yaml, openapi.json, swagger.yaml, swagger.json and extracts
 * routes (paths + methods) and schema models (components/schemas, definitions).
 */

import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { RouteInfo, SchemaModel, SchemaField, ProjectInfo } from "../types.js";

const SPEC_FILENAMES = [
  "openapi.yaml", "openapi.yml", "openapi.json",
  "swagger.yaml", "swagger.yml", "swagger.json",
  "api.yaml", "api.yml", "api.json",
  "spec.yaml", "spec.yml", "spec.json",
];

const SEARCH_DIRS = ["", "docs", "api", "src", "spec", "openapi", "swagger"];

export interface OpenAPIResult {
  routes: RouteInfo[];
  schemas: SchemaModel[];
  specFile: string | null;
}

export async function detectOpenAPISpec(
  root: string,
  project: ProjectInfo
): Promise<OpenAPIResult> {
  // Try to find spec file
  let specContent: string | null = null;
  let specFile: string | null = null;

  outer: for (const dir of SEARCH_DIRS) {
    for (const name of SPEC_FILENAMES) {
      const fullPath = dir ? join(root, dir, name) : join(root, name);
      try {
        const content = await readFile(fullPath, "utf-8");
        if (content.includes("openapi") || content.includes("swagger")) {
          specContent = content;
          specFile = relative(root, fullPath).replace(/\\/g, "/");
          break outer;
        }
      } catch {
        // File doesn't exist, try next
      }
    }
  }

  if (!specContent || !specFile) {
    return { routes: [], schemas: [], specFile: null };
  }

  // Parse — support both JSON and YAML (minimal YAML parser for our use case)
  let spec: any = null;
  try {
    spec = JSON.parse(specContent);
  } catch {
    spec = parseMinimalYAML(specContent);
  }

  if (!spec || typeof spec !== "object") {
    return { routes: [], schemas: [], specFile };
  }

  const routes: RouteInfo[] = [];
  const schemas: SchemaModel[] = [];

  // Extract routes from paths
  const paths = spec.paths || {};
  for (const [path, pathItem] of Object.entries(paths as Record<string, any>)) {
    if (!pathItem || typeof pathItem !== "object") continue;

    const httpMethods = ["get", "post", "put", "patch", "delete", "options", "head"];
    for (const method of httpMethods) {
      const operation = pathItem[method];
      if (!operation) continue;

      const tags: string[] = [];
      if (operation.tags) tags.push(...operation.tags.map((t: string) => t.toLowerCase()));
      if (path.includes("/auth") || path.includes("/login")) tags.push("auth");
      if (path.includes("/payment") || path.includes("/checkout")) tags.push("payment");

      // Extract request/response types
      let requestType: string | undefined;
      let responseType: string | undefined;

      const requestBody = operation.requestBody;
      if (requestBody?.content?.["application/json"]?.schema) {
        const schema = requestBody.content["application/json"].schema;
        requestType = extractSchemaRef(schema);
      }

      const responses = operation.responses || {};
      const successResponse = responses["200"] || responses["201"] || responses["202"];
      if (successResponse?.content?.["application/json"]?.schema) {
        const schema = successResponse.content["application/json"].schema;
        responseType = extractSchemaRef(schema);
      }

      // Normalize path params: {id} -> :id
      const normalizedPath = path.replace(/\{(\w+)\}/g, ":$1");
      const params = (path.match(/\{(\w+)\}/g) || []).map((p: string) => p.slice(1, -1));

      routes.push({
        method: method.toUpperCase(),
        path: normalizedPath,
        file: specFile,
        tags,
        framework: project.frameworks[0] ?? "raw-http",
        requestType,
        responseType,
        params: params.length > 0 ? params : undefined,
        confidence: "ast",
      });
    }
  }

  // Extract schemas from components.schemas (OpenAPI 3.x) or definitions (Swagger 2.x)
  const schemaMap = spec.components?.schemas || spec.definitions || {};
  for (const [name, schemaDef] of Object.entries(schemaMap as Record<string, any>)) {
    if (!schemaDef || typeof schemaDef !== "object") continue;

    const fields: SchemaField[] = [];
    const required = new Set<string>(schemaDef.required || []);

    const props = schemaDef.properties || {};
    for (const [fieldName, fieldDef] of Object.entries(props as Record<string, any>)) {
      if (!fieldDef) continue;
      const type = resolveFieldType(fieldDef);
      const flags: string[] = [];
      if (required.has(fieldName)) flags.push("required");
      if (fieldDef.readOnly) flags.push("readonly");
      if (fieldDef.format === "uuid") flags.push("uuid");
      fields.push({ name: fieldName, type, flags });
    }

    if (fields.length > 0 || schemaDef.type === "object") {
      schemas.push({
        name,
        file: specFile,
        fields,
        relations: [],
        orm: "unknown",
        confidence: "ast",
      });
    }
  }

  return { routes, schemas, specFile };
}

function extractSchemaRef(schema: any): string | undefined {
  if (!schema) return undefined;
  if (schema.$ref) {
    return schema.$ref.split("/").pop();
  }
  if (schema.type === "array" && schema.items?.$ref) {
    return `${schema.items.$ref.split("/").pop()}[]`;
  }
  if (schema.type) return schema.type;
  return undefined;
}

function resolveFieldType(fieldDef: any): string {
  if (!fieldDef) return "unknown";
  if (fieldDef.$ref) return fieldDef.$ref.split("/").pop() ?? "ref";
  if (fieldDef.type === "array") {
    const itemType = fieldDef.items?.$ref
      ? fieldDef.items.$ref.split("/").pop()
      : fieldDef.items?.type || "any";
    return `${itemType}[]`;
  }
  if (fieldDef.format) return `${fieldDef.type}(${fieldDef.format})`;
  return fieldDef.type || "unknown";
}

/**
 * Minimal YAML parser — handles flat key:value and nested objects/arrays
 * sufficient for OpenAPI specs. Not a full YAML parser.
 */
function parseMinimalYAML(yaml: string): any {
  // For simplicity, handle the most common OpenAPI YAML patterns
  const lines = yaml.split("\n");
  return parseYAMLBlock(lines, 0, 0).value;
}

function parseYAMLBlock(
  lines: string[],
  startIdx: number,
  baseIndent: number
): { value: any; nextIdx: number } {
  const obj: Record<string, any> = {};
  let i = startIdx;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Skip comments and blank lines
    if (!trimmed || trimmed.startsWith("#")) {
      i++;
      continue;
    }

    const indent = line.length - trimmed.length;

    // We've exited our block
    if (indent < baseIndent) break;

    // Skip deeper blocks we already processed
    if (indent > baseIndent) {
      i++;
      continue;
    }

    // List item
    if (trimmed.startsWith("- ")) {
      // Return array handling to caller
      break;
    }

    // Key: value
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) {
      i++;
      continue;
    }

    const key = trimmed.slice(0, colonIdx).trim();
    const rawValue = trimmed.slice(colonIdx + 1).trim();

    if (rawValue && rawValue !== "|" && rawValue !== ">") {
      // Inline value
      obj[key] = parseYAMLScalar(rawValue);
      i++;
    } else {
      // Check next line for nested content
      const nextLineIdx = i + 1;
      if (nextLineIdx < lines.length) {
        const nextTrimmed = lines[nextLineIdx].trimStart();
        const nextIndent = lines[nextLineIdx].length - nextTrimmed.length;
        if (nextIndent > baseIndent) {
          if (nextTrimmed.startsWith("- ")) {
            // Array block
            const arr: any[] = [];
            let j = nextLineIdx;
            while (j < lines.length) {
              const lt = lines[j].trimStart();
              const li = lines[j].length - lt.length;
              if (li < nextIndent) break;
              if (lt.startsWith("- ")) {
                arr.push(parseYAMLScalar(lt.slice(2).trim()));
              }
              j++;
            }
            obj[key] = arr;
            i = j;
          } else {
            // Nested object
            const nested = parseYAMLBlock(lines, nextLineIdx, nextIndent);
            obj[key] = nested.value;
            i = nested.nextIdx;
          }
        } else {
          obj[key] = null;
          i++;
        }
      } else {
        obj[key] = null;
        i++;
      }
    }
  }

  return { value: obj, nextIdx: i };
}

function parseYAMLScalar(s: string): any {
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if (!isNaN(Number(s)) && s !== "") return Number(s);
  // Strip quotes
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
