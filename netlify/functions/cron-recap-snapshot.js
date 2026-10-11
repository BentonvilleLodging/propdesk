// Scheduled trigger → starts the daily-recap-snapshot-background background function (see netlify.toml / lib/dispatch.js)
exports.handler = require('../lib/dispatch')('daily-recap-snapshot-background');
