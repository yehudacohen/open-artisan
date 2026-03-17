# Interface: None required

This is a one-line bug fix in index.ts that adds auto-reset from DONE to MODE_SELECT when select_mode is called at DONE phase.

```typescript
// Added to select_mode tool handler:
// If at DONE, reset to MODE_SELECT to allow starting a fresh workflow
if (state.phase === "DONE") {
  await store.update(sessionId, (draft) => {
    draft.phase = "MODE_SELECT"
    draft.phaseState = "DRAFT"
    // ... reset other fields
  })
  // then proceed with normal select_mode logic
}
```

No new interfaces, types, or schemas needed.