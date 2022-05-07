const config = require('./helpers/config');
const { createHash } = require('crypto');
const Moodle = require('./helpers/moodle');
const bytes = require('bytes');
const { launchWebex, getWebexRecordings, getWebexRecordingDownloadUrl, getWebexRecordingHSLPlaylist } = require('./helpers/webex');
const logger = require('./helpers/logging')('app');
const { join } = require('path');
const { existsSync, readdirSync, unlinkSync, rmSync } = require('fs');
const { StreamDownload, HLSDownload } = require('./helpers/download');
const { getUTCDateTimestamp } = require('./helpers/date');
const { MultiProgressBar, StatusProgressBar, OneShotProgressBar } = require('./helpers/progressbar');
const { splitArrayInChunksOfFixedLength, retryPromise, sleep, replaceWindowsSpecialChars, replaceWhitespaceChars, mkdirIfNotExists, moveFile } = require('./helpers/utils');
const { default: axios } = require('axios');

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
async function processCourseRecordings(course, recordings, downloadConfigs) {
    let chunks = splitArrayInChunksOfFixedLength(recordings, downloadConfigs.max_concurrent_downloads);

    for (const chunk of chunks) {
        const multiProgressBar = (downloadConfigs.progress_bar ? new MultiProgressBar() : null);

        let downloads = chunk.map(recording =>
            downloadRecording(recording, course, downloadConfigs, multiProgressBar));

        await Promise.all(downloads)
            .catch(err => {throw err;});
    }
}

/**
 * If the recording doesn't alredy exists, download the recording and save it.
 * @param {import('./helpers/webex').Recording} recording Recording to download
 * @param {config.Course} course The moodle course to process
 * @param {config.ConfigDownload} downloadConfigs Download section configs
 * @param {MultiProgressBar} [multiProgressBar=null] MultiProgressBar instance to render download status
 * @returns {Promise<void>}
 */
async function downloadRecording(recording, course, downloadConfigs, multiProgressBar = null) {
    // filename
    let filename = replaceWhitespaceChars(replaceWindowsSpecialChars(`${recording.name}.${recording.format}`, '_'), '_');
    if (course.prepend_date)
        filename = `${getUTCDateTimestamp(recording.created_at, '')}-${filename}`;

    // Make folder structure for downloadPath
    let folderPath = join(
        downloadConfigs.base_path,
        course.name ? `${course.name}_${course.id}` : `${course.id}`
    );
    await mkdirIfNotExists(folderPath);

    /** Final file save-path after download its complete */
    let downloadFilePath = join(folderPath, filename);
    /** hash of the recording's resulting filename */
    let filenameHash = createHash('sha1').update(filename).digest('hex');
    /** Temporary save-path folder, used until the download its complete */
    let tmpDownloadFolderPath = join('./tmp/', filenameHash);




    if (existsSync(downloadFilePath)) {
        if (downloadConfigs.show_existing)
            logger.info(`   └─ Already exists: ${recording.name}`);
        return;
    }

    logger.info(`   └─ Downloading: ${recording.name}`);
    const downloadName = getUTCDateTimestamp(recording.created_at, '');

    try {
        await mkdirIfNotExists(tmpDownloadFolderPath);
        let tmpDownloadFilePath = join(tmpDownloadFolderPath, 'recording.mp4');
        let fileIsStream = false;

        // Try to use webex download feature and if it fails, fallback to hls stream feature
        try {
            logger.debug(`      └─ [${downloadName}] Trying download feature`);
            const downloadUrl = await getWebexRecordingDownloadUrl(recording.file_url, recording.password);

            let dwnl = new StreamDownload();
            if (downloadConfigs.progress_bar)
                new StatusProgressBar(
                    multiProgressBar,
                    dwnl.emitter,
                    (data) => `[${downloadName}] ${bytes(parseInt(data.filesize), BYTES_OPTIONS).padStart(9)}`,
                    (data) => data.filesize,
                    (data) => data.chunk.length);
            await dwnl.downloadStream(downloadUrl, tmpDownloadFilePath);
        } catch (error) {
            fileIsStream = true;
            logger.warn(`      └─ [${downloadName}] ${error}`);
            logger.info(`      └─ [${downloadName}] Trying downloading stream`);
            const { playlistUrl, filesize } = await retryPromise(10, 1000, () => getWebexRecordingHSLPlaylist(recording.recording_url, recording.password));
            let dwnl = new HLSDownload(tmpDownloadFolderPath);
            if (downloadConfigs.progress_bar)
                new StatusProgressBar(
                    multiProgressBar,
                    dwnl.emitter,
                    (data) => `[${downloadName}] ${(data.stage === 'DOWNLOAD') ? (bytes(parseInt(filesize), BYTES_OPTIONS).padStart(9)) : 'MERGE'}`,
                    (data) => data.segmentsCount,
                    () => null);
            await dwnl.downloadHLS(playlistUrl, tmpDownloadFilePath);
        }

        // Download was successful, move rec to destination.
        if (fileIsStream && downloadConfigs.fix_streams_with_ffmpeg) {
            let progressBar = new OneShotProgressBar(multiProgressBar, `[${downloadName}] REMUX`);
            progressBar.init();

            await HLSDownload.remuxVideoWithFFmpeg(tmpDownloadFilePath, downloadFilePath);
            unlinkSync(tmpDownloadFilePath);

            progressBar.complete();
        } else {
            moveFile(tmpDownloadFilePath, downloadFilePath);
        }
    } catch (err) {
        logger.error(`      └─ [${downloadName}] Skipped because of: ${err.message}`);
        return;
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
            await processCourseRecordings(course, recordings.recordings, configs.download);
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
