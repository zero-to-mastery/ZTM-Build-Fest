import {
  blockLabel,
  isRestorable,
  ownershipKind,
  readDetachments,
} from "./source-patch.js";
import { generatedRegistry } from "../generated/registry.js";
import { isBuilderBlockType } from "./block-types.js";
import { serializeBlock } from "./serialize.js";

const source = (block) => {
  try {
    const markdown = serializeBlock(block);
    if (typeof markdown !== "string") throw Error();
    return markdown;
  } catch {
    throw Error("The visual version cannot be serialized safely.");
  }
};

const plan = (current, proposedBlock, record, label, kind) => ({
  targetBlockId: current.id,
  recordId: record?.id || null,
  recordSnapshot: record ? JSON.stringify(record) : null,
  label,
  kind,
  original: source(current),
  proposed: source(proposedBlock),
  proposedBlock: structuredClone(proposedBlock),
});

const generatedIdsFor = (draft, blocks) => {
  try {
    return new Set(
      generatedRegistry({
        blocks,
        metadata: draft.metadata,
      }).flatMap((unit) => [
        ...(unit.blockId ? [unit.blockId] : []),
        ...(Array.isArray(unit.blockIds) ? unit.blockIds : []),
      ]),
    );
  } catch {
    return null;
  }
};

const visualOwnershipKind = (draft, block) => {
  const generatedIds = generatedIdsFor(draft, [block]);
  return generatedIds
    ? ownershipKind(block, draft.metadata, generatedIds)
    : null;
};

const validVisualCopy = (draft, record) => {
  const previous = record.previous;
  if (
    !previous ||
    typeof previous.id !== "string" ||
    previous.id !== record.previousBlockIds[0] ||
    !previous.settings ||
    typeof previous.settings !== "object" ||
    record.labels.length !== 1 ||
    record.kinds.length !== 1 ||
    visualOwnershipKind(draft, previous) !== record.kinds[0]
  )
    return false;
  return record.kinds[0] === "component"
    ? previous.type === "component"
    : isBuilderBlockType(previous.type);
};

function reviewRecord(draft, recordId, snapshot = null, targetBlockId = null) {
  const matches = Array.isArray(draft.metadata?.detachments)
    ? draft.metadata.detachments.filter((record) => record?.id === recordId)
    : [];
  if (!matches.length)
    throw Error("This Detachment record is no longer available.");
  if (matches.length !== 1)
    throw Error("This Detachment record has a duplicate identity.");
  const record = matches[0];
  if (!isRestorable(record))
    throw Error(
      "This Detachment record is not Restorable. Keep the current Markdown or use Undo when it is still available.",
    );
  if (!validVisualCopy(draft, record))
    throw Error("This Detachment record has an invalid visual version.");
  if (targetBlockId && record.blockId !== targetBlockId)
    throw Error(
      "This Detachment record changed while Ownership review was open.",
    );
  if (snapshot && JSON.stringify(record) !== snapshot)
    throw Error(
      "This Detachment record changed while Ownership review was open.",
    );
  return record;
}

const verifyReviewRecord = (draft, review) =>
  review.recordId
    ? reviewRecord(
        draft,
        review.recordId,
        review.recordSnapshot,
        review.targetBlockId,
      )
    : null;

const verifyReviewOwner = (draft, review) => {
  const current = draft.blocks.find(
    (block) => block.id === review.targetBlockId,
  );
  const invalidCurrent = review.recordId
    ? current &&
      (current.type !== "custom" ||
        visualOwnershipKind(draft, current) !== null)
    : current && visualOwnershipKind(draft, current) !== review.kind;
  if (
    invalidCurrent ||
    visualOwnershipKind(draft, review.proposedBlock) !== review.kind
  )
    throw Error(
      "This section's owner uses a separate reviewed flow. Its Markdown remains unchanged; reopen the current section.",
    );
};

export function ownershipReviewForEdit(draft, openedBlock, proposedBlock) {
  const current = draft.blocks.find((block) => block.id === openedBlock.id);
  if (
    current &&
    current.type === openedBlock.type &&
    source(current) === source(openedBlock)
  )
    return null;
  if (current) {
    const expected = openedBlock.type === "component" ? "component" : "builder";
    if (
      [openedBlock, current, proposedBlock].some(
        (block) => visualOwnershipKind(draft, block) !== expected,
      )
    )
      throw Error(
        "This section's owner uses a separate reviewed flow. Its Markdown remains unchanged; reopen the current section.",
      );
    return plan(
      current,
      proposedBlock,
      null,
      blockLabel(openedBlock),
      openedBlock.type === "component" ? "component" : "builder",
    );
  }

  const record = readDetachments(draft.metadata).findLast(
    (item) =>
      item.previousBlockIds.includes(openedBlock.id) &&
      draft.blocks.some((block) => block.id === item.blockId),
  );
  if (!record)
    throw Error(
      "This visual section was detached or removed. Its Markdown remains unchanged; reopen the current section.",
    );
  const resolved = reviewRecord(draft, record.id);
  if (visualOwnershipKind(draft, proposedBlock) !== resolved.kinds[0])
    throw Error(
      "This section's owner uses a separate reviewed flow. Its Markdown remains unchanged; reopen the current section.",
    );
  const review = plan(
    draft.blocks.find((block) => block.id === resolved.blockId),
    proposedBlock,
    resolved,
    resolved.labels[0] || blockLabel(openedBlock),
    resolved.kinds[0],
  );
  verifyReviewOwner(draft, review);
  return review;
}

export function ownershipReviewForRecord(draft, recordId) {
  const record = reviewRecord(draft, recordId);
  const current = draft.blocks.find((block) => block.id === record.blockId);
  if (!current)
    throw Error("This detached section is no longer available for review.");
  const review = plan(
    current,
    record.previous,
    record,
    record.labels[0] || blockLabel(record.previous),
    record.kinds[0],
  );
  verifyReviewOwner(draft, review);
  return review;
}

export function refreshOwnershipReview(draft, review) {
  verifyReviewRecord(draft, review);
  verifyReviewOwner(draft, review);
  const current = draft.blocks.find(
    (block) => block.id === review.targetBlockId,
  );
  if (!current)
    throw Error(
      "The reviewed section changed again. Close Ownership review and reopen the current section.",
    );
  return {
    ...review,
    original: source(current),
    proposed: source(review.proposedBlock),
  };
}

export function applyOwnershipReview(draft, review) {
  const record = verifyReviewRecord(draft, review);
  verifyReviewOwner(draft, review);
  const blocks = structuredClone(draft.blocks);
  const index = blocks.findIndex((block) => block.id === review.targetBlockId);
  if (index < 0)
    throw Error(
      "The reviewed section changed again. Nothing was applied; reopen the current section.",
    );
  const current = blocks[index];
  const proposed = structuredClone(review.proposedBlock);
  if (
    blocks.some(
      (block, blockIndex) => blockIndex !== index && block.id === proposed.id,
    )
  )
    throw Error(
      "The visual version conflicts with another section identity. Nothing was applied.",
    );
  if (current.separator === undefined) delete proposed.separator;
  else proposed.separator = current.separator;
  blocks[index] = proposed;

  const metadata = { ...draft.metadata };
  if (record && Array.isArray(metadata.detachments)) {
    const index = metadata.detachments.indexOf(record);
    metadata.detachments = [
      ...metadata.detachments.slice(0, index),
      ...metadata.detachments.slice(index + 1),
    ];
  }
  return { blocks, metadata };
}
