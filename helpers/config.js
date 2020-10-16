const { existsSync } = require('fs');
const logger = require('./logging')('config');
const { readFileSync } = require('fs');

/**
 * Read configs from file and/or envariable variables if set.
 * @param {String} configPath 
 */
function load(configPath) {
    logger.debug(`Loading ${configPath}`);
    
    // Try to laod file
    let config;
    if (!existsSync(configPath)) {
        logger.warn(`Missing file ${configPath}`);
        config = {};
    } else {
        config = JSON.parse(readFileSync(configPath, 'utf8'));
    }

    // Read env variables and if not exists, assign config file values
    logger.debug('Reading env variables');
    let username = process.env['MOODLE_USERNAME'] || config.credentials?.username,
        password = process.env['MOODLE_PASSWORD'] || config.credentials?.password,
        courses_ids = (process.env['COURSES_IDS']) ? process.env['COURSES_IDS'].split(',') : config.courses_ids;

    // check for all required configs
    if (username === undefined || password === undefined || courses_ids === undefined ) {
        logger.error('Couldn\'t read all required configs.');
        throw new Error('Some required configs are missing');
    }
    
    return {
        credentials: { username, password },
        courses_ids
    };
}

module.exports = {
    load
};