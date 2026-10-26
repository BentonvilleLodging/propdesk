// Scheduled trigger → starts the autopilot-background background function (see netlify.toml / lib/dispatch.js)
exports.handler = require('../lib/dispatch')('autopilot-background');
