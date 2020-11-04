const axios = require('axios').default;
const qs = require('qs');
const cheerio = require('cheerio');
const logger = require('./logging')('moodle');
const { checkMoodleCookie } = require('./cookie');

/**
 * Login into Moddle platform and return sessionToken cookie.
 * @param {string} username Moodle username
 * @param {string} password Moodle password
 * @returns {string} Moodle session token cookie
 */
async function loginMoodle(username, password) {
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
            'Cookie': sessionToken
        }
    });

    // Match the course name
    return cheerio.load(res.data)('h1').text();
}

/**
 * Extract the webex id from the moodle course page
 * @param {string} sessionToken Moodle session cookie
 * @param {number} courseId Moodle course id
 * @returns {null|number} The id if it was found, null otherwise
 * @throws when axios request wasn't successful
 */
async function getWebexId(sessionToken, courseId) {
    const res = await axios.get('https://e-l.unifi.it/course/view.php', {
        params: {
            id: courseId
        },
        headers: {
            'Cookie': sessionToken
        }
    });

    // Match the webex id
    const match = res.data.match(/https:\/\/e-l\.unifi\.it\/mod\/lti\/(?:launch|view)\.php\?id=(\d+)/);
    return (match === null) ? null : match[1];
}

/**
 * Get the required parameters to access the webex page of the webex course extracted from, the moodle page of the given course id.
 * @param {string} sessionToken MoodleSession cookie used to authenticate
 * @param {number} courseId Course id from which to retrieve webexId and then the relative launch parameters
 * @return {String|null} Parameters to set in the post request to launch webex. null if webex course id couldn't be found.
 */
async function getWebexLaunchOptions(sessionToken, courseId) {
    try {
        // Get webex id
        const webexId = await getWebexId(sessionToken, courseId);
        if (webexId === null)
            return null;
        logger.debug(`Webex id: ${webexId}`);

        // Get launch parameters
        const res = await axios.get('https://e-l.unifi.it/mod/lti/launch.php', {
            params: {
                id: webexId
            },
            headers: {
                'Cookie': sessionToken
            }
        });

        // Convert the html form in urlencoded string for post body
        return cheerio.load(res.data)('form').serialize();
    } catch (err) {
        throw new Error(`Error while loading launch options for webex. ${err.message}`);
    }
}

module.exports = {
    loginMoodle, getCourseName, getWebexLaunchOptions
};