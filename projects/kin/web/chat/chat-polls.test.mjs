import assert from "node:assert/strict";
import test from "node:test";
import { choiceOf, encodePoll, MAX_POLL_OPTIONS, parsePoll, pollProblem, tally } from "./chat-polls.js";

test("a poll needs a question and two to ten different, filled options", () => {
  assert.equal(pollProblem({ question: "Pizza?", options: ["Yes", "No"] }), null);
  assert.equal(pollProblem({ question: "Pizza?", options: Array.from({ length: MAX_POLL_OPTIONS }, (_, n) => `o${n}`) }), null);
  for (const [bad, pattern] of [
    [{ question: "  ", options: ["a", "b"] }, /question/i],
    [{ question: "Q", options: ["a"] }, /two/i],
    [{ question: "Q", options: Array.from({ length: 11 }, (_, n) => `o${n}`) }, /up to 10/],
    [{ question: "Q", options: ["a", " "] }, /every option/i],
    [{ question: "Q", options: ["a", "A "] }, /different/i],
    [{ question: "Q\u0000", options: ["a", "b"] }, /can't be sent/],
    [{ question: "Q", options: ["a", "b\u0007"] }, /can't be sent/],
    [{ question: "x".repeat(201), options: ["a", "b"] }, /200/],
    [{ question: "Q", options: ["a", "y".repeat(81)] }, /80/],
    [{ question: "Q", options: "ab" }, /two/i],
  ]) assert.match(pollProblem(bad) ?? "", pattern, JSON.stringify(bad).slice(0, 60));
});

test("a poll's blob round-trips and anything else is refused", () => {
  const poll = { question: " Pizza or tacos? ", options: ["Pizza ", "Tacos"] };
  const text = encodePoll(poll);
  assert.deepEqual(parsePoll(text, 2), { question: "Pizza or tacos?", options: ["Pizza", "Tacos"] });
  assert.equal(parsePoll(text, 3), null, "the option count must be the one the engine holds");
  for (const bad of ["", "not json", "[]", "{}", JSON.stringify({ v: 2, q: "Q", o: ["a", "b"] }), JSON.stringify({ v: 1, q: "Q", o: ["a", "b"], extra: 1 }),
    JSON.stringify({ v: 1, q: " Q", o: ["a", "b"] }), JSON.stringify({ v: 1, q: "Q", o: ["a", "a"] }), JSON.stringify({ v: 1, q: 5, o: ["a", "b"] })])
    assert.equal(parsePoll(bad, 2), null, bad);
});

test("votes are tallied per option with who chose it", () => {
  const poll = { options: 3, multiple: true, closed: false, votes: [{ memberId: "a", choice: [0, 2] }, { memberId: "b", choice: [2] }] };
  assert.deepEqual(tally(poll), [{ count: 1, voters: ["a"] }, { count: 0, voters: [] }, { count: 2, voters: ["a", "b"] }]);
  assert.deepEqual(choiceOf(poll, "a"), [0, 2]);
  assert.deepEqual(choiceOf(poll, "z"), []);
  assert.deepEqual(choiceOf(null, "a"), []);
});
