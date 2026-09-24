- **A deployment without mail still gets post-meeting reports onto desks.** When no mail transport
  is configured, `email_minutes` and `email_attendees` complete as skipped instead of failing the
  reaction; a configured transport that keeps failing is retried to the attendee-mail ceiling and then
  given up on, recorded as `failed`. Either way `drop_to_attendees` runs and the report reaches every
  desk in the room.
