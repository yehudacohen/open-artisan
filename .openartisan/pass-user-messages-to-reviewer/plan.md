# Plan: pass-user-messages-to-reviewer

## Goal
Pass user's original request messages to the self-reviewer so it can better evaluate "Vision alignment" quality criteria.

## Problem
Currently the reviewer only sees the artifact and acceptance criteria - not what the user actually asked for. This makes it hard to assess whether the artifact addresses the user's original intent.

## Solution
1. Add `userMessages` field to `SelfReviewRequest` interface in self-review.ts
2. Pass user messages from the session when calling dispatchSelfReview
3. Include user messages in the review prompt

## Scope
- Modify: self-review.ts
- Add: userMessages parameter to SelfReviewRequest
- Pass: user messages in the review prompt

## Out of scope
- Other reviewers (auto-approve, task-review)
- Changing the quality criteria scoring
