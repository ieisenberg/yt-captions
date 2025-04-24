import { z } from "zod";
import fs from "fs";
import path from "path";
import logger from "@yt-captions/utils/logger";

const configSchema = z.object({
  configurations: z.array(
    z.object({
      channel: z.string().min(1, "Channel name must not be empty"),
      channelId: z.string().optional(),
      includeLive: z.boolean().optional().default(false),
    })
  ),
});

export type Config = z.infer<typeof configSchema>["configurations"];

export const getConfig = (): Config => {
  const configPath = path.join(__dirname, "..", "config", "config.json");
  if (!fs.existsSync(configPath)) {
    logger.error(`Config file ${configPath} does not exist.`);
    process.exit(1);
  }
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const data = JSON.parse(raw);
    const result = configSchema.safeParse(data);
    if (!result.success) {
      logger.error(`Validation failed for ${configPath}:`);
      logger.error(result.error.format());
      process.exit(1);
    }
    return result.data.configurations;
  } catch (e) {
    logger.error(`Failed to read config file ${configPath}: ${e}`);
    process.exit(1);
  }
};

export const saveConfig = (config: Config) => {
  const configPath = path.join(__dirname, "..", "config", "config.json");
  // Sort configurations by channelId, then by channel name
  const sortedConfig = [...config].sort((a, b) => {
    const aKey = a.channelId || a.channel;
    const bKey = b.channelId || b.channel;
    return aKey.localeCompare(bKey);
  });
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        configurations: sortedConfig,
      },
      null,
      2
    )
  );
};
