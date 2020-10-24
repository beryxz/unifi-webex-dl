const { join } = require('path');
const { existsSync, access, readFileSync, mkdir } = require('fs');
const logger = require('./logging')('config');

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
        if (isNone(c.name))
            throw new Error('Invalid config file. A course is missing the \'name\'');
    }
}

/**
 * Asynchronously make the dir path if it doesn't exists
 * @param {string} dir_path The path to the dir
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
 * @param {string} configPath
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
    let username = process.env['CREDENTIALS__USERNAME'] || config.credentials?.username,
        password = process.env['CREDENTIALS__PASSWORD'] || config.credentials?.password,
        base_path = (process.env['DOWNLOAD__BASE_PATH']) || config.download?.base_path,
        progress_bar = ((process.env['DOWNLOAD__PROGRESS_BAR']) || config.download?.progress_bar) ?? true,
        show_existing = ((process.env['DOWNLOAD__SHOW_EXISTING']) || config.download?.show_existing) ?? true,
        courses;

    // Work on course objects
    if (process.env['COURSES']) {
        // 123000=Course1,234000=Course2 ...
        process.env['COURSES']
            .split(',')
            .map(c => c.split('='))
            .map(c => { return { id: c[0], name: c[1] }; });
    } else {
        courses = config.courses;
    }

    // check for all required configs
    checkConfigs({username, password, base_path});
    checkCourses(courses);

    // create courses paths as 'name_id'
    try {
        logger.debug('Checking folder structure');
        await Promise.all(courses
            .map(c => `${c.name}_${c.id}`)
            .map(name => mkdirIfNotExists(join(base_path, ''+name))));
    } catch (err) {
        throw new Error(`Error creating folder structure. ${err.message}`);
    }

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