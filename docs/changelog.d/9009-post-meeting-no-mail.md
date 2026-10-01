- **The post-meeting report is no longer mailed (#9009).** The stock `post_meeting` flow (now
  version 6) is `retranscribe` → `process_meeting` → `drop_to_attendees`: the report lands on every
  desk in the room and leaves the deployment by mail to nobody. Whether minutes are mailed is
  decided by the flow's step list, not by a mail transport being configured, so configuring one
  for another purpose sends no minutes. `email_minutes` and `email_attendees` stay in the step
  vocabulary for a flow that wants them. See [Flows](/flows/overview).
