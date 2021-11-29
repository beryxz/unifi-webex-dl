const logger = require('./logging')('download');
const { retryPromise, splitArrayInChunksOfFixedLength } = require('./utils');
const { existsSync, createWriteStream, createReadStream, unlinkSync } = require('fs');
const axios = require('axios').default;
const url = require('url');
const { join } = require('path');
const util = require('util');
const { EventEmitter } = require('stream');
const exec = util.promisify(require('child_process').exec);

class Download {
    get emitter() {
        return this._emitter;
    }

    constructor() {
        this._emitter = new EventEmitter();
    }
}

class StreamDownload extends Download {
    constructor() {
        super();
    }

    /**
     * Download a stream file from an url to a file
     * @param {string} url The download url
     * @param {string} savePath Where to save the downloaded file
     */
    async downloadStream(url, savePath) {
        const { data, headers } = await axios.get(url, {
            responseType: 'stream'
        });

        this.emitter.emit('init', {
            filesize: parseInt(headers['content-length']),
        });
        data.on('data', (chunk) => {
            this.emitter.emit('data', { chunk: chunk });
        });

        const writer = createWriteStream(savePath);
        data.pipe(writer);

        await (new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', (err) => {
                this.emitter.emit('error');
                reject(err);
            });
            data.on('error', (err) => {
                this.emitter.emit('error');
                reject(err);
            });
        }));
    }
}

class HLSDownload extends Download {
    /**
     * Max retries for each segment
     * @type {number}
     */
    static get SEGMENT_RETRY_COUNT() {
        return 20;
    }

    /**
     * Delay before retrying each failed segment
     * @type {number}
     */
    static get SEGMENT_RETRY_DELAY() {
        return 1000;
    }

    /**
     * Max number of segments downloaded simultaneously.
     * This highly depend on the machine and the connection.
     * A value too high can cause sudden crashes without errors.
     * @type {number}
     */
    static get MAX_PARALLEL_SEGMENTS() {
        return 8;
    }

    /**
     * @param {string} tmpFolderPath Path to a temp folder to be used internally
     */
    constructor(tmpFolderPath) {
        super();
        this.tmpFolderPath = tmpFolderPath;
    }

    /**
     * Get all segments of a playlist URL
     * @param {string} playlistUrl The url from which to retrieve the m3u8 playlist file
     * @returns {Promise<string[]>} An array of segments URLs parsed from the playlist
     */
    static async parsePlaylistSegments(playlistUrl) {
        const res = await axios.get(playlistUrl);

        return res.data.split(/[\r\n]+/).filter(row => !row.startsWith('#'));
    }

    /**
     * Demux and Remux a video file, using ffmpeg, to fix container format and metadata issues.
     * Useful for downloaded HLS stream where resulting file is a mess of concatenated segments.
     * @param {string} inputFilePath path to the file to remux
     * @param {string} outputFilePath path where to save the remuxed file
     * @returns {Promise<void>} resolved on success, rejected on failure
     */
    static async remuxVideoWithFFmpeg(inputFilePath, outputFilePath) {
        let sanitizedInput = inputFilePath.replace('"', '_');
        let sanitizedOutput = outputFilePath.replace('"', '_');

        return exec(`ffmpeg -hide_banner -v warning -y -i "${sanitizedInput}" -c copy "${sanitizedOutput}"`, {windowsHide: true})
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

    /**
     * Download an HLS playlist stream from an m3u8 url to a file
     * @param {string} playlistUrl The HLS m3u8 playlist file url
     * @param {string} resultFilePath filepath where to save the file
     * @returns {Promise<void>}
     */
    async downloadHLS(playlistUrl, resultFilePath) {
        return this._downloadHLSPlaylistSegments(playlistUrl, this.tmpFolderPath)
            .then(downloadedSegments =>
                this._mergeHLSPlaylistSegments(this.tmpFolderPath, resultFilePath, downloadedSegments));
    }

    /**
     * Download each segment of an HLS playlist stream from an m3u8 url to single files named `segNum.ts`
     * @param {string} playlistUrl The HLS m3u8 playlist file url
     * @param {string} savePath Existing path to folder where to save the stream segments
     * @returns {Promise<number>} Number of downloaded segments.
     */
    async _downloadHLSPlaylistSegments(playlistUrl, savePath) {
        // Download the hls stream
        const segments = await HLSDownload.parsePlaylistSegments(playlistUrl);
        const totSegments = segments.length;

        this.emitter.emit('init', {
            stage: 'DOWNLOAD',
            segmentsCount: totSegments,
        });

        // download each segment
        let segmentNum = 1;
        let chunks = splitArrayInChunksOfFixedLength(segments, HLSDownload.MAX_PARALLEL_SEGMENTS);

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
                            this.emitter.emit('data', { segmentDownloaded: TMP_NUM });
                            resolve();
                        });
                    };

                    retryPromise(HLSDownload.SEGMENT_RETRY_COUNT, HLSDownload.SEGMENT_RETRY_DELAY, dwnlFn)
                        .catch(err => {
                            this.emitter.emit('error');
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
     * @returns {Promise<void>}
     */
    async _mergeHLSPlaylistSegments(segmentsPath, resultFilePath, downloadedSegments) {
        const outputFile = createWriteStream(resultFilePath);

        this.emitter.emit('init', {
            stage: 'MERGE',
            segmentsCount: downloadedSegments,
        });

        for (let segmentNum = 1; segmentNum <= downloadedSegments; segmentNum++) {
            let segmentPath = join(segmentsPath, `${segmentNum}.ts`);
            if (!existsSync(segmentPath)) throw new Error(`Missing segment number ${segmentNum}`);

            const segment = createReadStream(segmentPath);

            segment.pipe(outputFile, { end: false });
            await new Promise((resolve) => {
                segment.on('end', () => {
                    this.emitter.emit('data', { segmentMerged: segmentNum });
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
}

module.exports = {
    StreamDownload,
    HLSDownload
};