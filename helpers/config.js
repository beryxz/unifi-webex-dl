const { existsSync, readFileSync } = require('fs');
const logger = require('./logging')('config');
const yaml = require('yaml');

/**
 * @typedef Course
 * @type {object}
 * @property {string} id
 * @property {string} name
 * @property {string} custom_webex_id
 * @property {string} skip_names
 * @property {string} skip_before_date
 * @property {string} skip_after_date
 * @property {boolean} prepend_date
 */

/**
 * @typedef Config
 * @type {object}
 * @property {object} credentials
 * @property {object} credentials.username
 * @property {object} credentials.password
 * @property {object} download
 * @property {object} download.base_path
 * @property {object} download.progress_bar
 * @property {object} download.show_existing
 * @property {Course[]} courses
 */

/**
 * Check whether the given object is undefined, null, empty string or empty object
 * @param {any} object to entity to check
 */
function isNone(object) {
    return typeof object === 'undefined' || object === null || object === '' || object === {};
}

/**
 * Assert that every config isn't undefined or null
 * @param {Object} configs Object of configs
 * @throws Error with erroneous config
 */
function checkConfigs(configs) {
    for (const config in configs) {
        if (isNone(configs[config]))
            throw new Error(`Missing config: ${config}`);
    }
}

/**
 * Check that each Course object in the array is valid
 * @param {Array} courses Array of course objects
 */
function checkCourses(courses) {
    for (const c of courses) {
        if (isNone(c.id))
            throw new Error('Invalid config file. A course is missing the \'id\'');
    }
}

/**
 * @param {string} configPath
 */
function parseJson(configPath) {
    return JSON.parse(readFileSync(configPath, 'utf8'));
}
/**
 * @param {string} configPath
 */
function parseYaml(configPath) {
    return yaml.parse(readFileSync(configPath, 'utf8'));
}
/**
 * @param {string} configPath
 */
function parseConfigFile(configPath) {
    if (!existsSync(configPath)) {
        logger.warn(`Missing file ${configPath}`);
        return {};
    }

    switch (configPath.match(/\.([a-z]+)$/)?.[1]) {
    case 'json':
        return parseJson(configPath);
    case 'yaml':
        return parseYaml(configPath);
    default:
        return {};
    }
}

/**
 * Read configs from file and/or env variables if set.
 * @param {string} configPath
 * @return {Config} Configs object
 */
async function load(configPath) {
    logger.debug(`Loading ${configPath}`);

    // Try to load file
    let config = parseConfigFile(configPath);

    // Read env variables and if not exists, assign config file values
    logger.debug('Reading env variables');
    let username = process.env['CREDENTIALS__USERNAME'] || config.credentials?.username,
        password = process.env['CREDENTIALS__PASSWORD'] || config.credentials?.password,
        base_path = (process.env['DOWNLOAD__BASE_PATH']) || config.download?.base_path,
        progress_bar = ((process.env['DOWNLOAD__PROGRESS_BAR']) || config.download?.progress_bar) ?? true,
        show_existing = ((process.env['DOWNLOAD__SHOW_EXISTING']) || config.download?.show_existing) ?? true,
        courses;

    // Work on course objects
    if (process.env['COURSES']) {
        // 123000=Course1,234000=Course2 ...
        courses = process.env['COURSES']
            .split(',')
            .map(c => c.split('='))
            .map(c => { return { id: c[0], name: c[1] }; });
    } else {
        courses = config.courses;
    }

    // check for all required configs
    checkConfigs({username, password, base_path});
    checkCourses(courses);

    return {
        credentials: {
            username,
            password
        },
        download: {
            base_path,
            progress_bar: !!progress_bar,
            show_existing: !!show_existing
        },
        courses
    };
}

module.exports = {
    load
};