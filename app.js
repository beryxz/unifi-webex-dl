const config = require('./helpers/config');
const { loginMoodle, getCourseName, getWebexLaunchOptions } = require('./helpers/moodle');
const { launchWebex, getWebexRecordings, getWebexRecordingDownloadUrl, getWebexRecordingHSLPlaylist } = require('./helpers/webex');
const logger = require('./helpers/logging')('app');
const { join } = require('path');
const { existsSync, renameSync, rmdirSync } = require('fs');
const { downloadStream, downloadHLSPlaylist, mkdirIfNotExists } = require('./helpers/download');
const { getUTCDateTimestamp } = require('./helpers/date');

(async () => {
    try {
        // get moodle credentials and courses ids
        logger.info('Loading configs');
        let configs = await config.load('./config.json');

        // tmp folder for downloads
        try {
            // remove temp files since they might not always be overwritten
            rmdirSync('./tmp', { recursive: true });
            await mkdirIfNotExists('./tmp');
        } catch (err) {
            throw new Error(`Error while creating tmp folder: ${err.message}`);
        }

        // login to moodle
        logger.info('Logging into Moodle');
        const moodleSession = await loginMoodle(configs.credentials.username, configs.credentials.password);
        for (const course of configs.courses) {
            const courseNameUnspecified = !course.name;
            logger.info(`Working on course: ${course.id}${courseNameUnspecified ? '' : ' - ' + course.name}`);

            // Get course name if unspecified
            if (!course.name) {
                course.name = await getCourseName(moodleSession, course.id);
                logger.info(`Got course name: ${course.name}`);
            }

            // Launch webex
            const launchParameters = await getWebexLaunchOptions(moodleSession, course.id);
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

            logger.info(`└─ Found ${recordingsAll.length} recordings (${recordingsAll.length - recordings.length} filtered)`);

            // Get all not already downloaded recordings
            for (let idx = 0; idx < recordings.length; idx++) {
                const recording = recordings[idx];

                // filename
                let filename = `${recording.name}.${recording.format}`.replace(/[\\/:"*?<>| ]/g, '_');
                if (course.prepend_date)
                    filename = `${getUTCDateTimestamp(recording.created_at, '')}-${filename}`;

                // Make folder structure for downloadPath
                let folderPath = join(
                    configs.download.base_path,
                    courseNameUnspecified ? course.name : `${course.name}_${course.id}`
                );
                let downloadPath = join(folderPath, filename);
                let tmpDownloadPath = join('./tmp/', filename);
                try {
                    await mkdirIfNotExists(folderPath);
                } catch (err) {
                    throw new Error(`Error while creating folder structure: ${err.message}`);
                }

                // If recording doesn't exists start the download procedure
                if (!existsSync(downloadPath)) {
                    logger.info(`   └─ Downloading: ${recording.name}`);
                    try {
                        // Try to use webex download feature and if it fails, fallback to hls stream feature
                        try {
                            logger.debug('      └─ Trying download feature');
                            const downloadUrl = await getWebexRecordingDownloadUrl(recording.file_url, recording.password);
                            await downloadStream(downloadUrl, tmpDownloadPath, configs.download.progress_bar);
                        } catch {
                            logger.info('      └─ Trying downloading stream (may be slower)');
                            const { playlistUrl, filesize } = await getWebexRecordingHSLPlaylist(recording.recording_url, recording.password);
                            await downloadHLSPlaylist(playlistUrl, tmpDownloadPath, filesize, configs.download.progress_bar);
                        }

                        // Download was successful, move rec to destination
                        logger.debug('Moving file out of tmp folder');
                        renameSync(tmpDownloadPath, downloadPath);
                    } catch (err) {
                        logger.error(`      └─ Skipped because of: ${err.message}`);
                        continue;
                    }
                } else if (configs.download.show_existing) {
                    logger.info(`   └─ Alredy exists: ${recording.name}`);
                }
            }
        }

        logger.info('Done');
    } catch (err) {
        logger.error(err);
    }
})();
