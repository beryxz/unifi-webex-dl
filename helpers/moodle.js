const axios = require('axios').default;
const qs = require('qs');
const cheerio = require('cheerio');
const logger = require('./logging')('moodle');
const { checkMoodleCookie } = require('./cookie');

/**
 * Old way of Logging into the Moddle platform.
 * @deprecated since version 4.0.0
 * @param {string} username Moodle username
 * @param {string} password Moodle password
 * @returns {string} Moodle session token cookie
 */
async function loginMoodle(username, password) {
    let res, loginToken, cookie;

    // get loginToken
    logger.debug('Loading login');
    res = await axios.get('https://e-l.unifi.it/login/index.php', { headers: { 'User-Agent': 'Mozilla/5.0' } });
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
            'Cookie': cookie,
            'User-Agent': 'Mozilla/5.0'
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
            'Cookie': cookie,
            'User-Agent': 'Mozilla/5.0'
        }
    });
    if (res.data.match(/loginerrormessage/) !== null) {
        throw new Error('Invalid credentials');
    }

    return cookie;
}

/**
 * Login into Moddle platform through the "Autenticazione Unica UniFi" portal.
 * @param {string} username Moodle username
 * @param {string} password Moodle password
 * @returns {string} Moodle session token cookie
 */
async function loginMoodleUnifiedAuth(username, password) {
    let res, executionToken, cookie;

    // get loginToken
    logger.debug('Loading login portal');
    res = await axios.get('https://identity.unifi.it/cas/login?service=https://e-l.unifi.it/login/index.php?authCASattras=CASattras', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    executionToken = res.data.match(/name="execution" value="(.+?)"/)[1];
    logger.debug(`└─ executionToken: ${executionToken}`);

    // post credentials
    logger.debug('Posting form to login portal');
    res = await axios.post('https://identity.unifi.it/cas/login?service=https://e-l.unifi.it/login/index.php?authCASattras=CASattras', qs.stringify({
        username: username,
        password: password,
        execution: executionToken,
        _eventId: 'submit',
        geolocation: ''
    }), {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0'
        },
        maxRedirects: 0,
        validateStatus: status => status === 302 || status === 303
    });

    // post credentials
    logger.debug('Login on Moodle with ticket');
    res = await axios.get(res.headers.location, {
        headers: {
            'User-Agent': 'Mozilla/5.0'
        },
        maxRedirects: 0,
        validateStatus: status => status === 302 || status === 303
    });
    cookie = checkMoodleCookie(res.headers['set-cookie']);
    logger.debug(`└─ Cookie: ${cookie}`);

    // post credentials
    logger.debug('Getting authorized session token');
    res = await axios.get(res.headers.location, {
        headers: {
            'Cookie': cookie,
            'User-Agent': 'Mozilla/5.0'
        },
        maxRedirects: 0,
        validateStatus: status => status === 302 || status === 303
    });
    cookie = checkMoodleCookie(res.headers['set-cookie']);
    logger.debug(`└─ Cookie: ${cookie}`);

    return cookie;
}

/**
 * Extract the course name from the moodle course page
 * @param {string} sessionToken Moodle session cookie
 * @param {number} courseId Moodle course id
 * @returns {String|null} The course name if it was found, null otherwise
 * @throws when axios request wasn't successful
 */
async function getCourseName(sessionToken, courseId) {
    const res = await axios.get('https://e-l.unifi.it/course/view.php', {
        params: {
            id: courseId
        },
        headers: {
            'Cookie': sessionToken,
            'User-Agent': 'Mozilla/5.0'
        }
    });

    // Match the course name
    return cheerio.load(res.data)('h1').text();
}

/**
 * Extract the webex id from the moodle course page
 * @param {string} sessionToken Moodle session cookie
 * @param {number} courseId Moodle course id
 * @returns {null|string} The id if it was found, null otherwise
 * @throws when axios request wasn't successful
 */
async function getWebexId(sessionToken, courseId) {
    const res = await axios.get('https://e-l.unifi.it/course/view.php', {
        params: {
            id: courseId
        },
        headers: {
            'Cookie': sessionToken,
            'User-Agent': 'Mozilla/5.0'
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
 * @param {string} sessionToken MoodleSession cookie used to authenticate
 * @param {number} courseId Course id from which to retrieve webexId and then the relative launch parameters
 * @param {string|number} [customWebexId=null] Custom Webex id that override the one found in the course page, if defined
 * @return {string|null} Parameters to set in the post request to launch webex. null if webex course id couldn't be found.
 */
async function getWebexLaunchOptions(sessionToken, courseId, customWebexId=null) {
    try {
        // Get webex id if not overridden
        let webexId;
        if (customWebexId == null || customWebexId == undefined) {
            webexId = await getWebexId(sessionToken, courseId);
            if (webexId === null)
                return null;
        } else {
            webexId = customWebexId;
        }
        logger.debug(`Webex id: ${webexId}`);

        // Get launch parameters
        const res = await axios.get('https://e-l.unifi.it/mod/lti/launch.php', {
            params: {
                id: webexId
            },
            headers: {
                'Cookie': sessionToken,
                'User-Agent': 'Mozilla/5.0'
            }
        });

        // Convert the html form in urlencoded string for post body
        return cheerio.load(res.data)('form').serialize();
    } catch (err) {
        throw new Error(`Error while loading launch options for webex. ${err.message}`);
    }
}

module.exports = {
    loginMoodleUnifiedAuth, getCourseName, getWebexLaunchOptions
};