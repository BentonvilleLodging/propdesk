// netlify/lib/dispatch.js
// Netlify scheduled functions can't be called by URL and are capped at 30s, so the
// long-running jobs are plain Background Functions (URL-callable, 15 min) and these tiny
// scheduled "cron-*" functions just kick them off with the internal key.
const { internalHeaders } = require('./auth');

module.exports = function dispatch(fnName) {
  return async function () {
    const base = process.env.URL || 'https://bentonvillelodgingcomanagement.com';
    try {
      const res = await fetch(`${base}/.netlify/functions/${fnName}`, { method: 'POST', headers: internalHeaders({ 'Content-Type': 'application/json' }), body: '{}' });
      console.log(`dispatched ${fnName}: HTTP ${res.status}`);
      return { statusCode: 200, body: JSON.stringify({ dispatched: fnName, status: res.status }) };
    } catch (e) {
      console.error(`dispatch ${fnName} failed:`, e.message);
      return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
    }
  };
};
