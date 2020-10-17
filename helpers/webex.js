const axios = require('axios').default;
const logger = require('./logging')('webex');
const cheerio = require('cheerio');
const { getCookies } = require('./cookie');

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
        const cookies = getCookies(res.headers['set-cookie']);

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

/**
 * Get all available recordings for the given webex course
 * @param {Object} webexObject Object with { jwt, cookies }
 * @returns {Array} List of all the available recordings
 */
async function getWebexRecordings(webexObject) {
    logger.debug('Get recordings');
    const res = await axios.get('https://lti.educonnector.io/api/webex/recordings', {
        headers: {
            'Authorization': `Bearer ${webexObject.jwt}`,
            'Cookie': webexObject.cookies
        }
    });

    return res.data;
}

/**
 * Download a recording from webex and save it to 'savePath'
 * @param {String} fileUrl The webex recording file url from which to start the download procedure
 * @param {String} password The webex recording password
 * @param {String} savePath The file in which to save the recording
 */
async function getWebexRecording(fileUrl, password, savePath) {
    let res;

    // Get recording params in urlencoded format
    logger.debug('Getting params for recordingpasswordcheck.do');
    res = await axios.get(fileUrl);

    const form = cheerio.load(res.data)('form');
    // format params as urlEncoded
    let params = form.serialize().replace(/password=/, `password=${password}`);
    if (res.data.includes('document.forms[0].firstEntry.value=false;')) { // Don't know the reason.
        params = params.replace('firstEntry=true', 'firstEntry=false');
    }
    // add origin to relative actionUrl
    let origin = new URL(fileUrl).origin;
    let actionUrl = new URL(form.attr('action'), origin);

    // Check recording password
    logger.debug('Checking params with recordingpasswordcheck.do');
    res = await axios.post(actionUrl.toString(), params, {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
    });
    // parse params for nbrshared.do in response
    let dwnlPrepareUrl = new URL(res.data.match(/href=(?:'|")(http.+?nbrshared\.do.+?)(?:'|")/)[1]);

    // post to nbrshared.do
    logger.debug('Posting to nbrshared.do');
    res = await axios.post(dwnlPrepareUrl.origin, dwnlPrepareUrl.search.substring(1), {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    });


    //TODO:
    // parse nbrPrepare.do params
    // get nbrPrepare.do
    // match `window.parent.func_prepare('***','***','***');
    // status case switch
    // if OKOK get recording stream and save to file

}

module.exports = {
    launchWebex, getWebexRecordings, getWebexRecording
};
