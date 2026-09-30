- **k8s: the `_global` tier reaches the worker Pod (#9005).** On the k8s backend a mount with its own
  source was always skipped, so a deployment that keeps the GLOBAL SYSTEM tier on the workspace PVC
  (`<store>/_global`, the path agent-api names as `GLOBAL_SYSTEM_WORKSPACE_PATH`) ran every turn
  without platform behaviour, prompts or mail templates. A source that lives inside the store is now
  exposed like any other in-store mount — a read-only `subPath` of the one workspace PVC. A source
  outside the store is still skipped: hostPath volumes are never emitted.
