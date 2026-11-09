import { createBlock, serializeBlocks } from "../markdown/serialize.js";
import { detectSections } from "../markdown/sections.js";
import {
  contextForBlock,
  contextKey,
  documentSegments,
} from "../markdown/source-context.js";
import { assembleMerge, joinPieces } from "../markdown/merge.js";
export const draftSnapshot = (d) =>
  JSON.stringify({
    id: d.id,
    markdown: d.markdown,
    blocks: d.blocks,
    metadata: d.metadata,
  });
export function importedDraft(payload) {
  return {
    ...payload,
    blocks: payload.blocks
      ? structuredClone(payload.blocks)
      : [
          {
            ...createBlock("custom", { markdown: payload.markdown }),
            sourceContext: payload.metadata?.importSource || null,
          },
        ],
  };
}
export function contextAt(draft, start, end) {
  return contextResolver(draft)({ start, end });
}
export function contextResolver(draft) {
  const segments = documentSegments(draft);
  return ({ start, end }) => {
    const ranges = segments.filter(
      (s) =>
        s.end > start &&
        s.start < end &&
        s.source
          .slice(
            Math.max(start - s.start, 0),
            Math.min(end - s.start, s.source.length),
          )
          .trim(),
    );
    return ranges.every(
      (r) =>
        contextKey(r.sourceContext) === contextKey(ranges[0]?.sourceContext),
    )
      ? ranges.length
        ? ranges[0].sourceContext
        : draft.metadata?.importSource || null
      : { type: "mixed" };
  };
}
export function splitDraft(draft, levels = [1, 2]) {
  const context = contextResolver(draft);
  return detectSections(draft.markdown, { levels }).map((section) => ({
    ...createBlock("custom", { markdown: section.source }),
    separator: "",
    section: { title: section.title, kind: section.kind, level: section.level },
    sourceContext: context(section),
  }));
}
export function importPlan(current, payload, mode, merge) {
  const incoming = importedDraft(payload);
  if (["new", "replace"].includes(mode))
    return {
      blocks: incoming.blocks,
      metadata: structuredClone(incoming.metadata || {}),
      markdown: incoming.markdown,
    };
  const metadata = structuredClone(current.metadata || {});
  const source = incoming.metadata?.importSource;
  if (source) {
    if (
      !metadata.importSource ||
      (metadata.importSource.owner === source.owner &&
        metadata.importSource.repository === source.repository)
    ) {
      metadata.importSource = source;
      metadata.repository = incoming.metadata.repository;
    }
    metadata.importHistory = [
      ...(metadata.importHistory || []).slice(-9),
      source,
    ];
  }
  if (mode === "append") {
    const blocks = current.blocks.map((b) => ({
      ...structuredClone(b),
      sourceContext: contextForBlock(b, current.metadata),
    }));
    const joined = joinPieces([
      {
        side: "current",
        start: 0,
        end: current.markdown.length,
        source: current.markdown,
      },
      {
        side: "imported",
        start: 0,
        end: incoming.markdown.length,
        source: incoming.markdown,
      },
    ]);
    incoming.blocks.forEach((b, i) =>
      blocks.push({
        ...b,
        ...(i === 0 ? { separator: joined.pieces[1].prefix } : {}),
        sourceContext: contextForBlock(b, incoming.metadata),
      }),
    );
    if (!current.blocks.length && blocks[0]) blocks[0].separator = "";
    return { blocks, metadata, markdown: serializeBlocks(blocks) };
  }
  if (mode === "merge") {
    const assembled = assembleMerge(merge.comparison, merge.decisions);
    const contexts = {
      current: contextResolver(current),
      imported: contextResolver(incoming),
    };
    const blocks = assembled.pieces.map((piece) => ({
      ...createBlock("custom", { markdown: piece.source }),
      separator: piece.prefix,
      section: { title: piece.title, kind: piece.kind, level: piece.level },
      sourceContext: contexts[piece.side](piece),
    }));
    return { blocks, metadata, markdown: assembled.markdown };
  }
  throw new Error("Unknown import mode.");
}
