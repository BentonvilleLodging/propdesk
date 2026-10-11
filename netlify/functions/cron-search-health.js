// Scheduled trigger → starts the get-search-health-background background function (see netlify.toml / lib/dispatch.js)
exports.handler = require('../lib/dispatch')('get-search-health-background');
