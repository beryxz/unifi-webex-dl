/**
 * Formats an array of cookies as a single string to use in http headers
 * @param {Array} cookieJar List of cookies to format
 */
function getCookies(cookieJar) {
    return cookieJar
        .map(c => c.match(/^(.+?)(?:;[\s]?|$)/)[1]) // Get only the cookie
        .join('; ');
}

/**
 * Retrieves the MoodleSession cookie from the array if exists. Throw an error otherwise
 * @param {Array} cookies Cookies jar
 * @returns {string} The MoodleSession cookie if found
 * @throws {Error} If the MoodleSession cookie couldn't be found
 */
function checkMoodleCookie(cookies) {
    for (const c of cookies) {
        if (c.startsWith('MoodleSession='))
            return c;
    }

    throw new Error('Invalid cookies');
}

module.exports = {
    checkMoodleCookie, getCookies
};
