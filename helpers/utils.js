/**
 * Split the source array in chunks of fixed length.
 * The last chunk is filled with the remaining objects that might not be less than fixed chunk length
 *
 * source: https://codereview.stackexchange.com/questions/245346/javascript-split-array-into-n-subarrays-size-of-chunks-dont-matter
 * @param {any[]} sourceArray
 * @param {number} chunkLength max number of items in each chunk, If less than 1, a single chunk with all the items is going to be returned.
 * @returns {any[][]} array of chunks
 */
function splitArrayInChunksOfFixedLength(sourceArray, chunkLength) {
    if (chunkLength < 1) return [sourceArray];

    const srcLen = sourceArray.length;
    const numOfChunks = Math.ceil(srcLen / chunkLength);

    const chunks = Array.from(Array(numOfChunks), () => []);
    for (let i = 0; i < srcLen ; i++) {
        chunks[Math.floor(i / chunkLength)].push(sourceArray[i]);
    }
    return chunks;
}

/**
 * Check whether the given object is undefined, null, empty string or empty object
 * @param {any} object to entity to check
 */
function isNone(object) {
    return typeof object === 'undefined' || object === null || object === '' || object === {};
}

/**
 * Check if the filename contains any characters what Windows consider reserved,
 * and can't therefore be used in files and folders names.
 * @param {string} filename
 * @returns {boolean} true if it the filename doesn't contain any reserved char. false otherwise
 */
function isFilenameValidOnWindows(filename) {
    // eslint-disable-next-line no-control-regex
    return !( /[<>:"/\\|?*\x00-\x1F\r\n]/.test(filename) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(filename) );
}

module.exports = {
    splitArrayInChunksOfFixedLength,
    isNone,
    isFilenameValidOnWindows
};
