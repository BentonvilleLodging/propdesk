// netlify/functions/daily-recommendations-cron.js
//
// Scheduled once daily (a few minutes after get-search-health's own
// schedule, so fresh data is available first). Fires the background
// function and returns immediately -- it doesn't need to wait for the
// result itself, since get-recommendations-background.js writes directly
// to Supabase when it finishes (which can take a while for ~28 listings).

exports.handler = async function(event) {
  try {
    const siteUrl = process.env.URL || 'https://bentonvillelodgingcomanagement.com';
    const res = await fetch(`${siteUrl}/.netlify/functions/get-recommendations-background`);
    return {
      statusCode: 200,
      body: JSON.stringify({ triggered: true, backgroundFunctionStatus: res.status }),
    };
  } catch (err) {
    console.error('daily-recommendations-cron error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
