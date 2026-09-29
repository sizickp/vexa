- **Jitsi: the bot leaves an emptied room (#9004).** On Jitsi the bridge keeps a departed participant's
  audio receiver live, so the bot's presence count never reached zero after everyone left; the
  deaf-capture guard read "streams but no audio" as its own capture fault and held the bot in the
  empty room until someone stopped it by hand. Presence on jitsi now comes from the app's own
  participant list (`features/base/participants`, minus fake/screenshare/hidden tiles) — the same
  store the dominant-speaker hint reads — so the everyone-left window runs and the bot completes
  with `left_alone` as on the other platforms. Sibling Vexa bots are not people: a bot announces
  itself in its Jitsi presence (`jitsi_participant_vexa_bot`) and the count leaves marked
  participants out — and, for bots that predate the marker, participants named like a Vexa bot
  (its own name or a product default) — so two deployments sent into the same call never hold each
  other in an emptied room.
