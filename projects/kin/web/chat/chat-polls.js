// Quick polls (#135): what a poll's content blob holds and the rules for it.
// The question and options live in a blob like message text, so deleting the
// poll for everyone deletes them. The engine only knows how many options a
// poll has and whether several may be chosen (wasm/kin-engine.js); it checks
// every vote against that.

export const MIN_POLL_OPTIONS = 2;
export const MAX_POLL_OPTIONS = 10;
export const MAX_POLL_QUESTION_CHARS = 200;
export const MAX_POLL_OPTION_CHARS = 80;

const hasControl = (text) => /\p{Cc}/u.test(text);
const letters = (text) => Array.from(text).length;

/** Why this question and these options can't be a poll, or null. */
export function pollProblem({ question, options }) {
  if (typeof question !== "string" || !question.trim()) return "Ask a question first.";
  if (!question.isWellFormed() || hasControl(question)) return "That question can't be sent.";
  if (letters(question.trim()) > MAX_POLL_QUESTION_CHARS) return `Keep the question to ${MAX_POLL_QUESTION_CHARS} characters.`;
  if (!Array.isArray(options)) return "Add at least two options.";
  const filled = options.map((option) => (typeof option === "string" ? option.trim() : ""));
  if (filled.some((option) => !option)) return "Fill in every option, or remove the empty ones.";
  if (filled.length < MIN_POLL_OPTIONS) return "Add at least two options.";
  if (filled.length > MAX_POLL_OPTIONS) return `A poll can have up to ${MAX_POLL_OPTIONS} options.`;
  if (filled.some((option) => !option.isWellFormed() || hasControl(option))) return "That option can't be sent.";
  if (filled.some((option) => letters(option) > MAX_POLL_OPTION_CHARS)) return `Keep each option to ${MAX_POLL_OPTION_CHARS} characters.`;
  if (new Set(filled.map((option) => option.toLowerCase())).size !== filled.length) return "Each option should be different.";
  return null;
}

/** The text sealed as the poll's blob. */
export function encodePoll({ question, options }) {
  return JSON.stringify({ v: 1, q: question.trim(), o: options.map((option) => option.trim()) });
}

/** The question and options in a poll blob, or null if it isn't one this
 * poll (with `optionCount` options, as the engine says) can have. */
export function parsePoll(text, optionCount) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || value.v !== 1 || typeof value.q !== "string" || !Array.isArray(value.o) ||
    Object.keys(value).length !== 3 || value.o.length !== optionCount) return null;
  const poll = { question: value.q, options: value.o };
  if (pollProblem(poll) !== null || poll.question !== poll.question.trim() || poll.options.some((option) => option !== option.trim())) return null;
  return poll;
}

/** One member's choice as the sorted option numbers it holds. */
export function choiceOf(poll, memberId) {
  return poll?.votes?.find((vote) => vote.memberId === memberId)?.choice ?? [];
}

/** Per option: how many chose it and who. */
export function tally(poll) {
  const rows = Array.from({ length: poll.options }, () => ({ count: 0, voters: [] }));
  for (const vote of poll.votes) for (const option of vote.choice) {
    rows[option].count += 1;
    rows[option].voters.push(vote.memberId);
  }
  return rows;
}
