const { join } = require('path');
const { existsSync, access, readFileSync, mkdir } = require('fs');
const logger = require('./logging')('config');

/**
 * Assert that every config isn't undefined or null
 * @param {Object} configs Object of configs
 * @throws Error with erroneous config
 */
function checkConfigs(configs) {
    for (const config in configs) {
        if (configs[config] === undefined || configs[config] === null)
            throw new Error(`Missing config: ${config}`);
    }
}

/**
 * Asynchronously make the dir path if it doesn't exists
 * @param {String} dir_path The path to the dir
 * @returns {Promise}
 */
function mkdirIfNotExists(dir_path) {
    return new Promise((resolve, reject) => {
        // try to access
        access(dir_path, (err) => {
            if (err && err.code === 'ENOENT') {
                // dir doesn't exist, creating it
                mkdir(dir_path, { recursive: true }, (err) => {
                    if (err)
                        reject(`Error creating directory. ${err.code}`);
                    resolve();
                });
            }

            // dir exists
            resolve();
        });
    });
}

/**
 * Read configs from file and/or envariable variables if set.
 * @param {String} configPath
 */
async function load(configPath) {
    logger.debug(`Loading ${configPath}`);

    // Try to load file
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
        courses_ids = (process.env['COURSES_IDS']) ? process.env['COURSES_IDS'].split(',') : config.courses_ids,
        base_path = (process.env['BASE_PATH']) || config.base_path;

    // check for all required configs
    checkConfigs({username, password, courses_ids, base_path});

    // create courses paths
    try {
        logger.debug('Checkig folder structure');
        await Promise.all(courses_ids.map(id => mkdirIfNotExists(join(base_path, ''+id))));
    } catch (err) {
        throw new Error(`Error creating folder structure. ${err.message}`);
    }

    return {
        credentials: { username, password },
        courses_ids,
        base_path
    };
}

module.exports = {
    load
};