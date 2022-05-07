/*
    based on:
    - https://gist.github.com/nuxlli/b425344b92ac1ff99c74
    - https://github.com/pitaj/multi-progress
*/

const ProgressBar = require('progress');

class MultiProgressBar {
    /**
     * @param {boolean} clearOnTerminate Clear all the bars when the last one terminates
     */
    constructor(clearOnTerminate = false) {
        this.stream = process.stderr;
        this.cursor = 0;
        this.bars = [];
        this.clearOnTerminate = clearOnTerminate;
        return this;
    }

    newBar(schema, options) {
        options.stream = this.stream;
        var bar = new ProgressBar(schema, options);
        this.bars.push(bar);
        var index = this.bars.length - 1;

        // allocate line
        this.move(index);
        this.stream.write('\n');
        this.cursor += 1;

        // replace original
        bar.otick = bar.tick;
        bar.oterminate = bar.terminate;
        bar.oupdate = bar.update;
        bar.index = index;
        bar.tick = (value, options) => {
            this.tick(bar.index, value, options);
        };
        bar.terminate = () => {
            if (this.clearOnTerminate) {
                if (this.bars.every(v => v.complete)) {
                    this.terminate();
                }
            }
        };
        bar.update = (value, options) => {
            this.update(bar.index, value, options);
        };

        return bar;
    }

    terminateSingleBar(index) {
        delete this.bars[index];
        this.bars.splice(index, 1);
        for (let i = 0; i < this.bars.length; i++) {
            if (i < index) continue;
            this.bars[i].index -= 1;
        }
    }

    terminate() {
        for (let i = 0; i < this.bars.length; i++) {
            this.move(i);
            this.stream.clearLine(0);
            this.stream.cursorTo(0);
        }
        this.move(0);
    }

    move(index) {
        this.stream.moveCursor(0, index - this.cursor);
        this.cursor = index;
    }

    tick(index, value, options) {
        const bar = this.bars[index];
        if (bar) {
            this.move(index);
            bar.otick(value, options);
            this.moveCursorToStart();
        }
    }

    update(index, value, options) {
        const bar = this.bars[index];
        if (bar) {
            this.move(index);
            bar.oupdate(value, options);
            this.moveCursorToStart();
        }
    }

    moveCursorToStart() {
        this.stream.cursorTo(0);
        this.move(0);
    }
}

/**
 * Returns a value to be used, it could be based on the additional data retrieved
 * @callback GetterCallback
 * @param {object} data additional data
 * @returns {any}
 */

/**
 * Progress bar for tracking status of an EventEmitter, inside a MultiProgressBar group
 */
class StatusProgressBar {
    /**
     * @param {MultiProgressBar} multiProgressBar MultiProgressBar instance where to create the new bar
     * @param {EventEmitter} emitter Event emitter that emits 'init' for bar creation, and 'data' for updating bar with bar tick.
     * @param {GetterCallback} titleGetter Function that returns the value to be used as the title for the bar creation. Uses `data` from the 'init' event.
     * @param {GetterCallback} totalGetter Function that returns the value to be used as the total for the bar creation. Uses `data` from the 'init' event.
     * @param {GetterCallback} tickAmountGetter Function that returns the value to be used as the tick amount for the bar update. Uses `data` from the 'data' event.
     */
    constructor(multiProgressBar, emitter, titleGetter, totalGetter, tickAmountGetter) {
        this.bar = null;
        this._multiProgressBar = multiProgressBar;
        this._emitter = emitter;
        this._titleGetter = titleGetter;
        this._totalGetter = totalGetter;
        this._tickAmountGetter = tickAmountGetter;

        emitter.on('init', (data) => {
            this.bar = multiProgressBar.newBar(`${this._titleGetter(data)} > [:bar] :percent :etas`, {
                width: 20,
                complete: '=',
                incomplete: ' ',
                renderThrottle: 100,
                clear: true, // bar.terminate has been hooked, this should always stay true
                total: this._totalGetter(data)
            });
            this.bar.tick(0); // show the progress bar instantly
        });

        emitter.on('data', (data) => {
            this.bar.tick(this._tickAmountGetter(data));
        });

        emitter.on('error', () => {
            this._multiProgressBar.terminateSingleBar(this.bar.index);
        });
    }
}

class OneShotProgressBar {
    constructor(multiProgressBar, title) {
        /** @type {ProgressBar} */
        this.bar = null;
        this._multiProgressBar = multiProgressBar;
        this._title = title;
    }

    init() {
        if (this.bar) return;

        this.bar = this._multiProgressBar.newBar(`${this._title} > [:bar] :percent :etas`, {
            width: 20,
            complete: '=',
            incomplete: ' ',
            renderThrottle: 100,
            clear: true, // bar.terminate has been hooked, this should always stay true
            total: 100
        });
        this.bar.tick(0); // show the progress bar instantly
    }

    complete() {
        if (!this.bar) return;

        this.bar.update(1);
    }
}

module.exports = {
    MultiProgressBar,
    StatusProgressBar,
    OneShotProgressBar
};
