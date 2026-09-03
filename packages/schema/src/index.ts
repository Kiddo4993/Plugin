import { createRequire } from "node:module";

// Loaded via createRequire (not a native JSON import) so this one module
// works unmodified in both the CJS and ESM builds tsup produces, with no
// import-attribute syntax version concerns for consumers.
const require = createRequire(import.meta.url);

/**
 * The JSON Schema (draft 2020-12) for a .thp.md spec's YAML frontmatter.
 * The markdown body below the frontmatter is free text and is not covered
 * by this schema.
 */
export const thpSpecSchema: Record<string, unknown> = require("../thp-spec.schema.json");

export const THP_SPEC_SCHEMA_ID = "https://raw.githubusercontent.com/thp/thp/main/packages/schema/thp-spec.schema.json";
