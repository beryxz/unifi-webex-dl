const logger = require('./logging')('download');
const { sleep, retryPromise } = require('./utils');
const { access, existsSync, createWriteStream, createReadStream, mkdir, unlinkSync, unlink } = require('fs');
const axios = require('axios').default;
const bytes = require('bytes');
const url = require('url');
const { join } = require('path');
const util = require('util');
const exec = util.promisify(require('child_process').exec);

/**
 * Max retries for each segment
 * @type {number}
 */
const RETRY_COUNT = 10;
/**
 * Delay before retrying each failed segment
 * @type {number}
 */
const RETRY_DELAY = 200;
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
    try {
        const { data, headers } = await axios.get(url, {
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0'
            }
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
    } catch (err) {
        logger.error(`Error while downloading [${downloadName}]: ${err.message}`);

        // Delete created file
        unlinkSync(savePath);
    }
}

/**
 * Get all segments of a playlist URL
 * @param {string} playlistUrl The url from which to retrieve the m3u8 playlist file
 */
async function parsePlaylistSegments(playlistUrl) {
    const res = await axios.get(playlistUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0'
        }
    });

    return res.data.split(/[\r\n]+/).filter(row => !row.startsWith('#'));
}

/**
 *
 * @param {string} playlistUrl The HLS m3u8 playlist file url
 * @param {string} savePath Existing path to folder where to save the stream segments
 * @param {int} filesize The size of the stream (used for visual feedback only)
 * @param {boolean} [showProgressBar=true] Whether to show a progress bar of the download
 * @param {import('./MultiProgressBar.js')} [multiProgressBar=null] MultiProgress instance for creating multiple progress bars
 * @param {string} [downloadName=''] Name to show before the progress bar
 * @returns {number} Number of downloaded segments.
 */
async function downloadHLSPlaylist(playlistUrl, savePath, filesize, showProgressBar = true, multiProgressBar = null, downloadName = '') {
    let progressBar;
    let fileStream;

    // Download the hls stream
    try {
        const segments = await parsePlaylistSegments(playlistUrl);
        const totSegments = segments.length;
        let segmentsLeft = totSegments;

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
        for (const segmentUrl of segments) {
            const TMP_NUM = segmentNum;

            // download segment
            retryPromise(RETRY_COUNT, RETRY_DELAY, () => {
                return axios.get(url.resolve(playlistUrl, segmentUrl), {
                    responseType: 'stream',
                    headers: {
                        'User-Agent': 'Mozilla/5.0'
                    }
                }).then(res => {
                    fileStream = createWriteStream(join(savePath, `${TMP_NUM}.ts`));

                    // wait for segment to download
                    res.data.pipe(fileStream);
                    res.data.on('end', () => {
                        progressBar.tick();
                        segmentsLeft--;
                    });
                });
            })
                .catch(() => {
                    throw new Error(`[${downloadName}] Segment ${segmentNum} failed downloading`);
                });

            if (segmentNum % MAX_PARALLEL_SEGMENTS == 0) {
                while (segmentsLeft != totSegments - segmentNum) await sleep(100);
            }

            segmentNum++;
        }

        while (segmentsLeft > 0) {
            await sleep(1000);
        }

        return totSegments;
    } catch (err) {
        progressBar?.terminate();
        logger.error(`Error while downloading [${downloadName}]: ${err.message}`);
        await unlink(savePath, () => {});
        fileStream?.end();
        throw new Error(err);
    }
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

// TODO docs
// demux and remux a video file, using ffmpeg, to fix container format and metadata issues.
async function remuxVideoWithFFmpeg(inputFilePath, outputFilePath) {
    //TODO arguments should be further sanitized
    return exec(`ffmpeg -v warning -y -i "${inputFilePath}" -c copy "${outputFilePath}"`)
        .then(({ stdout, stderr }) => {
            //TODO if stdout is not empty, an error or warning occurred. Example of when this happens?
            if (stdout || stderr) {
                logger.debug(stdout);
                logger.debug(stderr);
                throw new Error('FFmpeg failed the remux process');
            }

            return true;
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