import { getConfig } from "@yt-captions/utils/config";
import { Innertube, UniversalCache, YTNodes } from "youtubei.js";
import logger from "@yt-captions/utils/logger";

const config = getConfig();

const yt = await Innertube.create({
  cache: new UniversalCache(true, "./.cache"),
  enable_session_cache: true,
  generate_session_locally: true,
});

for (const channel of config) {
  if (channel.channel.includes("@")) {
    const searchResult = await yt.search(channel.channel, {
      type: "channel",
      sort_by: "relevance",
    });
    const channelId = searchResult.channels.find((c) =>
      c.endpoint.toURL()?.endsWith(channel.channel)
    )?.id;
    if (!channelId) {
      logger.error(
        `Could not find channel ${channel.channel} in search results`
      );
      continue;
    }
    channel.channel = channelId;
  }
}
