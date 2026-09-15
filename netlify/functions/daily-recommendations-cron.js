// netlify/functions/daily-recommendations-cron.js
//
// Scheduled once daily (a few minutes after get-search-health's own
// schedule, so fresh data is available first). This exists purely to
// give recommendation generation its own execution time budget, separate
// from get-search-health -- combining both into one function previously
// caused a timeout (see comment at top of get-search-health.js).
//
// get-recommendations.js itself stays unscheduled so the "Regenerate"
// button in the app can still call it directly from the browser
// (Netlify blocks direct HTTP calls to scheduled functions).

exports.handler = async function(event) {
  try {
    const siteUrl = process.env.URL || 'https://bentonvillelodgingcomanagement.com';
    const res = await fetch(`${siteUrl}/.netlify/functions/get-recommendations`);
    const text = await res.text();
    return {
      statusCode: 200,
      body: JSON.stringify({ triggered: true, recommendationsStatus: res.status, recommendationsBody: text.slice(0, 500) }),
    };
  } catch (err) {
    console.error('daily-recommendations-cron error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
