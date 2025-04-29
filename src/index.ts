import fs from 'fs'
import { getConfig, saveConfig, type Config } from '@yt-captions/utils/config'
import { Innertube, UniversalCache, YT, YTNodes } from 'youtubei.js'
import logger from '@yt-captions/utils/logger'
import pRetry from 'p-retry'
import pLimit from 'p-limit'
import path from 'path'

logger.level = 'error'

const CAPTIONS_FOLDER = './captions'
const SKIPLIST_FILE = path.join(CAPTIONS_FOLDER, 'skiplist.json')

type Video = {
	id: string
	title: string
	duration?: string
	endpoint?: string
	published?: string
	description: string
}

const yt = await Innertube.create({
	cache: new UniversalCache(true, './.cache'),
	enable_session_cache: true,
	generate_session_locally: true
})

async function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Resolves a YouTube channel ID by searching for the channel with the given handle.
 * @param {string} channelHandle The handle of the channel to search for.
 * @param {Innertube} yt The YouTubei.js instance to use for searching.
 * @returns {Promise<string | null>} The ID of the channel if found, otherwise null.
 */
async function resolveChannelId(channelHandle: string, yt: Innertube): Promise<string | null> {
	logger.info(`Searching for channel with handle: ${channelHandle}`)
	const searchResult = await yt.search(channelHandle, {
		type: 'channel',
		sort_by: 'relevance'
	})
	logger.info(`Search results received: ${searchResult.channels.length} channels found for handle: ${channelHandle}`)
	const match = searchResult.channels.find((c) => {
		const url = c.endpoint?.toURL()?.replace(/\/$/, '')
		// Check if the URL ends with the given channel handle
		logger.info(`Checking channel with URL: ${url}`)
		return url?.endsWith(channelHandle.replace(/\/$/, ''))
	})
	if (match) {
		logger.info(`Match found: ${match.author?.name} with id ${match.id}`)
	} else {
		logger.warn(`No match found for channel handle: ${channelHandle}`)
	}
	return match?.id || null
}

/**
 * Resolves the channel handles in the given config to their corresponding
 * YouTube channel IDs, and saves the resolved config.
 *
 * @param {number} [concurrency=3] The number of concurrent resolutions to perform.
 * @param {number} [maxRetries=3] The number of times to retry resolving a channel ID.
 * @returns {Promise<Config>} The resolved config with channel IDs.
 */
async function getResolvedConfig(concurrency: number = 3, maxRetries: number = 3): Promise<Config> {
	const limit = pLimit(concurrency)
	const config = getConfig()
	logger.info(`Loaded ${config.length} channels from config`)
	logger.info(`Starting to resolve channel IDs concurrently`)
	const resolvedConfig = await Promise.all(
		config.map((channel) =>
			limit(async () => {
				if (channel.channel.includes('@') && !channel.channelId) {
					const channelId = await pRetry(
						async () => {
							logger.info(`Attempting to resolve channel ${channel.channel} to an ID`)
							const resolvedId = await resolveChannelId(channel.channel, yt)
							logger.info(`Resolved channel ${channel.channel} to an ID: ${resolvedId}`)
							return resolvedId
						},
						{
							retries: maxRetries,
							onFailedAttempt(error) {
								// logger.error(
								// 	`Could not find channel ${channel.channel} in search results, There are ${error.retriesLeft} retries left.`
								// )
								if (error.retriesLeft === 0) {
									logger.error(`Cause: ${error.message}`)
								}
							},
							randomize: true
						}
					)
					if (!channelId) {
						logger.error(`Could not find channel ${channel.channel} in search results`)
						return channel
					}
					logger.info(`Resolved ${channel.channel} to ID ${channelId}`)
					return { ...channel, channelId: channelId }
				}
				logger.warn(`Channel is not a channel handle, skipping resolution`)
				return channel
			})
		)
	)
	logger.info(`Finished resolving channel IDs`)
	logger.info(`Saving config with resolved channel IDs`)
	saveConfig(resolvedConfig)
	return resolvedConfig.filter((c) => c.channelId !== undefined && c.channelId !== null)
}

/**
 * Fetches the continuation of a YouTube channel or channel list using retries.
 *
 * @param {YT.Channel | YT.ChannelListContinuation} continuation The channel or continuation to fetch.
 * @param {number} [maxRetries=3] The maximum number of retries for fetching the continuation.
 * @returns {Promise<YT.ChannelListContinuation>} The fetched channel list continuation.
 */
const getVideoContinuation = async (
	continuation: YT.Channel | YT.ChannelListContinuation,
	maxRetries: number = 3
): Promise<YT.ChannelListContinuation> => {
	return pRetry(() => continuation.getContinuation(), {
		retries: maxRetries,
		onFailedAttempt: (error) => {
			// logger.error(`Failed to get continuation, There are ${error.retriesLeft} retries left Error: ${error.message}`)
			if (error.retriesLeft === 0) {
				logger.error(`Cause: ${error.message}`)
			}
		},
		randomize: true
	})
}

/**
 * Maps a {@link YTNodes.Video} object to a {@link Video} object.
 * @param {YTNodes.Video} video The video to map.
 * @returns {Video} The mapped video object.
 */
const mapVideo = (video: YTNodes.Video): Video => {
	return {
		id: video.video_id,
		title: video.title.toString(),
		duration: video.duration.text,
		endpoint: `https://www.youtube.com/watch?v=${video.video_id}`,
		description: video.description
	}
}

/**
 * Recursively fetches all videos from a YouTube channel.
 * @param {YT.Channel | YT.ChannelListContinuation | null} channel The channel or continuation to fetch videos from.
 * @param {Video[]} [videos=[]] The list of videos to append to.
 * @param {number} [maxRetries=3] The maximum number of retries for fetching videos.
 * @returns {Promise<Video[]>} The list of videos fetched.
 */
const recursiveGetAllVideosFromChannel = async (
	channel: YT.Channel | YT.ChannelListContinuation | null,
	videos: Video[] = [],
	maxRetries: number = 3
): Promise<Video[]> => {
	logger.info(`Fetching videos from channel... total: ${videos.length}`)
	if (!channel) {
		logger.warn(`No channel to fetch videos from.`)
		return videos
	}

	if (channel instanceof YT.Channel) {
		// Fetch videos from the channel
		logger.info(`Fetching videos from channel...`)
		const videosResponse = await pRetry(() => channel.getVideos(), {
			retries: maxRetries,
			onFailedAttempt: (error) => {
				// logger.error(`Failed to get videos, There are ${error.retriesLeft} retries left Error : ${error.message}`)
				if (error.retriesLeft === 0) {
					logger.error(`Cause: ${error.message}`)
				}
			},
			randomize: true
		})
		// Check if there is a continuation
		const hasContinuation = videosResponse.has_continuation
		// Append videos to the list
		videos = videos.concat(videosResponse.videos.map((x) => mapVideo(x.as(YTNodes.Video))))
		logger.info(`Fetched ${videosResponse.videos.length} videos from channel. Total: ${videos.length}`)
		// If there is a continuation, fetch it recursively
		if (hasContinuation) {
			logger.info(`Fetching continuation for channel... total: ${videos.length}`)
			const continuation = await getVideoContinuation(videosResponse, maxRetries)
			return recursiveGetAllVideosFromChannel(continuation, videos, maxRetries)
		}
	}

	if (channel instanceof YT.ChannelListContinuation) {
		// Fetch videos from the continuation
		logger.info(`Fetching videos from continuation...`)
		const hasContinuation = channel.has_continuation
		// Append videos to the list
		videos = videos.concat(channel.videos.map((x) => mapVideo(x.as(YTNodes.Video))))
		logger.info(`Fetched ${channel.videos.length} videos from continuation. Total: ${videos.length}`)
		// If there is a continuation, fetch it recursively
		if (hasContinuation) {
			logger.info(`Fetching continuation for channel list... total: ${videos.length}`)
			const continuation = await getVideoContinuation(channel)
			return recursiveGetAllVideosFromChannel(continuation, videos, maxRetries)
		}
	}

	return videos
}

/**
 * Fetches all videos from a channel.
 *
 * @param {string} channelId The ID of the YouTube channel to fetch videos from.
 * @param {Innertube} yt The YouTubei.js instance to use for fetching videos.
 * @param {number} [maxRetries=3] The maximum number of retries for fetching videos.
 * @returns {Promise<Video[]>} The list of videos fetched from the channel.
 */
const getAllVideosFromChannel = async (channelId: string, yt: Innertube, maxRetries: number = 3): Promise<Video[]> => {
	logger.info(`Fetching videos from channel ${channelId}...`)
	const channel = await pRetry(
		// Fetch the channel
		() => yt.getChannel(channelId),
		{
			retries: maxRetries,
			onFailedAttempt: (error) => {
				// Log error if failed to fetch channel
				// logger.error(
				// 	`Failed to get channel ${channelId}, There are ${error.retriesLeft} retries left Error : ${error.message}`
				// )
				if (error.retriesLeft === 0) {
					logger.error(`Cause: ${error.message}`)
				}
			},
			randomize: true
		}
	)
	logger.info(`Fetched channel ${channelId}`)
	return recursiveGetAllVideosFromChannel(channel, [], maxRetries)
}

/**
 * Gets all videos for a given channel, either from the cache or by fetching
 * them from YouTube.
 *
 * @param {string} channelId The ID of the YouTube channel to fetch videos from.
 * @param {Innertube} yt The YouTubei.js instance to use for fetching videos.
 * @returns {Promise<Video[]>} The list of videos fetched from the channel.
 */
const getVideosForChannel = async (channelId: string, yt: Innertube): Promise<Video[]> => {
	// Create the cache folder if it doesn't exist
	fs.mkdirSync(path.join(CAPTIONS_FOLDER, channelId), { recursive: true })

	// Check if the cache file exists
	const cacheFile = path.join(CAPTIONS_FOLDER, channelId, 'videos.json')
	// if (fs.existsSync(cacheFile)) {
	// 	// Read the cache file
	// 	const data = fs.readFileSync(cacheFile, 'utf8')
	// 	const videos: Video[] = JSON.parse(data)
	// 	logger.warn(`Found ${videos.length} videos in cache.`)
	// 	return videos
	// }

	// Fetch the videos from YouTube
	logger.info(`Fetching videos from channel ${channelId}...`)
	const videos = await getAllVideosFromChannel(channelId, yt)
	if (videos.length === 0) {
		logger.warn(`No videos found for channel ${channelId}.`)
		return []
	}
	// Write the videos to the cache file
	fs.writeFileSync(cacheFile, JSON.stringify(videos, null, 2))
	logger.info(`Wrote ${videos.length} videos to cache.`)
	return videos
}

/**
 * Downloads the caption for a given YouTube video.
 *
 * @param {string} videoId The ID of the YouTube video to fetch captions for.
 * @param {Innertube} yt The YouTubei.js instance to use for fetching video information.
 * @param {number} [maxRetries=3] The maximum number of retries for fetching video info and transcript.
 * @returns {Promise<Array<{ text: string, start: number, end: number, url: string }>> | null} The list of caption segments or null if no captions found.
 */
const downloadCaptionForVideo = async (videoId: string, yt: Innertube, maxRetries = 3) => {
	// Attempt to get video information with retry logic
	const info = await pRetry(() => yt.getInfo(videoId), {
		retries: maxRetries,
		onFailedAttempt: (error) => {
			// logger.error(
			// 	`Failed to get video info for video ${videoId}, There are ${error.retriesLeft} retries left Error : ${error.message}`
			// )
			if (error.retriesLeft === 0) {
				logger.error(`Cause: ${error.message}`)
			}
		},
		randomize: true
	})

	// Attempt to get the transcript with retry logic
	const defaultTranscriptInfo = await pRetry(() => info.getTranscript(), {
		retries: maxRetries,
		onFailedAttempt: (error) => {
			// logger.error(
			// 	`Failed to get transcript for video ${videoId}, There are ${error.retriesLeft} retries left Error : ${error.message}`
			// )
			if (error.retriesLeft === 0) {
				logger.error(`Cause: ${error.message}`)
			}
		},
		randomize: true
	}).catch((error) => {
		logger.error(`Failed to get transcript for video ${videoId}. Error: ${error.message}`)
		return null
	})

	// Check if there are any captions available
	if (!defaultTranscriptInfo?.transcript?.content?.body?.initial_segments.length) {
		logger.warn(`No captions found for video ${videoId}.`)
		return null
	}

	// Log the number of lines in the transcript
	logger.info(
		`Got ${defaultTranscriptInfo?.selectedLanguage} transcript with ${defaultTranscriptInfo?.transcript?.content?.body?.initial_segments.length} lines.`
	)

	// Map transcript segments to a structured format
	return defaultTranscriptInfo.transcript.content?.body?.initial_segments.map((x) => ({
		text: x.snippet.text,
		start: x.start_ms,
		end: x.end_ms
	}))
}

enum CaptionDownloadResult {
	AlreadyDownloaded,
	Success,
	NoCaptions,
	Error
}
/**
 * Downloads the caption for a given YouTube video and saves it to disk.
 *
 * @param {string} videoId The ID of the YouTube video to fetch captions for.
 * @param {string} channelId The ID of the YouTube channel the video belongs to.
 * @param {Innertube} yt The YouTubei.js instance to use for fetching video information.
 * @param {number} [maxRetries=3] The maximum number of retries for fetching video info and transcript.
 */
const downloadAndSaveCaption = async (
	videoId: string,
	channelId: string,
	yt: Innertube,
	maxRetries: number = 3
): Promise<CaptionDownloadResult> => {
	const captionFile = path.join(CAPTIONS_FOLDER, channelId, `${videoId}.json`)

	if (fs.existsSync(captionFile)) {
		return CaptionDownloadResult.AlreadyDownloaded
	}

	try {
		const caption = await downloadCaptionForVideo(videoId, yt, maxRetries)
		if (!caption) {
			logger.warn(`No captions found for video ${videoId}.`)
			return CaptionDownloadResult.NoCaptions
		}
		const channelFolder = path.join(CAPTIONS_FOLDER, channelId)
		fs.mkdirSync(channelFolder, { recursive: true })
		fs.writeFileSync(captionFile, JSON.stringify(caption, null, 2))
		logger.info(`Wrote captions for video ${videoId} to ${captionFile}`)
		return CaptionDownloadResult.Success
	} catch (err) {
		logger.error(`Error downloading caption for video ${videoId}:`, err)
		return CaptionDownloadResult.Error
	}
}

class SkiplistManager {
	skiplist: Set<string>
	private readonly file: string

	constructor(file: string) {
		this.file = file
		this.skiplist = this.load()
	}

	private load(): Set<string> {
		try {
			fs.mkdirSync(CAPTIONS_FOLDER, { recursive: true })
			const data = fs.readFileSync(this.file, 'utf-8')
			return new Set(JSON.parse(data))
		} catch (e) {
			return new Set()
		}
	}

	has(id: string): boolean {
		return this.skiplist.has(id)
	}

	add(id: string) {
		this.skiplist.add(id)
		this.save()
	}

	save() {
		fs.mkdirSync(CAPTIONS_FOLDER, { recursive: true })
		fs.writeFileSync(this.file, JSON.stringify([...this.skiplist], null, 2))
	}
}

async function main() {
	try {
		const resolvedConfig = await getResolvedConfig()
		const limit = pLimit(10)
		const skiplistManager = new SkiplistManager(SKIPLIST_FILE)

		const videos = await Promise.all(
			resolvedConfig.map((channel) =>
				limit(async () => {
					const videos = await getVideosForChannel(channel.channelId!, yt)
					return {
						channel: channel,
						videos: videos
					}
				})
			)
		)

		const videosWithChannel = videos.flatMap(({ channel, videos }) =>
			videos.map((video) => ({
				channel: channel,
				video: video
			}))
		)

		const captionDownloadLimit = pLimit(20)

		await Promise.all(
			videosWithChannel.map(({ channel, video }) =>
				captionDownloadLimit(async () => {
					if (skiplistManager.has(video.id)) {
						logger.warn(`Skipping video ${video.id} as it is in the skiplist.`)
						return
					}
					const result = await downloadAndSaveCaption(video.id, channel.channelId!, yt, 3)
					if (result === CaptionDownloadResult.NoCaptions) {
						skiplistManager.add(video.id)
					}
				})
			)
		)
	} catch (err) {
		logger.error('Fatal error in main application:', { error: err })
		process.exit(1)
	}
}

process.on('SIGINT', () => {
	logger.info('Received SIGINT. Shutting down gracefully.')
	process.exit(0)
})
process.on('SIGTERM', () => {
	logger.info('Received SIGTERM. Shutting down gracefully.')
	process.exit(0)
})

main()
