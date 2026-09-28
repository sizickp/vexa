- **Jitsi: the bot leaves an emptied room (#9004).** On Jitsi the bridge keeps a departed participant's
  audio receiver live, so the bot's presence count never reached zero after everyone left; the
  deaf-capture guard read "streams but no audio" as its own capture fault and held the bot in the
  empty room until someone stopped it by hand. Presence on jitsi now comes from the app's own
  participant list (`features/base/participants`, minus fake/screenshare/hidden tiles) — the same
  store the dominant-speaker hint reads — so the everyone-left window runs and the bot completes
  with `left_alone` as on the other platforms.
