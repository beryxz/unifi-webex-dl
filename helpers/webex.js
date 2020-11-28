const axios = require('axios').default;
const logger = require('./logging')('webex');
const cheerio = require('cheerio');
const qs = require('qs');
const { getCookies } = require('./cookie');

/**
 * Launch the webex platform and retrieve the JWT and Cookies
 * @param {string} launchParameters urlencoded string to send as post body to access webex
 * @returns {Object} { jwt, cookies }
 */
async function launchWebex(launchParameters) {
    try {
        logger.debug('Launching Webex');
        const res = await axios.post('https://lti.educonnector.io/launches', launchParameters, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0'
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
            'Cookie': webexObject.cookies,
            'User-Agent': 'Mozilla/5.0'
        }
    });

    return res.data;
}

/**
 * Get the nbrshared response for the events
 * @param {AxiosResponse} res The response from fileUrl
 * @param {string} password The recording password
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
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0'
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
            'Cookie': cookies,
            'User-Agent': 'Mozilla/5.0'
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
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0'
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
        res = await axios.post(actionUrl.toString(), params, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0'
            },
        });

        // parse params for nbrshared.do in response
        let url = new URL(res.data.match(/href=['"](http.+?nbrshared\.do.+?)['"]/)[1]);

        // post to nbrshared.do
        logger.debug('Posting to nbrshared.do');
        res = await axios.post(url.origin + url.pathname, url.search.substring(1), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0'
            }
        });
        return res;
    }

    // res is alredy the response from nbrShared
    logger.debug('No password required');
    return res;
}

/**
 * Given a file_url of a recording, gets the URL for downloading the recording
 * of Meetings or Events that have webex download feature enabled.
 * @param {string} fileUrl The webex recording file url from which to start the download procedure
 * @param {string} password The webex recording password
 * @throws {Error} If an error occurred.
 * @return {string} The url from which to download the recording
 */
async function getWebexRecordingDownloadUrl(fileUrl, password) {
    let res, params;

    res = await axios.get(fileUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
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
            headers: {
                'User-Agent': 'Mozilla/5.0'
            },
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
            logger.debug('Recording ready');
            return downloadUrl + params.ticket;
        }

        logger.debug('Recording not ready, waiting 3s...');
        await new Promise(r => setTimeout(r, 3000));
    }
}

/**
 * Given a recording_url retrieves the stream options.
 * Stream options contains parameters required for download hls playlist and more.
 * @param {string} recording_url The recording_url of the recording object
 * @param {string} password The password of the recording
 * @throws {Error} if some requests fails
 * @returns {object} the stream options
 */
async function recordingStreamOptions(recording_url, password) {
    // get recordingId
    let res = await axios.get(recording_url);
    if (/(You can\\'t access this recording|Impossibile accedere a questa registrazione)/.test(res.data))
        throw new Error('Recording has been deleted or isn\'t available at the moment');

    let recordingId = res.data.match(/location.href.+?https:\/\/unifirenze\.webex.+?playback\/([a-zA-Z0-9]+)/)?.[1];
    if (recordingId === null)
        throw new Error('Couldn\'t match recordingId');

    // get stream options
    res = await axios.get(`https://unifirenze.webex.com/webappng/api/v1/recordings/${recordingId}/stream?siteurl=unifirenze`, {
        headers: {
            accessPwd: password,
            'User-Agent': 'Mozilla/5.0'
        }
    });
    if (!res.data?.mp4StreamOption)
        throw new Error('Invalid response. No stream options');

    return res.data;
}

/**
 * Given a recording_url of a recording, retrieves url of the hls playlist used for streaming the recording.
 * @param {string} recording_url The recording_url of the recording
 * @param {string} password The password of the recording
 * @throws {Error} if some requests fails
 * @returns {object} { playlistUrl, filesize }
 */
async function getWebexRecordingHSLPlaylist(recording_url, password) {
    //TODO: implement the process for recordings of Events with disabled download

    // get mp4StreamOption
    logger.debug('Getting stream options');
    const streamOptions = await recordingStreamOptions(recording_url, password);
    if (!streamOptions?.mp4StreamOption)
        throw new Error('Invalid recording stream options');
    let mp4StreamOption = streamOptions.mp4StreamOption;

    // get playlist filename
    logger.debug('Getting playlist filename');
    let res = await axios({
        method: 'post',
        url: 'https://nln1vss.webex.com/apis/html5-pipeline.do',
        headers: {
            'User-Agent': 'Mozilla/5.0'
        },
        params: {
            recordingDir: mp4StreamOption.recordingDir,
            timestamp: mp4StreamOption.timestamp,
            token: mp4StreamOption.token,
            xmlName: mp4StreamOption.xmlName
        }
    });
    let playlistFilename = res.data.match(/<Sequence.+?>(.+?)<\/Sequence>/)?.[1];
    if (playlistFilename === null)
        throw new Error('Recording file not found');

    let playlistUrl = `https://nln1vss.webex.com/hls-vod/recordingDir/${mp4StreamOption.recordingDir}/timestamp/${mp4StreamOption.timestamp}/token/${mp4StreamOption.token}/fileName/${playlistFilename}.m3u8`;
    let filesize = (streamOptions.fileSize ?? 0) + (streamOptions.mediaDetectInfo?.audioSize ?? 0);
    logger.debug(`└─ playlistUrl: ${playlistUrl}`);
    logger.debug(`└─ filesize: ${filesize}`);
    return { playlistUrl, filesize };
}

module.exports = {
    launchWebex,
    getWebexRecordings,
    getWebexRecordingDownloadUrl,
    getWebexRecordingHSLPlaylist,
    recordingStreamOptions
};
