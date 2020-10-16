const config = require('./helpers/config');
const { loginMoodle, getWebexLaunchOptions } = require('./helpers/moodle');
const { launchWebex, getWebexRecordings, getWebexRecording } = require('./helpers/webex');
const logger = require('./helpers/logging')('app');

// get moodle credentials and courses ids
logger.info('Loading configs');
let configs = config.load('./config.json');

(async () => {
    try {
        // login to moodle
        logger.info('Logging into Moodle');
        const moodleSession = await loginMoodle(configs.credentials.username, configs.credentials.password);

        for (const id of configs.courses_ids) {
            logger.info(`Working on course: ${id}`);

            // Launch webex
            let launchParameters = await getWebexLaunchOptions(moodleSession, id);
            if (launchParameters === null) {
                logger.warn('└─ Webex id not found... Skipping');
            }
            let webexObject = await launchWebex(launchParameters);

            // Get recordings
            let recordings = await getWebexRecordings(webexObject);
            logger.info(`└─ Found ${recordings.length} recordings`);
        //     recordings.forEach(recording => {
        //         getWebexRecording(recording);
        //     });
        }
    } catch (err) {
        logger.error(err);
    }
})();
