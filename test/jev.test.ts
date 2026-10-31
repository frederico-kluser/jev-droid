import assert from "node:assert/strict";
import test from "node:test";
import {
  bandFor,
  DEFAULT_THRESHOLDS,
  validateRequest,
  validateResponse,
  type DecisionsRequest,
  type DecisionsResponse,
} from "../src/jev.js";

const REQUEST: DecisionsRequest = {
  model: "typesafe/jev-1.13",
  state: "Checkout shows a blank screen after clicking Pay.",
  questions: {
    is_bug: { type: "noul", instructions: "Is this a bug?", criteria: { true: "yes", false: "no" } },
    team: {
      type: "choice",
      instructions: "Which team?",
      criteria: { frontend: "UI", payments: "checkout", other: "none" },
    },
    urgency: { type: "score", instructions: "How urgent?", criteria: ["wait", "this week", "revenue blocked"] },
  },
};

test("valid request has no errors", () => {
  assert.deepEqual(validateRequest(REQUEST), []);
});

test("choice needs at least two options", () => {
  const errors = validateRequest({
    ...REQUEST,
    questions: { bad: { type: "choice", instructions: "x", criteria: { only: "one" } } },
  });
  assert.ok(errors.some((error) => error.includes("at least 2")));
});

test("score needs 2..10 concrete levels", () => {
  const errors = validateRequest({
    ...REQUEST,
    questions: { bad: { type: "score", instructions: "x", criteria: ["only one"] } },
  });
  assert.ok(errors.some((error) => error.includes("2..10")));
});

test("noul criteria requires both true and false", () => {
  const errors = validateRequest({
    ...REQUEST,
    questions: { bad: { type: "noul", instructions: "x", criteria: { true: "yes" } } },
  });
  assert.ok(errors.some((error) => error.includes("both")));
});

test("bands follow certainty and confidence", () => {
  assert.equal(bandFor({ type: "noul", noul: 0.96 }, DEFAULT_THRESHOLDS).band, "auto");
  assert.equal(bandFor({ type: "noul", noul: 0.7 }, DEFAULT_THRESHOLDS).band, "hitl");
  assert.equal(bandFor({ type: "noul", noul: 0.5 }, DEFAULT_THRESHOLDS).band, "hitl");
  assert.equal(bandFor({ type: "choice", choice: "payments", probabilities: { payments: 0.97 }, confidence: 0.97 }).band, "auto");
  assert.equal(bandFor({ type: "choice", choice: "payments", probabilities: { payments: 0.6 }, confidence: 0.6 }).band, "hitl");
  assert.equal(bandFor({ type: "choice", choice: "payments", probabilities: { payments: 0.4 }, confidence: 0.4 }).band, "abstain");
});

test("validateResponse rejects unknown choice options", () => {
  const response: DecisionsResponse = {
    answers: {
      is_bug: { type: "noul", noul: 0.9 },
      team: { type: "choice", choice: "billing", probabilities: { billing: 1 }, confidence: 1 },
      urgency: { type: "score", score: 2, probabilities: { "2": 1 }, confidence: 1 },
    },
  };
  assert.throws(() => validateResponse(REQUEST, response), /unknown option/);
});

test("validateResponse produces decisions and warnings", () => {
  const response: DecisionsResponse = {
    answers: {
      is_bug: { type: "noul", noul: 0.96 },
      team: { type: "choice", choice: "payments", probabilities: { payments: 0.8 }, confidence: 0.8 },
      urgency: { type: "score", score: 2, probabilities: { "2": 0.9 }, confidence: 0.9 },
    },
  };
  const result = validateResponse(REQUEST, response);
  assert.equal(result.decisions.is_bug?.band, "auto");
  assert.equal(result.decisions.team?.value, "payments");
  assert.equal(result.decisions.urgency?.value, 2);
  assert.ok(result.warnings.length > 0);
});
