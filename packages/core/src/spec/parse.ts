import path from "node:path";
import { Document, LineCounter, parseDocument } from "yaml";
import type { ErrorObject } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { thpSpecSchema } from "@thp/schema";
import {
  SpecParseError,
  type ExpectedOutput,
  type SpecParseIssue,
  type TaskSpec,
  type TaskSpecBudget,
} from "../types.js";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSpec = ajv.compile(thpSpecSchema);

export interface ParseSpecOptions {
  /** Absolute (or workspace-relative) path this content came from, used to derive `id` and error messages. */
  sourcePath?: string;
}

/**
 * Parse a .thp.md file's raw text into a typed TaskSpec.
 *
 * Throws SpecParseError with one issue per problem, each naming the
 * offending field and its 1-based line/column in the source file — never a
 * generic parse failure.
 */
export function parseSpec(raw: string, options: ParseSpecOptions = {}): TaskSpec {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) {
    throw new SpecParseError([
      {
        field: "$root",
        message:
          "spec must start with a YAML frontmatter block delimited by '---' lines (e.g. '---\\ntaskType: bugfix\\n---')",
        line: 1,
        column: 1,
      },
    ]);
  }

  const yamlText = match[1] ?? "";
  const fullMatch = match[0];
  // yamlText's own line 1 is line 2 of the source file (line 1 is the opening '---').
  const lineOffset = 1;
  const body = raw.slice(fullMatch.length).replace(/^\r?\n/, "");

  const lineCounter = new LineCounter();
  const doc = parseDocument(yamlText, { lineCounter });

  if (doc.errors.length > 0) {
    const issues: SpecParseIssue[] = doc.errors.map((err) => {
      const offset = err.pos?.[0] ?? 0;
      const pos = lineCounter.linePos(offset);
      return {
        field: "$root",
        message: err.message,
        line: pos.line + lineOffset,
        column: pos.col,
      };
    });
    throw new SpecParseError(issues);
  }

  const data: unknown = doc.toJS() ?? {};

  const valid = validateSpec(data);
  if (!valid) {
    const issues = (validateSpec.errors ?? []).map((err) =>
      mapAjvError(err, doc, lineCounter, lineOffset),
    );
    throw new SpecParseError(issues);
  }

  const d = data as Record<string, unknown>;

  const spec: TaskSpec = {
    id: typeof d.id === "string" && d.id.length > 0 ? d.id : slugify(options.sourcePath),
    taskType: d.taskType as string,
    contextGlobs: (d.contextGlobs as string[] | undefined) ?? [],
    ...(typeof d.acceptance === "string" ? { acceptance: d.acceptance } : {}),
    constraints: (d.constraints as string[] | undefined) ?? [],
    ...(d.budget ? { budget: d.budget as TaskSpecBudget } : {}),
    ...(typeof d.pinnedProvider === "string" ? { pinnedProvider: d.pinnedProvider } : {}),
    expects: (d.expects as ExpectedOutput | undefined) ?? "diff",
    body,
    ...(options.sourcePath ? { sourcePath: options.sourcePath } : {}),
  };

  return spec;
}

function slugify(sourcePath: string | undefined): string {
  if (!sourcePath) {
    return "untitled-spec";
  }
  const base = path.basename(sourcePath).replace(/\.thp\.md$/i, "").replace(/\.md$/i, "");
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "untitled-spec";
}

/** Converts a dot-path's segments into a yaml Document.getIn path, coercing numeric segments to indices. */
function toYamlPath(segments: string[]): Array<string | number> {
  return segments.map((seg) => (/^\d+$/.test(seg) ? Number(seg) : seg));
}

/**
 * Walks from the full field path up to the document root, returning the
 * range of the first ancestor that actually exists in the parsed YAML.
 * This single walk handles both "the field is missing" (required) and
 * "the field exists but shouldn't" (additionalProperties) without special
 * casing: a missing field falls back to its parent's range; an existing
 * field is found on the first try.
 */
function findRangeForPath(
  doc: Document,
  fullPath: string[],
): readonly [number, number, number] | null {
  for (let i = fullPath.length; i >= 0; i--) {
    const prefix = toYamlPath(fullPath.slice(0, i));
    const node = prefix.length === 0 ? doc.contents : doc.getIn(prefix, true);
    if (node && typeof node === "object" && "range" in node) {
      const range = (node as { range?: readonly [number, number, number] | null }).range;
      if (range) {
        return range;
      }
    }
  }
  return null;
}

/** Finds the *key* node's range for an additionalProperties violation, so the error points at the offending key name rather than its value. */
function findAdditionalPropertyKeyRange(
  doc: Document,
  parentSegments: string[],
  key: string,
): readonly [number, number, number] | null {
  const parentPath = toYamlPath(parentSegments);
  const parentNode = parentPath.length === 0 ? doc.contents : doc.getIn(parentPath, true);
  if (parentNode && typeof parentNode === "object" && "items" in parentNode) {
    const items = (parentNode as { items: Array<{ key: unknown }> }).items;
    const pair = items.find((p) => {
      const k = p.key;
      if (k && typeof k === "object" && "value" in k) {
        return (k as { value: unknown }).value === key;
      }
      return k === key;
    });
    const keyNode = pair?.key;
    if (keyNode && typeof keyNode === "object" && "range" in keyNode) {
      const range = (keyNode as { range?: readonly [number, number, number] | null }).range;
      if (range) {
        return range;
      }
    }
  }
  return null;
}

function mapAjvError(
  err: ErrorObject,
  doc: Document,
  lineCounter: LineCounter,
  lineOffset: number,
): SpecParseIssue {
  const segments = err.instancePath ? err.instancePath.slice(1).split("/") : [];
  let fullPath: string[];
  let range: readonly [number, number, number] | null = null;

  if (err.keyword === "required") {
    const missing = String((err.params as { missingProperty?: string }).missingProperty ?? "");
    fullPath = [...segments, missing];
  } else if (err.keyword === "additionalProperties") {
    const extra = String((err.params as { additionalProperty?: string }).additionalProperty ?? "");
    fullPath = [...segments, extra];
    range = findAdditionalPropertyKeyRange(doc, segments, extra);
  } else {
    fullPath = segments;
  }

  const field = fullPath.join(".") || "$root";
  range ??= findRangeForPath(doc, fullPath);
  const offset = range ? range[0] : 0;
  const pos = lineCounter.linePos(offset);

  return {
    field,
    message: err.message ?? "is invalid",
    line: pos.line + lineOffset,
    column: pos.col,
  };
}
