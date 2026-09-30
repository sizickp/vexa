- **The worker knows the deployment's gateway (#9007).** agent-api now stamps `VEXA_GATEWAY_URL`
  — the address it reaches the gateway by itself — into every dispatch env, and the post-meeting
  kick reads the transcript through it instead of the compose-only hostname `gateway:8000`. On a
  k8s deployment that name does not resolve inside the worker Pod, so the turn could never read
  the meeting and `process_meeting` refused every report as "the agent did not read the meeting".
