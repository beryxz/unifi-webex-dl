const config = require('./helpers/config');
const { createHash } = require('crypto');
const Moodle = require('./helpers/moodle');
const bytes = require('bytes');
const { launchWebex, getWebexRecordings, getWebexRecordingDownloadUrl, getWebexRecordingHLSPlaylist, getWebexRecordingStreamOptions } = require('./helpers/webex');
const logger = require('./helpers/logging')('app');
const { join } = require('path');
const { existsSync, readdirSync, unlinkSync, rmSync } = require('fs');
const { downloadHLS, downloadStream, parseHLSPlaylistSegments } = require('./helpers/download');
const { getUTCDateTimestamp } = require('./helpers/date');
const { MultiProgressBar, StatusProgressBar, OneShotProgressBar } = require('./helpers/progressbar');
const { splitArrayInChunksOfFixedLength, retryPromise, sleep, replaceWindowsSpecialChars, replaceWhitespaceChars, mkdirIfNotExists, moveFile, remuxVideoWithFFmpeg } = require('./helpers/utils');
const { default: axios } = require('axios');
const { EventEmitter } = require('stream');

/**
 * @typedef FetchedCourse
 * @type {object}
 * @property {boolean} success if the course was fetched succesfully. If false, check the `err` property for additional details.
 * @property {FetchedRecordings} [recordings] List of recordings of the course
 * @property {config.Course} [course]
 * @property {any} [err]
 */

/**
 * @typedef FetchedRecordings
 * @type {object}
 * @property {import('./helpers/webex').Recording[]} recordings
 * @property {number} totalCount
 * @property {number} filteredCount
 */

/**
 * @typedef LogsConfig
 * @type {object}
 * @property {MultiProgressBar} [multiProgressBar=null] MultiProgressBar instance to render download status
 * @property {string} logStatusName Name of the download to show in the download status
 */

/**
 * @type {bytes.BytesOptions}
 */
const BYTES_OPTIONS = {
    decimalPlaces: 2,
    fixedDecimals: true,
    thousandsSeparator: '',
    unit: 'MB',
    unitSeparator: '',
};

/**
 * Helper to load the proper config file.
 * First it tries to load config.json, if it doesn't exist, config.yaml is tried next
 * @return {Promise<config.Config>} configs
 */
async function loadConfig() {
    let configPath = process.env['CONFIG_PATH'];
    if (!configPath) {
        if (existsSync('./config.json')) {
            logger.info('Loading config.json');
            configPath = './config.json';
        } else if (existsSync('./config.yaml')) {
            logger.info('Loading config.yaml');
            configPath = './config.yaml';
        } else {
            throw new Error('Config file not found. Are you in the same directory as the script?');
        }
    } else {
        logger.info(`Loading ${configPath}`);
    }

    return config.load(configPath);
}

/**
 * Setup common configs for axios static instance
 */
function setupAxios() {
    Object.assign(axios.defaults, {
        headers: {
            'User-Agent': 'Mozilla/5.0'
        }
    });
}

/**
 * Helper to create the temp folder removing all temp files of previous executions that were abruptly interrupted
 * @returns {Promise<void>}
 * @throws {Error} If temp directory couldn't be created
 */
async function createTempFolder() {
    try {
        await mkdirIfNotExists('./tmp');
        readdirSync('./tmp').forEach(tmpfile => {
            rmSync(join('./tmp/', tmpfile), { recursive: true, force: true });
        });
    } catch (err) {
        throw new Error(`Error while creating tmp folder: ${err.message}`);
    }
}

/**
 * Helper to login to Moodle
 * @param {Moodle} moodle
 * @param {config.Config} configs
 * @returns {Promise<void>}
 */
async function loginToMoodle(moodle, configs) {
    logger.info('Logging into Moodle');
    return moodle.loginMoodleUnifiedAuth(configs.credentials.username, configs.credentials.password);
}

/**
 * Get all recordings, applying filters specified in the course's config
 * @param {config.Course} course
 * @param {Moodle} moodle
 * @return {Promise<FetchedRecordings>}
 */
async function getRecordings(course, moodle) {
    const recordingsAll = await moodle.getWebexLaunchOptions(course.id, course?.custom_webex_id)
        .then(webexLaunch => launchWebex(webexLaunch))
        .then(webexObject => getWebexRecordings(webexObject))
        .catch(err => { throw err; });

    const recordingsFiltered = recordingsAll.filter(rec => {
        try {
            let createdAt = new Date(rec.created_at).getTime();
            return !(
                (course.skip_before_date && new Date(course.skip_before_date) > createdAt) ||
                (course.skip_after_date && new Date(course.skip_after_date) < createdAt) ||
                (course.skip_names && RegExp(course.skip_names).test(rec.name))
            );
        } catch (err) {
            return true;
        }
    });

    return {
        recordings: recordingsFiltered,
        totalCount: recordingsAll.length,
        filteredCount: recordingsAll.length - recordingsFiltered.length
    };
}

/**
 * Process a moodle course's recordings, and download all missing ones from webex
 * @param {config.Course} course The moodle course to process
 * @param {import('./helpers/webex').Recording[]} recordings Recordings to process
 * @param {Promise<config.ConfigDownload>} downloadConfigs Download section configs
 */
async function processCourseRecordings(course, recordings, downloadConfigs, nLessons) {
    const courseDownloadPath = join(
        downloadConfigs.base_path,
        course.name ? `${course.name}_${course.id}` : `${course.id}`
    );
    await mkdirIfNotExists(courseDownloadPath);

    const chunks = splitArrayInChunksOfFixedLength(recordings, downloadConfigs.max_concurrent_downloads);

    for (const chunk of chunks) {
        const multiProgressBar = (downloadConfigs.progress_bar ? new MultiProgressBar(false) : null);

        const downloads = chunk.map(async (recording) => {
            try {
                let filename = replaceWhitespaceChars(replaceWindowsSpecialChars(`${recording.name}.${recording.format}`, '_'), '_');
                if (course.prepend_date)
                    filename = `${getUTCDateTimestamp(recording.created_at, '')}-${filename}`;
                if (course.prepend_number) {
                    filename = `${nLessons.toString()}-${filename}`;
                    logger.debug(filename);
                    nLessons --;
                }

                await downloadRecording(recording, filename, courseDownloadPath, downloadConfigs, multiProgressBar);
            } catch (err) {
                logger.error(`   └─ Skipping "${recording.name}": ${err.message}`);
            }
        });

        // For simplicity, individual promises must not throw an error, as is the case here. Otherwise Promise.all fails and the entire course is skipped.
        await Promise.all(downloads);
        if (multiProgressBar) multiProgressBar.terminate();
    }
}

/**
 * Wrapper to download a stream file from an url to a file.
 *
 * The wrapper manages the various initialization and the progress bar.
 * Returns a promise that resolves if the stream was downloaded successfully, rejects it otherwise.
 *
 * @param {string} url URL of the resource to download as a stream.
 * @param {string} savePath Path in which to save the downloaded file.
 * @param {LogsConfig} logsConfig Configs for logs and progressBar.
 * @returns {Promise<void>} A promise that resolves if the stream was downloaded successfully, rejects it otherwise.
 */
async function downloadStreamWrapper(url, savePath, logsConfig) {
    const statusEmitter = new EventEmitter();
    if (logsConfig.multiProgressBar !== null)
        new StatusProgressBar(
            logsConfig.multiProgressBar,
            statusEmitter,
            (data) => `[${logsConfig.logStatusName}] ${bytes(parseInt(data.filesize), BYTES_OPTIONS).padStart(9)}`,
            (data) => data.filesize,
            (data) => data.chunkLength);

    downloadStream(url, savePath, statusEmitter);

    return new Promise((resolve, reject) => {
        statusEmitter.on('finish', resolve);
        statusEmitter.on('error', (err) => {
            reject(err);
        });
    });
}

/**
 * Wrapper to download an HLS stream file from an url to a file.
 *
 * The wrapper manages the various initialization and the progress bar.
 * Returns a promise that resolves if the stream was downloaded successfully, rejects it otherwise.
 *
 * @param {string} playlistUrl URL of the m3u8 playlist to download as an HLS stream.
 * @param {string} filesize Expected filesize used to track progress in logging.
 * @param {string} savePath Path in which to save the downloaded file.
 * @param {string} tmpFolderPath Path to a temp folder to be used internally to save intermediary segments.
 * @param {LogsConfig} logsConfig Configs for logs and progressBar.
 * @returns {Promise<void>} A promise that resolves if the HLS stream was downloaded successfully, rejects it otherwise.
 */
async function downloadHLSWrapper(playlistUrl, filesize, savePath, tmpFolderPath, logsConfig) {
    const statusEmitter = new EventEmitter();
    if (logsConfig.multiProgressBar !== null) {
        new StatusProgressBar(
            logsConfig.multiProgressBar,
            statusEmitter,
            (data) => `[${logsConfig.logStatusName}] ${(data.stage === 'DOWNLOAD') ? (bytes(parseInt(filesize), BYTES_OPTIONS).padStart(9)) : 'MERGE'}`,
            (data) => data.segmentsCount,
            () => null);
    }

    downloadHLS(playlistUrl, savePath, tmpFolderPath, statusEmitter);

    return new Promise((resolve, reject) => {
        statusEmitter.on('finish', resolve);
        statusEmitter.on('error', (err) => {
            reject(err);
        });
    });
}

/**
 * Download the recording using the `file_url` url.
 * @param {import('./helpers/webex').Recording} recording The recording to download, using the `file_url` property.
 * @param {string} savePath Path in which to save the downloaded file.
 * @param {LogsConfig} logsConfig Configs for logs and progressBar.
 * @returns A promise that resolves if the stream was downloaded successfully, rejects it otherwise.
 */
async function downloadStreamStrategy(recording, savePath, logsConfig) {
    logger.debug(`      └─ [${logsConfig.logStatusName}] Trying to download stream`);

    const downloadUrl = await getWebexRecordingDownloadUrl(recording.file_url, recording.password);

    return downloadStreamWrapper(downloadUrl, savePath, logsConfig);
}

/**
 * Download the recording using the `recording_url` url, and the `fallbackPlaySrc` property.
 * @param {import('./helpers/webex').Recording} recording The reecording to download using the `recording_url` property.
 * @param {string} savePath Path in which to save the downloaded file.
 * @param {LogsConfig} logsConfig Configs for logs and progressBar.
 * @returns A promise that resolves if the stream was downloaded successfully, rejects it otherwise.
 */
async function downloadFallbackPlaySrcStrategy(recording, savePath, logsConfig) {
    logger.debug(`      └─ [${logsConfig.logStatusName}] Trying to download fallbackPlaySrc`);

    const streamOptions = await getWebexRecordingStreamOptions(recording.recording_url, recording.password);
    if (!streamOptions.fallbackPlaySrc) throw new Error('fallbackPlaySrc property not found');

    return downloadStreamWrapper(streamOptions.fallbackPlaySrc, savePath, logsConfig);
}

/**
 * Download the recording using the `recording_url` url, and the `downloadRecordingInfo.downloadInfo.hlsURL` property.
 * @param {import('./helpers/webex').Recording} recording The reecording to download using the `recording_url` property.
 * @param {string} savePath Path in which to save the downloaded file.
 * @param {LogsConfig} logsConfig Configs for logs and progressBar.
 * @returns A promise that resolves if the stream was downloaded successfully, rejects it otherwise.
 */
async function downloadHlsURLStrategy(recording, savePath, logsConfig) {
    logger.debug(`      └─ [${logsConfig.logStatusName}] Trying to download hlsURL`);

    const streamOptions = await getWebexRecordingStreamOptions(recording.recording_url, recording.password);
    if (!streamOptions?.downloadRecordingInfo?.downloadInfo?.hlsURL) throw new Error('hlsURL property not found');
    const hlsURL = streamOptions.downloadRecordingInfo.downloadInfo.hlsURL;
    const playlistSegments = await parseHLSPlaylistSegments(hlsURL);
    const streamUrl = hlsURL.replace('hls.m3u8', playlistSegments[0]);
    if (playlistSegments.length !== 1) throw new Error('HLS playlist has more than 1 segment');

    return downloadStreamWrapper(streamUrl, savePath, logsConfig);
}

/**
 * Download the recording using the `recording_url` url, and the `mp4StreamOption` property.
 * @param {import('./helpers/webex').Recording} recording The reecording to download using the `recording_url` property.
 * @param {string} savePath Path in which to save the downloaded file.
 * @param {LogsConfig} logsConfig Configs for logs and progressBar.
 * @returns A promise that resolves if the HLS stream was downloaded successfully, rejects it otherwise.
 */
async function downloadHLSStrategy(recording, savePath, tmpFolderPath, logsConfig) {
    logger.debug(`      └─ [${logsConfig.logStatusName}] Trying to download HLS`);

    const { playlistUrl, filesize } = await retryPromise(10, 2000,
        () => getWebexRecordingHLSPlaylist(recording.recording_url, recording.password));

    return downloadHLSWrapper(playlistUrl, filesize, savePath, tmpFolderPath, logsConfig);
}

/**
 * If the recording doesn't alredy exists, download the recording and save it.
 * @param {import('./helpers/webex').Recording} recording Webex Recording object to download.
 * @param {string} filename The filename of the recording.
 * @param {string} courseDownloadPath The course's download folder where to save recordings.
 * @param {config.ConfigDownload} downloadConfigs Download section configs.
 * @param {MultiProgressBar} [multiProgressBar=null] MultiProgressBar instance to render download status.
 * @returns {Promise<void>} A promise that resolves if the download completed successfully, rejects it otherwise
 */
async function downloadRecording(recording, filename, courseDownloadPath, downloadConfigs, multiProgressBar = null) {
    /** Final file save-path after download its complete */
    const downloadFilePath = join(courseDownloadPath, filename);
    if (existsSync(downloadFilePath)) {
        if (downloadConfigs.show_existing)
            logger.info(`   └─ Already exists: ${recording.name}`);
        return;
    }
    logger.info(`   └─ Downloading: ${recording.name}`);

    /** hash of the recording's resulting filename */
    const filenameHash = createHash('sha1').update(filename).digest('hex');

    /** Path to a temporary folder where to save all files related to a recording. */
    const tmpDownloadFolderPath = join('./tmp/', filenameHash);
    await mkdirIfNotExists(tmpDownloadFolderPath);

    /** Path to the temporary file in which to download the recording */
    const tmpDownloadFilePath = join(tmpDownloadFolderPath, 'recording.mp4');

    const logStatusName = getUTCDateTimestamp(recording.created_at, '');
    const logsConfig = {
        multiProgressBar: downloadConfigs.progress_bar ? multiProgressBar : null,
        logStatusName: logStatusName
    };

    // Try to download the recording in different ways.
    //TODO: log error messages to debug output
    await downloadStreamStrategy(recording, tmpDownloadFilePath, logsConfig)
        .catch(async () =>
            await downloadFallbackPlaySrcStrategy(recording, tmpDownloadFilePath, logsConfig))
        .catch(async () =>
            await downloadHlsURLStrategy(recording, tmpDownloadFilePath, logsConfig))
        .catch(async () =>
            await downloadHLSStrategy(recording, tmpDownloadFilePath, tmpDownloadFolderPath, logsConfig));

    // Download was successful, move rec to destination.
    if (downloadConfigs.fix_streams_with_ffmpeg) {
        let progressBar = new OneShotProgressBar(multiProgressBar, `[${logStatusName}] REMUX`);
        progressBar.init();

        await remuxVideoWithFFmpeg(tmpDownloadFilePath, downloadFilePath);
        unlinkSync(tmpDownloadFilePath);

        progressBar.complete();
    } else {
        moveFile(tmpDownloadFilePath, downloadFilePath);
    }
}

/**
 * Fetch the recordings list for each course
 * @param {Moodle} moodle Moodle instance
 * @param {config.Course[]} courses List of courses to fetchs
 * @return {Array.<Promise<FetchedCourse>>}
 */
function getCourses(moodle, courses) {
    logger.info('Fetching recordings lists');

    return courses.map((course) =>
        retryPromise(3, 500, () => getRecordings(course, moodle))
            .then(/** @returns {FetchedCourse} */
                recordings => ({
                    success:  true,
                    recordings: recordings,
                    course: course
                }))
            .catch(/** @returns {FetchedCourse} */
                err => ({
                    success: false,
                    err: err,
                    course: course
                }))
    );
}

/**
 * Process all moodle courses specified in the configs.
 *
 * Initially, the recordings list are fetched simultaneously.
 * Then, each recordings list is processed individually.
 * @param {Moodle} moodle
 * @param {config.Config} configs
 * @returns {Promise<void>}
 */
async function processCourses(moodle, configs) {
    const coursesToProcess = getCourses(moodle, configs.courses);

    for (const curCourse of coursesToProcess) {
        let { success, err, recordings, course } = await curCourse;
        logger.info(`Working on course: ${course.id} - ${course.name ?? ''}`);

        if (!success) {
            logger.error(`└─ Error retrieving recordings: ${err.message}`);
            continue;
        }
        logger.info(`└─ Found ${recordings.totalCount} recordings (${recordings.filteredCount} filtered)`);

        try {
            await processCourseRecordings(course, recordings.recordings, configs.download, recordings.totalCount);
        } catch (err) {
            logger.error(`└─ Error processing recordings: ${err.message}`);
            continue;
        }
    }
}

(async () => {
    try {
        setupAxios();
        await createTempFolder();

        let configs = await loadConfig();

        const moodle = new Moodle();
        await loginToMoodle(moodle, configs);

        await processCourses(moodle, configs);

        logger.info('Done');
    } catch (err) {
        logger.error(err);
        logger.warn('Exiting in 5s...');
        await sleep(5000);
    }
})();
