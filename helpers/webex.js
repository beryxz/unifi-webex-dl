const axios = require('axios').default;
const logger = require('./logging')('webex');

/**
 * Launch the webex platform and retrieve the JWT and Cookies
 * @param {String} launchParameters urlencoded string to send as post body to access webex
 * @returns {Object} { jwt, cookies }
 */
async function launchWebex(launchParameters) {
    try {
        logger.debug('Launching Webex');
        const res = await axios.post('https://lti.educonnector.io/launches', launchParameters, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        // Get only the first part of the cookie without the optional part
        const cookies = res.headers['set-cookie']
            .map(c => c.match(/^(.+?)(?:;[\s]|$)/)[1])
            .join('; ');

        // match JWT
        let jwt = res.data.match(/(?:"|&quot;)json_web_token(?:"|&quot;):(?:"|&quot;)([a-zA-Z0-9.\-_=+/]+?)(?:"|&quot;)/);
        if (jwt === null)
            throw new Error('JWT not found');
        jwt = jwt[1];
        // logger.debug(`├─ jwt: ${jwt}`);
        // logger.debug(`└─ cookies: ${cookies}`);

        return { jwt, cookies: cookies };
    } catch (err) {
        throw new Error(`Couldn't launch webex. ${err.message}`);
    }
}

async function getWebexRecording() {

}

/**
 * Get all available recordings for the given webex course
 * @param {Object} webexObject Object with { jwt, cookies }
 * @returns {Array} List of all the available recordings
 */
async function getWebexRecordings(webexObject) {
    const res = await axios.get('https://lti.educonnector.io/api/webex/recordings', {
        headers: {
            'Authorization': `Bearer ${webexObject.jwt}`,
            'Cookie': webexObject.cookies
        }
    });

    return res.data;
}

module.exports = {
    launchWebex, getWebexRecordings, getWebexRecording
};