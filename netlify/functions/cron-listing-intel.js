// Scheduled trigger → starts the listing-intel-analyze-background background function (see netlify.toml / lib/dispatch.js)
exports.handler = require('../lib/dispatch')('listing-intel-analyze-background');
