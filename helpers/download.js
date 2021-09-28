const logger = require('./logging')('download');
const { access, createWriteStream, mkdir, unlinkSync, unlink } = require('fs');
const axios = require('axios').default;
const bytes = require('bytes');
const url = require('url');

/**
 * @type {number}
 */
const RETRY_COUNT = 5;

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
 */
async function downloadStream(url, savePath, showProgressBar = true, multiProgressBar = null) {
    try {
        const { data, headers } = await axios.get(url, {
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0'
            }
        });

        if (multiProgressBar && showProgressBar) {
            const filesize = headers['content-length'];
            const progressBar = multiProgressBar.newBar(`${bytes(parseInt(filesize), BYTES_OPTIONS).padStart(9)} > [:bar] :percent :etas`, {
                width: 30,
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
        logger.error(`Error while downloading file: ${err.message}`);

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
 * @param {string} savePath Existing path to which to save the stream
 * @param {int} filesize The size of the stream (used for visual feedback only)
 * @param {boolean} progressBar Whether to show a progress bar of the download
 * @param {import('./MultiProgressBar.js')} [multiProgressBar=null] MultiProgress instance for creating multiple progress bars
 */
async function downloadHLSPlaylist(playlistUrl, savePath, filesize, showProgressBar = true, multiProgressBar = null) {
    let progressBar, fileStream;

    if (multiProgressBar && showProgressBar) {
        progressBar = multiProgressBar.newBar(`${bytes(parseInt(filesize), BYTES_OPTIONS).padStart(9)} > [:bar] :percent :etas`, {
            width: 30,
            complete: '=',
            incomplete: ' ',
            renderThrottle: 100,
            clear: true,
            total: 100
        });
    }

    // Download the hls stream
    try {
        const segments = await parsePlaylistSegments(playlistUrl);
        const totSegments = segments.length;

        // stream where to save recording
        fileStream = createWriteStream(savePath);

        // progress is called after the segment finished downloading
        fileStream.on('progress', ({segment, totSegments}) => {
            progressBar?.update(segment/totSegments);
        });

        // download each segment
        let segmentNum = 1;
        for (const segmentUrl of segments) {
            let success = false;
            let retryCount = 0;
            do {
                try {
                    // download segment
                    const { data } = await axios.get(url.resolve(playlistUrl, segmentUrl), {
                        responseType: 'stream',
                        headers: {
                            'User-Agent': 'Mozilla/5.0'
                        }
                    });

                    // wait for segment to download
                    data.pipe(fileStream, { end: false });
                    await new Promise((resolve) => {
                        data.on('end', () => {
                            resolve();
                        });
                    });

                    // emit status update
                    fileStream.emit('progress', {
                        segment: segmentNum + 1,
                        totSegments: totSegments
                    });

                    segmentNum++;
                    success = true;
                } catch (error) {
                    // tries up to 'RETRY_COUNT' times
                    if (retryCount < RETRY_COUNT) {
                        retryCount++;
                        logger.debug('Segment failed, retrying...');
                        await new Promise(r => setTimeout(r, 1000));
                    } else {
                        throw new Error('Segment failed downloading');
                    }
                }
            } while (!success);
        }

        // close stream
        fileStream.end();
    } catch (err) {
        progressBar?.terminate();
        logger.error(`Error while downloading file: ${err.message}`);
        await unlink(savePath, () => {});
        fileStream?.end();
        throw new Error(err);
    }
}

module.exports = {
    downloadStream,
    mkdirIfNotExists,
    downloadHLSPlaylist
};