import type { DispatchContext, TaskSpec } from "../types.js";

/**
 * Builds the single prompt string sent to every provider. Shared across all
 * three adapters because the shape (constraints, then context files, then
 * the task body) is identical for each — this is not a speculative
 * abstraction, it has three real call sites today.
 */
export function buildPrompt(spec: TaskSpec, ctx: DispatchContext): string {
  const sections: string[] = [];

  if (spec.constraints.length > 0) {
    sections.push(`Constraints:\n${spec.constraints.map((c) => `- ${c}`).join("\n")}`);
  }

  if (ctx.resolvedContextFiles.length > 0) {
    const files = ctx.resolvedContextFiles
      .map((f) => `--- ${f.path} ---\n${f.content}`)
      .join("\n\n");
    sections.push(`Context files:\n${files}`);
  }

  sections.push(`Task:\n${spec.body}`);

  return sections.join("\n\n");
}
