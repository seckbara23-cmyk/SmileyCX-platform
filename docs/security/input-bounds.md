# Input bounds before validation

**Classification:** Internal — Security
**Date:** 2026-11-02
**Status:** Implemented, awaiting review
**Related:** [SEC-3 DevSecOps](./sec-3-devsecops.md)

---

Four learner-facing server actions accept arrays or records whose size the client controls: saving AI practice turns, saving a self-assessment, submitting quiz answers and submitting an exercise. Each now refuses input larger than it could legitimately receive before handing it to schema validation.

## Why

Schema validation walks the whole input. A deliberately large or deep payload makes that walk, and the work after it, cost far more than the request is worth, before any identity or ownership check has run. Bounding the input first keeps that cost proportional to what a real learner can send.

## What it does

`lib/validation/input-bounds.ts` exports `withinInputBounds(value, bounds)`. It walks the value iteratively, counting nodes, depth and characters, and stops at the first bound crossed. It refuses a key that names the prototype (`__proto__`, `constructor`, `prototype`), and it never throws on what a client can send, which is plain JSON. Each action declares its own bounds beside the schema it protects, generous for every legitimate payload and small against the rest. A refused request gets the same generic error as any invalid one.

## Where

| Action | File | Bounds |
|---|---|---|
| Save practice turns | `app/actions/ai-practice.ts` | 600 nodes, depth 3, 810 000 characters |
| Save a self-assessment | `app/actions/ai-practice.ts` | 300 nodes, depth 2, 100 000 characters |
| Submit quiz answers | `app/actions/quiz.ts` | 5 000 nodes, depth 4, 512 000 characters |
| Submit an exercise | `app/actions/exercise.ts` | 1 000 nodes, depth 3, 80 000 characters |

Tests: `__tests__/security/input-bounds.test.ts` covers the walk, each bound, the largest legitimate payloads, oversized and deep input, and the order of the check in each action.

## What it does not do

It does not replace validation, change any schema, or touch authentication. It bounds size only; what the input means is still decided by the schema and the action.

Its premise is Zod 3, which keeps one issue for every failing element and does not stop early. A migration to Zod 4 should revisit the bounds and the test's error-map instrument.
