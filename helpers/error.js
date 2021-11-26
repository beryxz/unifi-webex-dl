class AuthenticationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AuthenticationError';
        Error.captureStackTrace(this, AuthenticationError);
    }
}

module.exports = {
    AuthenticationError
};
