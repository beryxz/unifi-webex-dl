const axios = require('axios').default;
const logger = require('./logging')('webex');
const cheerio = require('cheerio');
const qs = require('qs');
const { getCookies } = require('./cookie');

/**
 * @typedef Recording
 * @type {object}
 * @property {number} id
 * @property {string} name
 * @property {string} created_at
 * @property {string} updated_at
 * @property {string} recording_url
 * @property {string} timezone
 * @property {number} duration_hour
 * @property {number} duration_min
 * @property {number} duration_sec
 * @property {string} file_url
 * @property {string} format
 * @property {string} password
 */

/**
 * @typedef WebexLaunchObject
 * @type {object}
 * @property {string} webexCourseId Id of the course on webex
 * @property {string} launchParameters urlencoded string to send as post body to access webex
 * @property {string} cookies Session cookies to call webex endpoints
 */

/**
 * Time in milliseconds before timing out webex requests
 * @type {number}
 */
const WEBEX_REQUEST_TIMEOUT = 5000;

/**
 * Launch the webex platform and retrieve the JWT and Cookies
 * @param {import('./moodle').WebexLaunchOptions} webexLaunchOptions
 * @returns {Promise<WebexLaunchObject>}
 */
async function launchWebex(webexLaunchOptions) {
    logger.debug(`[${webexLaunchOptions.webexCourseId}] Launching Webex`);

    let reqConfig = {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: WEBEX_REQUEST_TIMEOUT
    };
    return axios.post('https://lti.educonnector.io/launches', webexLaunchOptions.launchParameters, reqConfig)
        .then(res => {
            return {
                webexCourseId: webexLaunchOptions.webexCourseId,
                launchParameters: webexLaunchOptions.launchParameters,
                cookies: getCookies(res.headers['set-cookie'])
            };
        })
        .catch(err => { throw new Error(`Couldn't launch webex. ${err.message}`); });

    //NOTE: API changed, shouldn't be necessary anymore. Anyway, "json_web_token" changed to "session_ticket"
    // match JWT
    // let jwt = res.data.match(/(?:"|&quot;)json_web_token(?:"|&quot;):(?:"|&quot;)([a-zA-Z0-9.\-_=+/]+?)(?:"|&quot;)/);
    // if (jwt === null)
    //     throw new Error('JWT not found');
    // jwt = jwt[1];
    // logger.debug(`├─ jwt: ${jwt}`);
    // logger.debug(`└─ cookies: ${cookies}`);
}

/**
 * Get all available recordings for the given webex course
 * @param {WebexLaunchObject} webexObject Required to interact with webex endpoints
 * @returns {Promise<Recording[]>} List of all the available recordings
 */
async function getWebexRecordings(webexObject) {
    logger.debug(`[${webexObject.webexCourseId}] Get recordings`);

    let requestConfig = {
        headers: {
            'Cookie': webexObject.cookies
        },
        timeout: WEBEX_REQUEST_TIMEOUT
    };
    return axios.get('https://lti.educonnector.io/api/webex/recordings', requestConfig)
        .then(res => res.data)
        .catch(err => {
            throw new Error(`Error retrieving recordings: ${err.message}`);
        });
}

/**
 * Get the nbrshared response for the events
 * @param {AxiosResponse} res The response from fileUrl
 * @param {Promise<string>} password The recording password
 */
async function eventRecordingPassword(res, password) {
    let url, params;
    logger.debug('Event recording');

    // Serialize params for recordAction.do
    params = cheerio.load(res.data)('form')
        .serialize()
        .replace(/playbackPasswd=/, `playbackPasswd=${password}`)
        .replace(/theAction=[a-zA-Z]*/, 'theAction=check_pass')
        .replace(/accessType=[a-zA-Z]*/, 'accessType=downloadRecording');
    url = 'https://unifirenze.webex.com/ec3300/eventcenter/recording/recordAction.do';

    // Check credentials to recordAction.do
    logger.debug('Posting to recordAction.do');
    res = await axios.post(url, params, {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    });
    const cookies = getCookies(res.headers['set-cookie']);

    // parse params for viewrecord.do
    let formId = res.data.match(/[?&]formId=(\d+)/)?.[1],
        siteurl = res.data.match(/[?&]siteurl=(\w+)/)?.[1],
        accessType = res.data.match(/[?&]accessType=(\w+)/)?.[1],
        internalPBRecordTicket = res.data.match(/[?&]internalPBRecordTicket=(\w+)/)?.[1],
        internalDWRecordTicket = res.data.match(/[?&]internalDWRecordTicket=(\w+)/)?.[1];
    // Check if params were parsed successfully
    if (formId === null || siteurl === null || accessType === null || internalPBRecordTicket === null || internalDWRecordTicket === null)
        throw new Error('Some required parameters couldn\'t be parsed');
    logger.debug(`├─ formId: ${formId}`);
    logger.debug(`├─ siteurl: ${siteurl}`);
    logger.debug(`├─ accessType: ${accessType}`);
    logger.debug(`├─ iPBRT: ${internalPBRecordTicket}`);
    logger.debug(`└─ iDWRT: ${internalDWRecordTicket}`);

    // post to viewrecord.do
    logger.debug('Posting to viewrecord.do');
    url = 'https://unifirenze.webex.com/ec3300/eventcenter/enroll/viewrecord.do';
    params = {
        firstName: 'Anonymous',
        lastName: 'Anonymous',
        email: null,
        siteurl,
        directview: 1,
        AT: 'ViewAction',
        recordId: formId,
        accessType,
        internalPBRecordTicket,
        internalDWRecordTicket
    };
    res = await axios.post(url, qs.stringify(params), {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cookie': cookies
        }
    });

    // parse params for nbrshared.do
    let recordKey = res.data.match(/(?:&|\\x3f|\\x26)recordKey(?:=|\\x3d)(\w+)/)?.[1],
        recordID = res.data.match(/(?:&|\\x3f|\\x26)recordID(?:=|\\x3d)(\d+)/)?.[1],
        serviceRecordID = res.data.match(/(?:&|\\x3f|\\x26)serviceRecordID(?:=|\\x3d)(\d+)/)?.[1];
    // Check if params were parsed successfully
    if (recordKey === null || recordID === null || serviceRecordID === null)
        throw new Error('Some required parameters couldn\'t be parsed');
    logger.debug(`├─ recordKey: ${recordKey}`);
    logger.debug(`├─ recordID: ${recordID}`);
    logger.debug(`└─ serviceRecordID: ${serviceRecordID}`);

    // post to nbrshared.do
    logger.debug('Posting to nbrshared.do');
    url = 'https://unifirenze.webex.com/mw3300/mywebex/nbrshared.do';
    params = {
        action: 'publishfile',
        siteurl: siteurl,
        recordKey,
        recordID,
        serviceRecordID
    };
    res = await axios.post(url, qs.stringify(params), {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    });
    return res;
}

/**
 * Get the nbrshared response for the meetings
 * @param {AxiosResponse} res The response from fileUrl
 * @param {string} password The recording password
 * @param {string} fileUrl The webex recording file url from which the download procedure started
 */
async function meetingRecordingPassword(res, password, fileUrl) {
    let resultResponse;
    logger.debug('Meeting recording');

    // Check if password is required
    if (/recordingpasswordcheck\.do/.test(res.data)) {
        // Get params for recordingpasswordcheck.do
        logger.debug('Getting params for recordingpasswordcheck.do');
        const form = cheerio.load(res.data)('form');
        // format params as urlEncoded
        let params = form.serialize().replace(/password=/, `password=${password}`);
        if (res.data.includes('document.forms[0].firstEntry.value=false;')) { // Don't know the reason.
            params = params.replace('firstEntry=true', 'firstEntry=false');
        }
        // add origin to relative actionUrl
        let origin = new URL(fileUrl).origin;
        let actionUrl = new URL(form.attr('action'), origin);

        // Check recordingpasswordcheck.do
        logger.debug('Checking params with recordingpasswordcheck.do');
        resultResponse = await axios.post(actionUrl.toString(), params, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
        });
    } else {
        logger.debug('No password required');

        // Refer to README. Sometimes, when no password is required, the response is already the output of `nbrshared`.
        if (!res.data.includes('commonGet2PostForm'))
            return res;

        resultResponse = res;
    }

    // parse params for nbrshared.do in response
    let url = new URL(resultResponse.data.match(/href=['"](http.+?nbrshared\.do.+?)['"]/)[1]);

    // post to nbrshared.do
    logger.debug('Posting to nbrshared.do');
    resultResponse = await axios.post(url.origin + url.pathname, url.search.substring(1), {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    });
    return resultResponse;
}

/**
 * Given a file_url of a recording, gets the URL for downloading the recording
 * of Meetings or Events that have webex download feature enabled.
 * @param {string} fileUrl The webex recording file url from which to start the download procedure
 * @param {string} password The webex recording password
 * @throws {Error} If an error occurred.
 * @return {Promise<string>} The url from which to download the recording
 */
async function getWebexRecordingDownloadUrl(fileUrl, password) {
    let res, params;

    res = await axios.get(fileUrl);
    if (/(ico-warning|TblContentFont2)/.test(res.data))
        throw new Error('Recording deleted, not available, or not downloadable.');

    // res is the response from nbrshared
    res = (/internalRecordTicket/.test(res.data))
        ? await eventRecordingPassword(res, password)  // Event recording
        : await meetingRecordingPassword(res, password, fileUrl); // Meeting recording

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
        if (groups === null || !['OKOK', 'Preparing'].includes(groups[1]))
            throw new Error('Unknown error while waiting for recording to be ready');
        params = { status: groups[1], url: groups[2], ticket: groups[3]};
        logger.debug(`├─ status: ${params.status}`);
        logger.debug(`├─ url: ${params.url}`);
        logger.debug(`└─ ticket: ${params.ticket}`);

        // 'status' case switch
        if (params.status === 'OKOK') {
            // Write to file
            logger.debug('Recording ready');
            return downloadUrl + params.ticket;
        }

        logger.debug('Recording not ready, waiting 1s...');
        await new Promise(r => setTimeout(r, 1000));
    }
}

/**
 * Given a recording_url retrieves the stream options.
 * Stream options contains parameters required for download hls playlist and more.
 * @param {string} recording_url The recording_url of the recording object
 * @param {string} password The password of the recording
 * @throws {Error} if some requests fails
 * @returns {Promise<object>} the stream options
 */
async function getWebexRecordingStreamOptions(recording_url, password) {
    // get recordingId
    let res = await axios.get(recording_url);
    if (/(You can\\'t access this recording|Impossibile accedere a questa registrazione)/.test(res.data))
        throw new Error('Recording has been deleted or isn\'t available at the moment');

    const recordingId = res.data.match(/location.href.+?https:\/\/unifirenze\.webex.+?playback\/([a-zA-Z0-9]+)/)?.[1];
    if (recordingId === null)
        throw new Error('Couldn\'t match recordingId');

    // get stream options
    res = await axios.get(`https://unifirenze.webex.com/webappng/api/v1/recordings/${recordingId}/stream?siteurl=unifirenze`, {
        headers: {
            accessPwd: password
        }
    });
    if (!res.data?.mp4StreamOption)
        throw new Error('Invalid response. No stream options');

    return res.data;
}

/**
 * Given a recording_url of a recording, retrieves url of the hls playlist used for streaming the recording.
 * This function uses the `mp4StreamOption` property.
 * @param {string} recording_url The recording_url of the recording
 * @param {string} password The password of the recording
 * @throws {Error} if some requests fails
 * @returns {Promise<object>} { playlistUrl, filesize }
 */
async function getWebexRecordingHLSPlaylist(recording_url, password) {
    // get mp4StreamOption
    logger.debug('Getting stream options');
    const streamOptions = await getWebexRecordingStreamOptions(recording_url, password);
    if (!streamOptions?.mp4StreamOption)
        throw new Error('Invalid recording stream options');
    const mp4StreamOption = streamOptions.mp4StreamOption;

    // get playlist filename
    logger.debug('Getting playlist filename');
    const res = await axios({
        method: 'post',
        url: 'https://nfg1vss.webex.com/apis/html5-pipeline.do',
        params: {
            recordingDir: mp4StreamOption.recordingDir,
            timestamp: mp4StreamOption.timestamp,
            token: mp4StreamOption.token,
            xmlName: mp4StreamOption.xmlName
        }
    });
    const playlistFilename = res.data.match(/<Sequence.+?>(.+?)<\/Sequence>/)?.[1];
    if (playlistFilename === null)
        throw new Error('Recording file not found');
    const playlistUrl = `https://nfg1vss.webex.com/hls-vod/recordingDir/${mp4StreamOption.recordingDir}/timestamp/${mp4StreamOption.timestamp}/token/${mp4StreamOption.token}/fileName/${playlistFilename}.m3u8`;

    const filesize = (streamOptions.fileSize ?? 0) + (streamOptions.mediaDetectInfo?.audioSize ?? 0);
    logger.debug(`└─ playlistUrl: ${playlistUrl}`);
    logger.debug(`└─ filesize: ${filesize}`);
    return { playlistUrl, filesize };
}

module.exports = {
    launchWebex,
    getWebexRecordings,
    getWebexRecordingDownloadUrl,
    getWebexRecordingHLSPlaylist,
    getWebexRecordingStreamOptions
};
