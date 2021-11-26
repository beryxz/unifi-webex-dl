const axios = require('axios').default;
const qs = require('qs');
const cheerio = require('cheerio');
const logger = require('./logging')('moodle');
const { checkMoodleCookie } = require('./cookie');

/**
 * @typedef WebexLaunchOptions
 * @type {object}
 * @property {string|null} launchParameters Parameters to set in the post request to launch webex. Should be 'null' if webex course id is also 'null'
 * @property {string} webexCourseId Id of the course on Webex
 * @property {string} moodleCourseId Id of the course on Moodle
 */

class Moodle {
    _sessionToken;
    get sessionToken() {
        return this._sessionToken;
    }
    set sessionToken(value) {
        this._sessionToken = value;
    }

    constructor() {}

    /**
     * Old way of Logging into the Moodle platform.
     * @deprecated since version 4.0.0
     * @param {string} username Moodle username
     * @param {string} password Moodle password
     * @returns {string} Moodle session token cookie
     */
    async loginMoodle(username, password) {
        let res, loginToken, cookie;

        // get loginToken
        logger.debug('Loading login');
        res = await axios.get('https://e-l.unifi.it/login/index.php');
        loginToken = res.data.match(/logintoken" value="(.+?)"/)[1];
        cookie = checkMoodleCookie(res.headers['set-cookie']);
        logger.debug(`├─ Cookie: ${cookie}`);
        logger.debug(`└─ loginToken: ${loginToken}`);

        // post credentials
        logger.debug('Posting form to login');
        res = await axios.post('https://e-l.unifi.it/login/index.php', qs.stringify({
            anchor: null,
            logintoken: loginToken,
            username: username,
            password: password,
            rememberusername: 0
        }), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': cookie
            },
            maxRedirects: 0,
            validateStatus: status => status >= 200 && status < 300 || status === 303
        });
        cookie = checkMoodleCookie(res.headers['set-cookie']);
        logger.debug(`└─ Cookie: ${cookie}`);

        // Check credentials
        logger.debug('Checking credentials');
        res = await axios.get('https://e-l.unifi.it/login/index.php', {
            headers: {
                'Cookie': cookie
            }
        });
        if (res.data.match(/loginerrormessage/) !== null) {
            throw new Error('Invalid credentials');
        }

        return cookie;
    }

    /**
     * Login into Moodle platform through the "Autenticazione Unica UniFi" portal.
     * @param {string} username Moodle username
     * @param {string} password Moodle password
     * @returns {Promise<void>}
     */
    async loginMoodleUnifiedAuth(username, password) {
        let res, executionToken, cookie;

        // get loginToken
        logger.debug('Loading login portal');
        res = await axios.get('https://identity.unifi.it/cas/login?service=https://e-l.unifi.it/login/index.php?authCASattras=CASattras');
        executionToken = res.data.match(/name="execution" value="(.+?)"/)[1];

        logger.debug('Posting form to login portal');
        res = await axios.post('https://identity.unifi.it/cas/login?service=https://e-l.unifi.it/login/index.php?authCASattras=CASattras', qs.stringify({
            username: username,
            password: password,
            execution: executionToken,
            _eventId: 'submit',
            geolocation: ''
        }), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            maxRedirects: 0,
            validateStatus: status => status === 302 || status === 303
        });

        logger.debug('Login on Moodle with ticket');
        res = await axios.get(res.headers.location, {
            maxRedirects: 0,
            validateStatus: status => status === 302 || status === 303
        });
        cookie = checkMoodleCookie(res.headers['set-cookie']);

        logger.debug('Getting authorized session token');
        res = await axios.get(res.headers.location, {
            headers: {
                'Cookie': cookie
            },
            maxRedirects: 0,
            validateStatus: status => status === 302 || status === 303
        });
        this.sessionToken = checkMoodleCookie(res.headers['set-cookie']);
    }

    /**
     * Extract the course name from the moodle course page
     * @requires //TODO auth
     * @param {number} courseId Moodle course id
     * @returns {String|null} The course name if it was found, null otherwise
     * @throws when axios request wasn't successful
     */
    async getCourseName(courseId) {
        const res = await axios.get('https://e-l.unifi.it/course/view.php', {
            params: {
                id: courseId
            },
            headers: {
                'Cookie': this.sessionToken
            }
        });

        // Match the course name
        return cheerio.load(res.data)('h1').text();
    }

    /**
     * Extract the webex id from the moodle course page
     * @requires //TODO auth
     * @param {number} courseId Moodle course id
     * @returns {null|string} The id if it was found, null otherwise
     * @throws when axios request wasn't successful
     */
    async getWebexId(courseId) {
        const res = await axios.get('https://e-l.unifi.it/course/view.php', {
            params: {
                id: courseId
            },
            headers: {
                'Cookie': this.sessionToken
            }
        });

        // Match the webex id
        // Match the canonical `launch.php` path
        let match = res.data.match(/https:\/\/e-l\.unifi\.it\/mod\/lti\/(?:launch)\.php\?id=(\d+)/);
        if (!match) {
            // Check for unreliable `view.php` paths
            let matches = [ ...res.data.matchAll(/https:\/\/e-l\.unifi\.it\/mod\/lti\/(?:view)\.php\?id=(\d+)/g) ];
            if (matches.length === 1) {
                // If there's only one match, use that
                match = matches[0];
            } else {
                // If there are multiple `view.php` entries, try to use the one with the webex logo
                match = res.data.match(/https:\/\/e-l\.unifi\.it\/mod\/lti\/(?:view)\.php\?id=(\d+)"><img src="https:\/\/www.webex.com\//);
            }
        }
        return (match === null) ? null : match[1];
    }

    /**
     * Get the required parameters to access the webex page of the webex course extracted from, the moodle page of the given course id.
     * @requires //TODO auth
     * @param {number} courseId Course id from which to retrieve webexId and then the relative launch parameters
     * @param {string|number} [customWebexId=null] Custom Webex id that override the one found in the course page, if defined
     * @return {WebexLaunchOptions}
     */
    async getWebexLaunchOptions(courseId, customWebexId=null) {
        try {
            // Get webex id if not overridden
            let webexId;
            if (customWebexId == null || customWebexId == undefined) {
                webexId = await this.getWebexId(courseId);
                if (webexId === null) throw new Error('Webex id not found');
            } else {
                webexId = customWebexId;
            }

            // Get launch parameters
            const res = await axios.get('https://e-l.unifi.it/mod/lti/launch.php', {
                params: {
                    id: webexId
                },
                headers: {
                    'Cookie': this.sessionToken
                }
            });

            const launchParameters = cheerio.load(res.data)('form').serialize();
            const moodleCourseId = launchParameters.match(/context_id=(\d+)/)?.[1];
            logger.debug(`Webex id: ${moodleCourseId} -> ${webexId}`);

            // Convert the html form in urlencoded string for post body
            return {
                launchParameters: launchParameters,
                moodleCourseId: moodleCourseId,
                webexCourseId: webexId
            };
        } catch (err) {
            throw new Error(`Error while loading launch options for webex: ${err.message}`);
        }
    }
}

module.exports = {
    Moodle
};