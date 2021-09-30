/*
    based on:
    - https://gist.github.com/nuxlli/b425344b92ac1ff99c74
    - https://github.com/pitaj/multi-progress
*/

const ProgressBar = require('progress');

class MultiProgressBar {
    constructor() {
        this.stream = process.stderr;
        this.cursor = 0;
        this.bars = [];
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
        bar.tick = (value, options) => {
            this.tick(index, value, options);
        };
        bar.terminate = () => {
            if (this.bars.every(v => v.complete)) {
                this.terminate();
            }
        };
        bar.update = (value, options) => {
            this.update(index, value, options);
        };

        return bar;
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
            // this.moveCursorToEnd();
        }
    }

    update(index, value, options) {
        const bar = this.bars[index];
        if (bar) {
            this.move(index);
            bar.oupdate(value, options);
            // this.moveCursorToEnd();
        }
    }

    //TODO: if improved, it could be used to reduce cursor flicker without using ascii chars that hide the cursor.
    // moveCursorToEnd() {
    //     this.stream.cursorTo(0);
    //     this.move(this.bars.length);
    // }
}

module.exports = MultiProgressBar;
