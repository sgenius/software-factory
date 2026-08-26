# Legibility Rubric (default)

Read by both the Coder (write to this) and the Reviewer (check against this).
A finding that cites this rubric must point at a specific line, not a vibe.

Projects may override or extend this file per-project (see `projects/*.yaml`
`rubricOverrides`). Where a project override conflicts with a rule here, the
override wins.

## 1. Size
- A function/method body is **≤ 40 lines**, excluding blank lines and
  closing braces. Longer → extract a helper with a name that states intent.
- A file is **≤ 400 lines**. Longer → the file is doing more than one job;
  split it.
- A function takes **≤ 4 parameters**. More → pass a named options object.

## 2. Naming
- Names match the existing file's convention (`camelCase` vs `snake_case`
  vs `PascalCase`) — never mix within one file.
- No single-letter names except loop indices (`i`, `j`) and well-known math
  (`x`, `y`, `dx`). Everything else spells out what it holds.
- Booleans read as predicates: `isReady`, `hasErrors`, not `ready`, `errFlag`.
- No abbreviations that aren't already standard in the surrounding codebase
  (`cfg`, `req`, `resp` are fine if the file already uses them; don't invent
  new ones).

## 3. Control flow
- No nested ternaries. A ternary nested inside another ternary is a
  `blocking` finding — write an `if`/`else` or extract a function.
- Prefer early returns / guard clauses over deep `if` nesting. Max nesting
  depth: **3** (counting `if`/`for`/`while`/`try`, not braces).
- No clever one-liners that pack multiple side effects into a single
  expression (chained `&&`/`||` for control flow, multi-assignment
  one-liners). If it needs a comment to explain what it does, it's not
  legible — split it into named steps instead.
- In JavaScript/TypeScript, all `if` clauses must have brackets.
- One-liner `if`s are forbidden unless the file already includes them.

## 4. Structure & consistency
- New code matches the patterns already present in the file/module it's
  added to (error handling style, logging style, module layout) over
  importing a different pattern from elsewhere, even a "better" one.
  Cross-cutting pattern changes are a separate, explicitly planned task.
- No unplanned abstractions: don't introduce a base class, interface, or
  config layer for a single current use. Three concrete repetitions before
  extracting a shared abstraction.
- Dead code (commented-out blocks, unused exports, unreachable branches) is
  removed, not left "in case."

## 5. Comments
- Comments explain **why**, never **what** — the code already says what.
  A comment restating the next line in English is a `nit` finding.
- No comments about the task/fix/PR that produced the line ("added for the
  X flow", "fix for bug #123"). That belongs in the commit message.
- Every public function/exported symbol has a one-line summary of intent
  only if the name doesn't already make it obvious.
- Follow JSDoc where applicable.

## 6. Diff hygiene
- The diff touches only files listed in the Plan's `filesToTouch`
  (or a clearly-necessary adjacent file, e.g. a test file for changed
  logic) — unplanned scope creep is a `blocking` finding regardless of
  code quality.
- Formatting-only changes are not mixed into a diff that also changes
  behavior, unless the formatting is confined to lines already touched.

## Severity guide for the Reviewer
- **blocking**: violates §1, §3, or §6 in a way that would make the next
  reader (human or agent) misread the code's behavior, or the diff exceeds
  planned scope.
- **nit**: violates §2, §4, or §5, or a §1/§3 violation that's borderline
  and doesn't obscure behavior.
- **question**: the rubric doesn't clearly apply, but the intent isn't
  clear from the diff + Plan alone.
