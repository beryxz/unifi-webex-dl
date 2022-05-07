const logger = require('./logging')('download');
const { retryPromise, splitArrayInChunksOfFixedLength } = require('./utils');
const { existsSync, createWriteStream, createReadStream, unlinkSync } = require('fs');
const axios = require('axios').default;
const url = require('url');
const { join } = require('path');

const HLS_CONFIG = {
    /**
     * Max retries for each segment
     * @type {number}
     */
    SEGMENT_RETRY_COUNT: 20,

    /**
     * Delay before retrying each failed segment
     * @type {number}
     */
    SEGMENT_RETRY_DELAY: 1000,

    /**
     * Max number of segments downloaded simultaneously.
     * This highly depend on the machine and the connection.
     * A value too high can cause sudden crashes without errors.
     * @type {number}
     */
    MAX_PARALLEL_SEGMENTS: 8
};

/**
 * Download a stream file from an url to a file.
 *
 * Emit download events through the statusEmitter instance:
 * - 'init' event on creation
 * - 'data' event on each chunk
 * - 'error' event on error
 * - 'finish' event on end of download
 *
 * Use the 'finish' event to check when the download has finished
 *
 * @param {string} url The file url to download as a stream.
 * @param {string} savePath Path in which to save the downloaded file.
 * @param {EventEmitter} statusEmitter EventEmitter instance where to emit status updates on the download
 */
async function downloadStream(url, savePath, statusEmitter) {
    const { data, headers } = await axios.get(url, {
        responseType: 'stream'
    });

    // init
    statusEmitter.emit('init', {
        filesize: parseInt(headers['content-length']),
    });

    // data
    data.on('data', (chunk) => {
        statusEmitter.emit('data', { chunkLength: chunk.length });
    });
    const writer = createWriteStream(savePath);
    data.pipe(writer);

    // error
    writer.on('error', (err) => {
        statusEmitter.emit('error', err);
    });
    data.on('error', (err) => {
        statusEmitter.emit('error', err);
    });

    // finish
    writer.on('finish', () => {
        statusEmitter.emit('finish');
    });
}

/**
 * Get all segments of a playlist URL.
 * It supports two types of playlists, the ones where there's a list of segments and the ones where there's only one file with many BYTERANGE specified.
 * @param {string} playlistUrl The url from which to retrieve the m3u8 playlist file
 * @returns {Promise<string[]>} An array of segments URLs parsed from the playlist
 */
async function parseHLSPlaylistSegments(playlistUrl) {
    const res = await axios.get(playlistUrl);

    // playlist has only one file with multiple BYTERANGE specified
    if (/#EXT-X-MAP:URI/.test(res.data))
        return [ res.data.match(/#EXT-X-MAP:URI="([^"]+)"/)?.[1] ];

    // playlist has multiple segments
    return res.data.split(/[\r\n]+/).filter(row => !row.startsWith('#'));
}

/**
 * Download an HLS playlist stream from an m3u8 url to a file
 *
 * Emit download events through the statusEmitter instance:
 * - 'init' event on download start, or merge start.
 * - 'data' event on segment downloaded, or segment merged
 * - 'error' event on error
 * - 'finish' event emitted when recording finished downloading and has been merged successfully.
 *
 * `init` is called multiple times with the `stage` of the download, either "DOWNLOAD" or "MERGE".
 *
 * Use the 'finish' event to check when the download has finished.
 *
 * @param {string} playlistUrl The HLS m3u8 playlist file url.
 * @param {string} savePath Path in which to save the downloaded file.
 * @param {string} tmpFolderPath Path to a temp folder to be used internally to save intermediary segments.
 * @param {EventEmitter} statusEmitter EventEmitter instance where to emit status updates on the download
 */
function downloadHLS(playlistUrl, savePath, tmpFolderPath, statusEmitter) {
    _downloadHLSPlaylistSegments(playlistUrl, tmpFolderPath, statusEmitter)
        .then(downloadedSegmentsCount =>
            _mergeHLSPlaylistSegments(tmpFolderPath, savePath, downloadedSegmentsCount, statusEmitter))
        .then(() =>
            statusEmitter.emit('finish'))
        .catch(err =>
            statusEmitter.emit('error', err));
}

/**
 * Download each segment of an HLS playlist stream from an m3u8 url to single files named `segNum.ts`
 * @param {string} playlistUrl The HLS m3u8 playlist file url
 * @param {string} savePath Existing path to folder where to save the stream segments
 * @param {EventEmitter} statusEmitter EventEmitter instance where to emit status updates on the download
 * @returns {Promise<number>} Number of downloaded segments.
 */
async function _downloadHLSPlaylistSegments(playlistUrl, savePath, statusEmitter) {
    //TODO: When there is only one large segment, the progress status is useless as it only updates on completion. This occurs for example when there is the hlsURL. If there is only one segment, then this should be downloaded with downloadStream and not with downloadHLS

    // Download the hls stream
    const segments = await parseHLSPlaylistSegments(playlistUrl);
    if (!Array.isArray(segments) || segments.length === 0)
        throw new Error('Playlist is empty');
    const totSegments = segments.length;

    statusEmitter.emit('init', {
        stage: 'DOWNLOAD',
        segmentsCount: totSegments,
    });

    // download each segment
    let segmentNum = 1;
    let chunks = splitArrayInChunksOfFixedLength(segments, HLS_CONFIG.MAX_PARALLEL_SEGMENTS);

    for (const chunk of chunks) {
        let segments = chunk.map(segmentUrl => {
            const TMP_NUM = segmentNum++;

            // download segment
            return new Promise((resolve, reject) => {
                let dwnlFn = async () => {
                    const res = await axios.get(url.resolve(playlistUrl, segmentUrl), {
                        responseType: 'stream'
                    });

                    let fileStream = createWriteStream(join(savePath, `${TMP_NUM}.ts`));

                    // wait for segment to download
                    res.data.pipe(fileStream);
                    res.data.on('end', () => {
                        statusEmitter.emit('data', { segmentDownloaded: TMP_NUM });
                        resolve();
                    });
                };

                retryPromise(HLS_CONFIG.SEGMENT_RETRY_COUNT, HLS_CONFIG.SEGMENT_RETRY_DELAY, dwnlFn)
                    .catch(err => {
                        reject(new Error(`Segment ${segmentNum}: ${err.message}`));
                    });
            });
        });

        await Promise.all(segments).catch(err => {throw err;});
    }

    return totSegments;
}

/**
 * Merge the segments downloaded with downloadHLSPlaylist()
 * @param {string} segmentsPath Path to the folder containing the downloaded hls segments
 * @param {string} resultFilePath Path where to save the merged file
 * @param {number} downloadedSegments Number of segments to merge
 * @param {EventEmitter} statusEmitter EventEmitter instance where to emit status updates on the download
 * @returns {Promise<void>}
 */
async function _mergeHLSPlaylistSegments(segmentsPath, resultFilePath, downloadedSegments, statusEmitter) {
    const outputFile = createWriteStream(resultFilePath);

    statusEmitter.emit('init', {
        stage: 'MERGE',
        segmentsCount: downloadedSegments,
    });

    for (let segmentNum = 1; segmentNum <= downloadedSegments; segmentNum++) {
        let segmentPath = join(segmentsPath, `${segmentNum}.ts`);
        if (!existsSync(segmentPath)) throw new Error(`Missing segment number ${segmentNum}`);

        const segment = createReadStream(segmentPath);

        segment.pipe(outputFile, { end: false });
        await new Promise((resolve, reject) => {
            segment.on('end', () => {
                statusEmitter.emit('data', { segmentMerged: segmentNum });
                resolve();
            });
            segment.on('error', (err) => {
                reject(err);
            });
        });

        try {
            unlinkSync(segmentPath);
        } catch (err) {
            logger.debug(`Error deleting tmp segment: ${err.message}`);
        }
    }
}

module.exports = {
    downloadStream,
    downloadHLS
};