exports.handler = async function (event) {
  // Only allow POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // CORS headers so the browser fetch works
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  let subject, html;
  try {
    const body = JSON.parse(event.body);
    subject = body.subject;
    html = body.html;
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  if (!subject || !html) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'subject and html are required' }) };
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'RESEND_API_KEY environment variable not set' }) };
  }

  // Call Resend API
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'PropDesk <noreply@bentonvillelodgingcomanagement.com>',
      to: ['luke@above8capital.com'],
      subject: subject,
      html: html,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('Resend error:', data);
    return {
      statusCode: response.status,
      headers,
      body: JSON.stringify({ error: data.message || data.name || 'Resend API error' }),
    };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ success: true, id: data.id }),
  };
};
