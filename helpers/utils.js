const { access, mkdir, writeFileSync, unlinkSync, readFileSync, renameSync } = require('fs');

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
    if (!sourceArray) throw new Error('Undefined source array to be split');
    if (!chunkLength) throw new Error('Undefined chunk length');
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

/**
 * Return the input text string with all special windows char replaced by another value
 * @param {string} text The text from which to replace the windows special chars
 * @param {string} replaceValue A string containing the text to replace the matches with
 */
function replaceWindowsSpecialChars(text, replaceValue) {
    // eslint-disable-next-line no-control-regex
    return text.replaceAll(/[<>:"/\\|?*\x00-\x1F\r\n]/g, replaceValue);
}

/**
 * Return the input text string with all whitespace characters replaced by another value
 * @param {string} text The text from which to replace the whitespace characters
 * @param {string} replaceValue A string containing the text to replace the matches with
 */
function replaceWhitespaceChars(text, replaceValue) {
    return text.replaceAll(/\s/g, replaceValue);
}

/**
 * Retries a promise until it's resolved or it fails too many times
 * @param {number} maxRetries the max number of retries before throwing an error if the functions keep failing
 * @param {number} timeoutOnError Time to wait before trying again to call fn
 * @param {*} fn the function that is called each try
 * @returns {Promise<void>}
 */
function retryPromise(maxRetries, timeoutOnError, fn) {
    return fn().catch(async function (err) {
        if (maxRetries <= 0) {
            throw err;
        }
        await sleep(timeoutOnError);
        return retryPromise(maxRetries - 1, timeoutOnError, fn);
    });
}

/**
 * Return a promise that resolves after 'timeout' ms
 * @param {number} timeout Sleep timeout in ms
 * @returns Promise that is resolved after 'timeout' ms
 */
function sleep(timeout) {
    return new Promise(resolve => {
        setTimeout(() => {
            resolve();
        }, timeout);
    });
}

/**
 * Asynchronously make the dir path if it doesn't exists
 * @param {string} dirPath The path to the dir
 * @returns {Promise}
 */
function mkdirIfNotExists(dirPath) {
    return new Promise((resolve, reject) => {
        // try to access
        access(dirPath, (err) => {
            if (err && err.code === 'ENOENT') {
                // dir doesn't exist, creating it
                mkdir(dirPath, { recursive: true }, (err) => {
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
 * Move a file.
 * First, it tries to rename the file. If it doesn't work, it then tries to copy it to the new destination, deleting the old one.
 * @param {string} srcPath source path
 * @param {string} dstPath destination path
 * @throws Throws an error if it fails all move strategies
 */
function moveFile(srcPath, dstPath) {
    try {
        renameSync(srcPath, dstPath);
    } catch (err) {
        if (err.code === 'EXDEV') {
            // Cannot move files that are not in the top OverlayFS layer (e.g.: inside volumes)
            // Probably inside a Docker container, falling back to copy-and-unlink
            const fileContents = readFileSync(srcPath);
            writeFileSync(dstPath, fileContents);
            unlinkSync(srcPath);
        } else {
            throw err;
        }
    }
}

module.exports = {
    splitArrayInChunksOfFixedLength,
    isNone,
    isFilenameValidOnWindows,
    sleep,
    retryPromise,
    replaceWindowsSpecialChars,
    replaceWhitespaceChars,
    mkdirIfNotExists,
    moveFile
};
