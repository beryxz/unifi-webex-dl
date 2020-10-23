const config = require('./helpers/config');
const { loginMoodle, getWebexLaunchOptions } = require('./helpers/moodle');
const { launchWebex, getWebexRecordings, getWebexRecordingUrl } = require('./helpers/webex');
const logger = require('./helpers/logging')('app');
const { join } = require('path');
const { existsSync } = require('fs');
const { downloadStream } = require('./helpers/download');

(async () => {
    try {
        // get moodle credentials and courses ids
        logger.info('Loading configs');
        let configs = await config.load('./config.json');

        // login to moodle
        logger.info('Logging into Moodle');
        const moodleSession = await loginMoodle(configs.credentials.username, configs.credentials.password);
        for (const course of configs.courses) {
            logger.info(`Working on course: ${course.id} - ${course.name}`);

            // Launch webex
            let launchParameters = await getWebexLaunchOptions(moodleSession, course.id);
            if (launchParameters === null) {
                logger.warn('└─ Webex id not found... Skipping');
            }
            let webexObject = await launchWebex(launchParameters);

            // Get recordings
            let recordings = await getWebexRecordings(webexObject);
            logger.info(`└─ Found ${recordings.length} recordings`);

            // Get all not alredy downloaded recordings
            //TODO: implement multiple downloads at once
            for (let idx = 0; idx < recordings.length; idx++) {
                const recording = recordings[idx];
                let filename = `${recording.name}.${recording.format}`.replace(/[\\/:"*?<>| ]/g, '_');
                let downloadPath = join(configs.download.base_path, `${course.name}_${course.id}`, filename);
                let divider = (idx == recordings.length-1) ? '└' : '├';

                if (!existsSync(downloadPath)) {
                    logger.info(`   ${divider}─ Downloading: ${recording.name}`);
                    try {
                        // Get download url and when ready, download it
                        const downloadUrl = await getWebexRecordingUrl(recording.file_url, recording.password);
                        await downloadStream(downloadUrl, downloadPath, configs.download.progress_bar);
                    } catch (error) {
                        logger.error(`      └─ Skipped because of ${error}`);
                        continue;
                    }
                } else {
                    logger.info(`   ${divider}─ Alredy exists: ${recording.name}`);
                }
            }
        }

        logger.info('Done');
    } catch (err) {
        logger.error(err);
    }
})();
