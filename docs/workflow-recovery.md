# Workflow Recovery

This branch is the isolated recovery workspace for the workflow tree page.

## Baselines

- `workflow.html`: earlier single-workflow implementation already present in `main`. It uses `treeData`, calls `loadState()`, and is retained as the historical reference.
- `workflow.broken.html`: later multi-workflow desktop version preserved without modification.
  - Lines: 1696
  - Bytes: 68250
  - SHA-256: `38527c9b182a7ee34ed8039b4bb0477c640dad948f420189cb23da645c8897e3`

Do not overwrite either baseline during repair.

## Suspected regression boundary

The earlier version stores one tree in `treeData` and initializes with:

```text
loadState -> renderAll
```

The damaged version introduced `workflows[]`, `activeWorkflowId`, forced localStorage clearing, and `newWorkflow()` during startup. The repair should therefore treat the single-to-multiple workflow migration as the primary regression boundary.

## Repair order

1. Restore safe initialization and remove destructive startup reset.
2. Define and validate the multi-workflow data schema.
3. Restore persistence and migration from the earlier `wf_tree` format.
4. Repair node create, select, delete, copy, paste, and unique ID handling.
5. Restore tree rendering and parent-child connections.
6. Restore drag-and-drop through validated tree operations.
7. Unify single, cascade, and full-workflow execution lifecycle.
8. Restore condition node schema and true/false branch execution.
9. Separate API credentials from exported workflow packages.
10. Add regression fixtures and prepare the stable version for integration.

## Change discipline

- One repair concern per commit.
- Validate page startup after every commit.
- Do not mix schema migration, UI changes, and executor changes in one commit.
- Do not commit API keys, local conversation data, or exported user workflows.
- Keep `main` unchanged until the recovery branch passes the full regression checklist.

## Minimum regression checklist

```text
open page
-> create workflow
-> create nested nodes
-> edit properties
-> save and reload
-> move nodes
-> copy and paste subtree
-> export and import
-> run one node
-> run cascade
-> cancel execution
-> evaluate true/false condition branches
```
