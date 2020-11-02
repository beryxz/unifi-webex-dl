const logger = require('./logging')('download');
const ProgressBar = require('progress');
const { access, createWriteStream, mkdir, unlinkSync } = require('fs');
const axios = require('axios').default;
const bytes = require('bytes');

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
 * @param {boolean} progressBar whether to show a progress bar of the download
 */
async function downloadStream(url, savePath, progressBar = true) {
    try {
        const { data, headers } = await axios.get(url, {
            responseType: 'stream'
        });

        if (progressBar) {
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
        logger.error(`Error while downloading file: ${err}`);

        // Delete created file
        unlinkSync(savePath);
    }
}

module.exports = {
    downloadStream,
    mkdirIfNotExists
};