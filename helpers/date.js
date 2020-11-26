/**
 * Converts the given date to UTC format: YYYYMMDD
 * @param {string} date The date string
 * @param {string} separator The separator to place in between year,month,day
 * @returns {string}
 */
function getUTCDateTimestamp(date, separator = '') {
    const d = new Date(date);
    return [
        pad0(d.getUTCFullYear(), 4),
        pad0(d.getUTCMonth()+1, 2),
        pad0(d.getUTCDate(), 2)
    ].join(separator);
}

/**
 * Prepend the given text with 0s up to length
 * @param {string} text the text to pad with 0
 * @param {number} length the length of the resulting string
 * @returns {string}
 */
function pad0(text, length = 0) {
    const pad = (text.length - length) > 0 ? '0'.repeat(text, text.length - length) : '';
    return pad + text;
}

module.exports = {
    getUTCDateTimestamp
};