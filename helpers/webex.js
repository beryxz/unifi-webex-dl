const axios = require('axios').default;
const logger = require('./logging')('webex');
const cheerio = require('cheerio');
const { createWriteStream, unlinkSync } = require('fs');
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
    let res, url, params;

    res = await axios.get(fileUrl);
    if (/Impossibile trovare la pagina/.test(res.data))
        throw new Error('Recording has been deleted or isn\'t available at the moment');

    //TODO: This only works for mettings. Add downloads for events

    // Check if password is required
    if (/recordingpasswordcheck\.do/.test(res.data)) {
        // Get params for recordingpasswordcheck.do
        logger.debug('Getting params for recordingpasswordcheck.do');
        const form = cheerio.load(res.data)('form');
        // format params as urlEncoded
        params = form.serialize().replace(/password=/, `password=${password}`);
        if (res.data.includes('document.forms[0].firstEntry.value=false;')) { // Don't know the reason.
            params = params.replace('firstEntry=true', 'firstEntry=false');
        }
        // add origin to relative actionUrl
        let origin = new URL(fileUrl).origin;
        let actionUrl = new URL(form.attr('action'), origin);

        // Check recordingpasswordcheck.do
        logger.debug('Checking params with recordingpasswordcheck.do');
        res = await axios.post(actionUrl.toString(), params, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
        });

        // parse params for nbrshared.do in response
        url = new URL(res.data.match(/href=['"](http.+?nbrshared\.do.+?)['"]/)[1]);

        // post to nbrshared.do
        logger.debug('Posting to nbrshared.do');
        res = await axios.post(url.origin + url.pathname, url.search.substring(1), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });
    } else {
        logger.debug('No password required');
    }

    // parse nbrPrepare.do params
    logger.debug('Parsing nbrPrepare params');
    let recordId = res.data.match(/var recordId\s*?=\s*?(\d+);/)?.[1],
        serviceRecordId = res.data.match(/var serviceRecordId\s*?=\s*?(\d+);/)?.[1],
        prepareTicket = res.data.match(/var prepareTicket\s*?=\s*?['"]([a-f0-9]+)['"];/)?.[1],
        downloadUrl = res.data.match(/var downloadUrl\s*?=\s*?['"](http.+?)['"][\s;]/)?.[1];
    // Check if params were parsed successfully
    if (recordId === null || prepareTicket === null || downloadUrl === null)
        throw new Error('Some required parameters couldn\'t be parsed');
    logger.debug(`├─ recordId: ${recordId}`);
    logger.debug(`├─ serviceRecordId: ${serviceRecordId}`);
    logger.debug(`├─ downloadUrl: ${downloadUrl}`);
    logger.debug(`└─ ticket: ${prepareTicket}`);
    // Prepare params object
    params = { recordid: recordId, prepareTicket };
    if (serviceRecordId !== null && serviceRecordId > 0)
        params.serviceRecordId = serviceRecordId;

    // Wait for recording to be ready and then download it
    let status;
    while (status !== 'OKOK') {
        // get nbrPrepare.do
        logger.debug('Checking recording status nbrPrepare.do');
        res = await axios.get('https://unifirenze.webex.com/mw3300/mywebex/nbrPrepare.do', {
            params: {
                siteurl: 'unifirenze',
                ...params
            }
        });
        // parse `window.parent.func_prepare(status, url, ticket)'
        let groups = res.data.match(/func_prepare\(['"](.*?)['"],['"](.*?)['"],['"](.*?)['"]\);/);
        params = { status: groups[1], url: groups[2], ticket: groups[3]};
        if (groups === null || !['OKOK', 'Preparing'].includes(params.status))
            throw new Error('Unknown error while waiting for recording to be ready');
        logger.debug(`├─ status: ${params.status}`);
        logger.debug(`├─ url: ${params.url}`);
        logger.debug(`└─ ticket: ${params.ticket}`);

        // 'status' case switch
        if (params.status === 'OKOK') {
            // Write to file
            logger.debug('Recording ready, downloading...');
            try {
                let writer = createWriteStream(savePath);
                res = await axios.get(downloadUrl + params.ticket, {
                    responseType: 'stream'
                });
                res.data.pipe(writer);

                return new Promise((resolve, reject) => {
                    writer.on('finish', resolve);
                    writer.on('error', reject);
                });
            } catch (error) {
                // Delete created file
                unlinkSync(savePath);
            }
        }

        logger.debug('Recording not ready, waiting 3s...');
        await new Promise(r => setTimeout(r, 3000));
    }
}

module.exports = {
    launchWebex, getWebexRecordings, getWebexRecording
};
