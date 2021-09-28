const config = require('./helpers/config');
const { loginMoodleUnifiedAuth, getCourseName, getWebexLaunchOptions } = require('./helpers/moodle');
const { launchWebex, getWebexRecordings, getWebexRecordingDownloadUrl, getWebexRecordingHSLPlaylist } = require('./helpers/webex');
const logger = require('./helpers/logging')('app');
const { join } = require('path');
const { existsSync, renameSync, readdirSync, readFileSync, unlinkSync, writeFileSync } = require('fs');
const { downloadStream, downloadHLSPlaylist, mkdirIfNotExists } = require('./helpers/download');
const { getUTCDateTimestamp } = require('./helpers/date');
const MultiProgressBar = require('./helpers/MultiProgressBar');
const { splitArrayInChunksOfFixedLength } = require('./helpers/utils');

const multiProgressBar = new MultiProgressBar();

/**
 * @return {config.Config} configs
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

    return await config.load(configPath);
}

/**
 * @throws {Error} If temp directory couldn't be created
 */
async function createTempFolder() {
    try {
        await mkdirIfNotExists('./tmp');
        // remove temp files of previous executions that were abruptly interrupted
        readdirSync('./tmp').forEach(tmpfile => {
            unlinkSync(join('./tmp/', tmpfile));
        });
    } catch (err) {
        throw new Error(`Error while creating tmp folder: ${err.message}`);
    }
}

/**
 * @param {config.Config} configs
 * @returns {string} Moodle session token cookie
 */
async function loginToMoodle(configs) {
    logger.info('Logging into Moodle');
    return await loginMoodleUnifiedAuth(configs.credentials.username, configs.credentials.password);
}

/**
 * Get all recordings, applying filters specified in the course's config
 * @param {config.Course} course
 * @param {string} moodleSession
 * @return {object}
 */
async function getRecordings(course, moodleSession) {
    // Launch webex
    const launchParameters = await getWebexLaunchOptions(moodleSession, course.id, course?.custom_webex_id);
    if (launchParameters === null) {
        logger.warn('└─ Webex id not found... Skipping');
    }
    const webexObject = await launchWebex(launchParameters);

    // Get recordings
    const recordingsAll = await getWebexRecordings(webexObject);
    // Filter recordings
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
}

/**
 * If downloadPath doesn't exists, download the recording and save it.
 * @param {import('./helpers/webex').Recording} recording Recording to download
 * @param {config.ConfigDownload} downloadConfigs Download section configs
 * @param {string} downloadPath Final save-path after download its complete
 * @param {string} tmpDownloadPath Temporary save-path, used until the download its complete
 */
async function downloadRecordingIfNotExists(recording, downloadConfigs, downloadPath, tmpDownloadPath) {
    if (!existsSync(downloadPath)) {
        logger.info(`   └─ Downloading: ${recording.name}`);
        try {
            // Try to use webex download feature and if it fails, fallback to hls stream feature
            try {
                logger.debug('      └─ Trying download feature');
                const downloadUrl = await getWebexRecordingDownloadUrl(recording.file_url, recording.password);
                await downloadStream(downloadUrl, tmpDownloadPath, downloadConfigs.progress_bar, multiProgressBar);
            } catch (error) {
                logger.warn(`      └─ Error: ${error}`);
                logger.info('      └─ Trying downloading stream (may be slower)');
                const { playlistUrl, filesize } = await getWebexRecordingHSLPlaylist(recording.recording_url, recording.password);
                await downloadHLSPlaylist(playlistUrl, tmpDownloadPath, filesize, downloadConfigs.progress_bar, multiProgressBar);
            }

            // Download was successful, move rec to destination
            logger.debug('Moving file out of tmp folder');
            try {
                renameSync(tmpDownloadPath, downloadPath);
            } catch (err) {
                if (err.code === 'EXDEV') {
                    // Cannot move files that are not in the top OverlayFS layer (e.g.: inside volumes)
                    logger.debug('Probably inside a Docker container, falling back to copy-and-unlink');
                    const fileContents = readFileSync(tmpDownloadPath);
                    writeFileSync(downloadPath, fileContents);
                    unlinkSync(tmpDownloadPath);
                } else {
                    throw err;  // Bubble up
                }
            }
        } catch (err) {
            logger.error(`      └─ Skipped because of: ${err.message}`);
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
        let downloads = [];

        for (const recording of chunk) {
            // filename
            let filename = `${recording.name}.${recording.format}`.replace(/[\\/:"*?<>| ]/g, '_');
            if (course.prepend_date)
                filename = `${getUTCDateTimestamp(recording.created_at, '')}-${filename}`;

            // Make folder structure for downloadPath
            let folderPath = join(
                downloadConfigs.base_path,
                course.name ? `${course.name}_${course.id}` : `${course.id}`
            );
            let downloadPath = join(folderPath, filename);
            let tmpDownloadPath = join('./tmp/', filename);
            try {
                await mkdirIfNotExists(folderPath);
            } catch (err) {
                throw new Error(`Error while creating folder structure: ${err.message}`);
            }

            downloads.push(downloadRecordingIfNotExists(recording, downloadConfigs, downloadPath, tmpDownloadPath));
        }

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
 */
async function processCourses(configs, moodleSession) {
    let coursesToProcess = [];

    logger.info('Fetching recordings lists');
    for (const course of configs.courses) {
        // Get course name if unspecified
        if (!course.name) {
            course.name = await getCourseName(moodleSession, course.id);
            logger.info(`Got course name: ${course.name}`);
        }

        coursesToProcess.push({
            recordings: getRecordings(course, moodleSession),
            course: course
        });
    }

    for (const c of coursesToProcess) {
        const recordings = await c.recordings;
        logger.info(`Working on course: ${c.course.id} - ${c.course.name ?? ''}`);
        logger.info(`└─ Found ${recordings.totalCount} recordings (${recordings.filteredCount} filtered)`);

        await processCourseRecordings(c.course, recordings.recordings, configs.download);
    }
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
