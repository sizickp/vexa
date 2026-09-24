- **Yandex Telemost meetings: send a bot to a `telemost.yandex.ru/j/<id>` link.** A new `telemost`
  platform joins Telemost calls as a guest through the web client, captures the call audio on the mixed
  lane and names speakers from the call's speaking tiles. Links are recognised by the API, MCP
  `parse_meeting_link`, the Terminal and forwarded invites. Join, speaker names and audio capture are
  witnessed live; an end-to-end transcript run on a deployed stack is pending. See
  [Meetings API](/api/meetings).
