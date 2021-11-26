const { existsSync, readFileSync } = require('fs');
const { isNone, isFilenameValidOnWindows } = require('./utils');
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
 * @typedef ConfigDownload
 * @type {object}
 * @property {string} base_path
 * @property {boolean} progress_bar
 * @property {boolean} show_existing
 * @property {number} max_concurrent_downloads
 * @property {boolean} fix_streams_with_ffmpeg
 */

/**
 * @typedef ConfigCredentials
 * @type {object}
 * @property {string} username
 * @property {string} password
 */

/**
 * @typedef Config
 * @type {object}
 * @property {ConfigCredentials} credentials
 * @property {ConfigDownload} download
 * @property {Course[]} courses
 */

/**
 * Assert that every config isn't undefined or null
 * @param {object} configs Object of configs
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
 * @param {Course[]} courses Array of course objects
 */
function checkCourses(courses) {
    for (const c of courses) {
        if (isNone(c.id))
            throw new Error('Invalid config file. A course is missing the \'id\'');
        if (typeof(c.id) !== 'number')
            throw new Error('Invalid config file. A course\'s \'id\' is not a number');
        if (isNone(c.name))
            throw new Error(`Invalid config file. The [${c.id}] course is missing the 'name'`);
        if (typeof(c.name) !== 'string')
            throw new Error(`Invalid config file. The [${c.id}] course's 'name' is not a string`);

        if (!isFilenameValidOnWindows(c.name))
            logger.warn(`The [${c.id}] course has a 'name' which contains Windows reserved chars. On Windows this won't work!`);
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
        max_concurrent_downloads = ((process.env['DOWNLOAD__MAX_CONCURRENT_DOWNLOADS']) || config.download?.max_concurrent_downloads) ?? 3,
        fix_streams_with_ffmpeg = ((process.env['DOWNLOAD__FIX_STREAMS_WITH_FFMPEG']) || config.download?.fix_streams_with_ffmpeg) ?? false,
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
    //TODO if ffmpeg autofix is enable, check that ffmpeg is available as a command in the system path. Additionally, check that the h264/MPEG-4 formats are supported for muxing/demuxing using "ffmpeg -formats"

    return {
        credentials: {
            username,
            password
        },
        download: {
            base_path,
            progress_bar: !!progress_bar,
            show_existing: !!show_existing,
            max_concurrent_downloads,
            fix_streams_with_ffmpeg: !!fix_streams_with_ffmpeg
        },
        courses
    };
}

module.exports = {
    load
};