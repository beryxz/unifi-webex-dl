const logger = require('./logging')('download');
const ProgressBar = require('progress');
const { access, createWriteStream, mkdir, unlinkSync, unlink } = require('fs');
const axios = require('axios').default;
const bytes = require('bytes');
const m3u8stream = require('m3u8stream');

const RETRY_COUNT = 5;


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
            }

            // dir exists
            resolve();
        });
    });
}

/**
 * Download a stream file from an url to a file
 * @param {string} url The download url
 * @param {string} savePath Where to save the downloaded file
 * @param {boolean} showProgressBar Whether to show a progress bar of the download
 */
async function downloadStream(url, savePath, showProgressBar = true) {
    try {
        const { data, headers } = await axios.get(url, {
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0'
            }
        });

        if (showProgressBar) {
            const filesize = headers['content-length'];
            const progressBar = new ProgressBar(`${bytes(parseInt(filesize))} > [:bar] :percent :etas`, {
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
        logger.error(`Error while downloading file: ${err.message}`);

        // Delete created file
        unlinkSync(savePath);
    }
}

/**
 *
 * @param {string} playlistUrl The HLS m3u8 playlist file url
 * @param {string} savePath Existing path to which to save the stream
 * @param {int} filesize The size of the stream (used for visual feedback only)
 * @param {boolean} progressBar Whether to show a progress bar of the download
 */
async function downloadHLSPlaylist(playlistUrl, savePath, filesize, showProgressBar = true) {
    let progressBar;
    if (showProgressBar) {
        progressBar = new ProgressBar(`${bytes(parseInt(filesize))} > [:bar] :percent :etas`, {
            width: 40,
            complete: '=',
            incomplete: ' ',
            renderThrottle: 100,
            clear: true,
            total: 100
        });
    }

    // Download the hls stream using external library.
    try {
        // In case of failure retry up to 3 times
        let success = false, retry = 0;
        do {
            logger.debug('Initializing downloader');
            let stream = m3u8stream(playlistUrl, {
                requestOptions: {
                    maxRetries: RETRY_COUNT
                }
            });

            // stream where to save recording
            stream.pipe(createWriteStream(savePath));

            // progress is called after the segment finished downloading
            stream.on('progress', (segment, totSegments, bytesDownloaded) => {
                progressBar.update(segment.num/totSegments);
                if (segment.num === totSegments) stream.emit('done');
            });
            stream.on('retry', (retryCount) => {
                logger.debug(`Try num: ${retryCount}`);
            });

            // Await the end of the download
            await (new Promise((resolve, reject) => {
                stream.on('done', () => {
                    success = true;
                    resolve();
                });
                stream.on('error', async (err) => {
                    progressBar.terminate();
                    logger.warning(`Retrying because of: ${err.message}.`);
                    if (retry < RETRY_COUNT) {
                        retry++;
                        await new Promise(r => setTimeout(r, 3000));
                        resolve();
                    }
                    else reject(err);
                });
            }));
        } while (!success);
    } catch (err) {
        progressBar.terminate();
        logger.error(`Error while downloading file: ${err.message}`);
        await unlink(savePath, () => {});
        throw new Error(err);
    }
}

module.exports = {
    downloadStream,
    mkdirIfNotExists,
    downloadHLSPlaylist
};