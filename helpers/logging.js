const { createLogger, format, transports } = require('winston');
const { combine, cli, errors, label, timestamp, printf } = format;

function create(logLabel) {
    return createLogger({
        level: process.env['LOG_LEVEL'] || 'info',
        format: combine(
            cli(),
            errors(),
            label({ label: logLabel, message: false }),
            timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            printf(info => `[${info.timestamp}] ${info.label}.${info.level}: ${info.message}`)
        ),
        transports: [
            new transports.Console()
        ]
    });
}

module.exports = create;