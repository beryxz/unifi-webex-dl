const config = require('./helpers/config');
const { createHash } = require('crypto');
const { loginMoodleUnifiedAuth, getWebexLaunchOptions } = require('./helpers/moodle');
const { launchWebex, getWebexRecordings, getWebexRecordingDownloadUrl, getWebexRecordingHSLPlaylist } = require('./helpers/webex');
const logger = require('./helpers/logging')('app');
const { join } = require('path');
const { existsSync, renameSync, readdirSync, readFileSync, unlinkSync, writeFileSync, rmSync } = require('fs');
const { downloadStream, downloadHLSPlaylist, mkdirIfNotExists, mergeHLSPlaylistSegments } = require('./helpers/download');
const { getUTCDateTimestamp } = require('./helpers/date');
const MultiProgressBar = require('./helpers/MultiProgressBar');
const { splitArrayInChunksOfFixedLength, retryPromise } = require('./helpers/utils');

/**
 * Load the proper config file.
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
        }
    } else {
        logger.info(`Loading ${configPath}`);
    }

    return config.load(configPath);
}

/**
 * Creates the temp folder removing all temp files of previous executions that were abruptly interrupted
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
 * @param {config.Config} configs
 * @returns {Promise<string>} Moodle session token cookie
 */
async function loginToMoodle(configs) {
    logger.info('Logging into Moodle');
    return loginMoodleUnifiedAuth(configs.credentials.username, configs.credentials.password);
}

/**
 * Get all recordings, applying filters specified in the course's config
 * @param {config.Course} course
 * @param {string} moodleSession
 * @return {Promise<object>}
 */
async function getRecordings(course, moodleSession) {
    return await getWebexLaunchOptions(moodleSession, course.id, course?.custom_webex_id)
        .then(webexLaunch => launchWebex(webexLaunch))
        .then(webexObject => getWebexRecordings(webexObject))
        .then(recordingsAll => {
            const recordings = recordingsAll.filter(rec => {
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
                recordings: recordings,
                totalCount: recordingsAll.length,
                filteredCount: recordingsAll.length - recordings.length
            };
        })
        .catch(err => { throw err; });
}

/**
 * If downloadPath doesn't exists, download the recording and save it.
 * @param {import('./helpers/webex').Recording} recording Recording to download
 * @param {config.ConfigDownload} downloadConfigs Download section configs
 * @param {string} downloadFilePath Final file save-path after download its complete
 * @param {string} tmpDownloadFolderPath Temporary save-path folder, used until the download its complete
 * @param {MultiProgressBar} [multiProgressBar=null] MultiProgressBar instance to render download status
 */
async function downloadRecordingIfNotExists(recording, downloadConfigs, downloadFilePath, tmpDownloadFolderPath, multiProgressBar = null) {
    if (!existsSync(downloadFilePath)) {
        logger.info(`   └─ Downloading: ${recording.name}`);
        const downloadName = getUTCDateTimestamp(recording.created_at, '');

        try {
            await mkdirIfNotExists(tmpDownloadFolderPath);
            let tmpDownloadFilePath = join(tmpDownloadFolderPath, 'recording.mp4');

            // Try to use webex download feature and if it fails, fallback to hls stream feature
            try {
                logger.debug(`      └─ [${downloadName}] Trying download feature`);
                const downloadUrl = await getWebexRecordingDownloadUrl(recording.file_url, recording.password);
                await downloadStream(downloadUrl, tmpDownloadFilePath, downloadConfigs.progress_bar, multiProgressBar, downloadName);
            } catch (error) {
                logger.warn(`      └─ [${downloadName}] ${error}`);
                logger.info(`      └─ [${downloadName}] Trying downloading stream`);
                const { playlistUrl, filesize } = await getWebexRecordingHSLPlaylist(recording.recording_url, recording.password);
                await downloadHLSPlaylist(playlistUrl, tmpDownloadFolderPath, filesize, downloadConfigs.progress_bar, multiProgressBar, downloadName);
                await mergeHLSPlaylistSegments(tmpDownloadFolderPath, tmpDownloadFilePath);
            }

            // Download was successful, move rec to destination
            // logger.debug(`[${downloadName}] Moving file out of tmp folder`);
            try {
                renameSync(tmpDownloadFilePath, downloadFilePath);
            } catch (err) {
                if (err.code === 'EXDEV') {
                    // Cannot move files that are not in the top OverlayFS layer (e.g.: inside volumes)
                    // logger.debug(`[${downloadName}] Probably inside a Docker container, falling back to copy-and-unlink`);
                    const fileContents = readFileSync(tmpDownloadFilePath);
                    writeFileSync(downloadFilePath, fileContents);
                    unlinkSync(tmpDownloadFilePath);
                } else {
                    throw err;  // Bubble up
                }
            }
        } catch (err) {
            logger.error(`      └─ [${downloadName}] Skipped because of: ${err.message}`);
            return;
        }
    } else if (downloadConfigs.show_existing) {
        logger.info(`   └─ Already exists: ${recording.name}`);
    }
}

/**
 * Process a moodle course's recordings, and download all missing ones from webex
 * @param {config.Course} course The moodle course to process
 * @param {import('./helpers/webex').Recording[]} recordings Recordings to process
 * @param {config.ConfigDownload} downloadConfigs Download section configs
 */
async function processCourseRecordings(course, recordings, downloadConfigs) {
    let chunks = splitArrayInChunksOfFixedLength(recordings, downloadConfigs.max_concurrent_downloads ?? 3);

    for (const chunk of chunks) {
        const multiProgressBar = new MultiProgressBar();

        let downloads = chunk.map(recording => {
            // filename
            let filename = `${recording.name}.${recording.format}`.replace(/[\\/:"*?<>| \r\n]/g, '_');
            if (course.prepend_date)
                filename = `${getUTCDateTimestamp(recording.created_at, '')}-${filename}`;

            // Make folder structure for downloadPath
            let folderPath = join(
                downloadConfigs.base_path,
                course.name ? `${course.name}_${course.id}` : `${course.id}`
            );

            let downloadPath = join(folderPath, filename);
            let filenameHash = createHash('sha1').update(filename).digest('hex');
            let tmpDownloadPath = join('./tmp/', filenameHash);

            return mkdirIfNotExists(folderPath)
                .then(() =>
                    downloadRecordingIfNotExists(recording, downloadConfigs, downloadPath, tmpDownloadPath, (downloadConfigs.progress_bar ? multiProgressBar : null)))
                .catch(err => {
                    throw err;
                });
        });

        await Promise.all(downloads);
    }
}

/**
 * Process all moodle courses specified in the configs.
 *
 * Initially, the recordings list are fetched simultaneously.
 * Then, each recordings list is processed individually.
 * @param {config.Config} configs
 * @param {string} moodleSession
 * @returns {Promise<void>}
 */
async function processCourses(configs, moodleSession) {
    logger.info('Fetching recordings lists');

    for (const course of configs.courses) {
        await retryPromise(3, 500, () => getRecordings(course, moodleSession))
            .then(recordings => {
                logger.info(`Working on course: ${course.id} - ${course.name ?? ''}`);
                logger.info(`└─ Found ${recordings.totalCount} recordings (${recordings.filteredCount} filtered)`);

                return processCourseRecordings(course, recordings.recordings, configs.download);
            })
            .catch(err => {
                logger.warn(`[${course.id}] Skipping because of: ${err.message}`);
            });
    }

    //TODO DISABLED since on windows the name cannot contain some special chars.
    //     Applying a sanitization step might solve this.
    //
    // // Get course name if unspecified
    // if (!course.name) {
    //     course.name = await getCourseName(moodleSession, course.id);
    //     logger.info(`[${course.id}] Fetched course name: ${course.name}`);
    // }
}

(async () => {
    try {
        // get moodle credentials and courses ids
        let configs = await loadConfig();

        await createTempFolder();

        const moodleSession = await loginToMoodle(configs);

        await processCourses(configs, moodleSession);

        logger.info('Done');
    } catch (err) {
        logger.error(err);
    }
})();
