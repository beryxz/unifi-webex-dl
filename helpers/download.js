const logger = require('./logging')('download');
const { retryPromise } = require('./utils');
const { access, existsSync, createWriteStream, createReadStream, mkdir, unlinkSync } = require('fs');
const axios = require('axios').default;
const bytes = require('bytes');
const url = require('url');
const { join } = require('path');
const util = require('util');
const exec = util.promisify(require('child_process').exec);

//TODO generalize axios instance to include custom User-Agent header by default

/**
 * Max retries for each segment
 * @type {number}
 */
const RETRY_COUNT = 20;
/**
 * Delay before retrying each failed segment
 * @type {number}
 */
const RETRY_DELAY = 1000;
/**
 * Max number of segments downloaded simultaneously.
 * This highly depend on the machine and the connection.
 * A value too high can cause sudden crashes without errors.
 * @type {number}
 */
const MAX_PARALLEL_SEGMENTS = 8;

/**
 * @type {bytes.BytesOptions}
 */
const BYTES_OPTIONS = {
    decimalPlaces: 2,
    fixedDecimals: true,
    thousandsSeparator: '',
    unit: 'MB',
    unitSeparator: '',
};

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
            } else {
                // dir exists
                resolve();
            }
        });
    });
}

/**
 * Download a stream file from an url to a file
 * @param {string} url The download url
 * @param {string} savePath Where to save the downloaded file
 * @param {boolean} [showProgressBar=true] Whether to show a progress bar of the download
 * @param {import('./MultiProgressBar.js')} [multiProgressBar=null] MultiProgress instance for creating multiple progress bars
 * @param {string} downloadName Name to show before the progress bar
 */
async function downloadStream(url, savePath, showProgressBar = true, multiProgressBar = null, downloadName = '') {
    const { data, headers } = await axios.get(url, {
        responseType: 'stream'
    });

    if (multiProgressBar && showProgressBar) {
        const filesize = headers['content-length'];
        const filesizePretty = bytes(parseInt(filesize), BYTES_OPTIONS).padStart(9);
        const progressBar = multiProgressBar.newBar(`[${downloadName}] ${filesizePretty} > [:bar] :percent :etas`, {
            width: 20,
            complete: '=',
            incomplete: ' ',
            renderThrottle: 100,
            clear: true,
            total: parseInt(filesize)
        });
        data.on('data', (chunk) => progressBar.tick(chunk.length));
    }

    const writer = createWriteStream(savePath);
    data.pipe(writer);

    await (new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    }));
}

/**
 * Get all segments of a playlist URL
 * @param {string} playlistUrl The url from which to retrieve the m3u8 playlist file
 * @returns {Promise<string[]>} An array of segments URLs parsed from the playlist
 */
async function parsePlaylistSegments(playlistUrl) {
    const res = await axios.get(playlistUrl);

    return res.data.split(/[\r\n]+/).filter(row => !row.startsWith('#'));
}

/**
 * Download an HLS playlist stream from an m3u8 url to a file
 * @param {string} playlistUrl The HLS m3u8 playlist file url
 * @param {string} savePath Existing path to folder where to save the stream segments
 * @param {int} filesize The size of the stream (used for visual feedback only)
 * @param {boolean} [showProgressBar=true] Whether to show a progress bar of the download
 * @param {import('./MultiProgressBar.js')} [multiProgressBar=null] MultiProgress instance for creating multiple progress bars
 * @param {string} [downloadName=''] Name to show before the progress bar
 * @returns {Promise<number>} Number of downloaded segments.
 */
async function downloadHLSPlaylist(playlistUrl, savePath, filesize, showProgressBar = true, multiProgressBar = null, downloadName = '') {
    let progressBar;
    let fileStream;

    // Download the hls stream
    const segments = await parsePlaylistSegments(playlistUrl);
    const totSegments = segments.length;

    if (multiProgressBar && showProgressBar) {
        const filesizePretty = bytes(parseInt(filesize), BYTES_OPTIONS).padStart(9);
        progressBar = multiProgressBar.newBar(`[${downloadName}] ${filesizePretty} > [:bar] :percent :etas`, {
            width: 20,
            complete: '=',
            incomplete: ' ',
            renderThrottle: 100,
            clear: true,
            total: totSegments
        });
    }

    // download each segment
    let segmentNum = 1;
    for (let i = 0, j = segments.length; i < j; i += MAX_PARALLEL_SEGMENTS) {
        let chunk = segments.slice(i, i + MAX_PARALLEL_SEGMENTS);

        let chunks = chunk.map(segmentUrl => {
            const TMP_NUM = segmentNum++;

            // download segment
            return new Promise((resolve, reject) => {
                let dwnlFn = async () => {
                    const res = await axios.get(url.resolve(playlistUrl, segmentUrl), {
                        responseType: 'stream'
                    });

                    fileStream = createWriteStream(join(savePath, `${TMP_NUM}.ts`));

                    // wait for segment to download
                    res.data.pipe(fileStream);
                    res.data.on('end', () => {
                        progressBar.tick();
                        resolve();
                    });
                };

                retryPromise(RETRY_COUNT, RETRY_DELAY, dwnlFn)
                    .catch(err => {
                        reject(new Error(`Segment ${segmentNum} failed downloading because of: ${err.message}`));
                    });
            });
        });

        await Promise.all(chunks).catch(err =>  {throw err;});
    }

    return totSegments;
}

/**
 * Merge the segments downloaded with downloadHLSPlaylist()
 * @param {string} segmentsPath Path to the folder containing the downloaded hls segments
 * @param {string} resultFilePath Path where to save the merged file
 * @param {number} [downloadedSegments=null] Number of segments to merge. If not set, are merged all incremental segments starting from 1 and until one is missing.
 * @param {boolean} [showProgressBar=true] Whether to show a progress bar of the download
 * @param {import('./MultiProgressBar.js')} [multiProgressBar=null] MultiProgress instance for creating multiple progress bars
 * @param {string} [downloadName=''] Name to show before the progress bar
 */
async function mergeHLSPlaylistSegments(segmentsPath, resultFilePath, downloadedSegments = null, showProgressBar = true, multiProgressBar = null, downloadName = '') {
    const outputFile = createWriteStream(resultFilePath);
    let progressBar;

    if (multiProgressBar && showProgressBar && downloadedSegments) {
        progressBar = multiProgressBar.newBar(`[${downloadName}] MERGE > [:bar] :percent :etas`, {
            width: 20,
            complete: '=',
            incomplete: ' ',
            renderThrottle: 100,
            clear: true,
            total: downloadedSegments
        });
    }

    for (let segmentNum = 1; (downloadedSegments ? (segmentNum <= downloadedSegments) : true); segmentNum++) {
        let segmentPath = join(segmentsPath, `${segmentNum}.ts`);
        if (!existsSync(segmentPath)) break;

        const segment = createReadStream(segmentPath);

        segment.pipe(outputFile, { end: false });
        await new Promise((resolve) => {
            segment.on('end', () => {
                progressBar.tick();
                resolve();
            });
        });

        try {
            unlinkSync(segmentPath);
        } catch (err) {
            logger.debug(`Error deleting tmp segment: ${err.message}`);
        }
    }
}

/**
 * Demux and Remux a video file, using ffmpeg, to fix container format and metadata issues.
 * Useful for downloaded HLS stream where resulting file is a mess of concatenated segments.
 * @param {string} inputFilePath path to the file to remux
 * @param {string} outputFilePath path where to save the remuxed file
 * @returns {Promise<void>} resolved on success, rejected on failure
 */
async function remuxVideoWithFFmpeg(inputFilePath, outputFilePath) {
    let sanitizedInput = inputFilePath.replace('"', '_');
    let sanitizedOutput = outputFilePath.replace('"', '_');

    return exec(`ffmpeg -v warning -y -i "${sanitizedInput}" -c copy "${sanitizedOutput}"`)
        .then(({ stdout, stderr }) => {
            // if stdout is not empty, an error or warning occurred.
            if (stdout || stderr) {
                logger.debug(stdout);
                logger.debug(stderr);
                throw new Error('FFmpeg failed the remux process');
            }
        })
        .catch(err => {
            throw err;
        });
}

module.exports = {
    downloadStream,
    mkdirIfNotExists,
    downloadHLSPlaylist,
    mergeHLSPlaylistSegments,
    remuxVideoWithFFmpeg
};