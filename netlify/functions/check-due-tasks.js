// netlify/functions/check-due-tasks.js
// Called by a Netlify scheduled function once daily at 8 AM.
// Finds todos with due_date = today and fires push notifications.

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

const SUPABASE_URL = 'https://wljtpxqdmxszplngdwsc.supabase.co';
const SUPABASE_KEY = 'sb_publishable_PERqMlyz5OndCT7wVSUgGQ_T4Tpy_OQ';

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const today = new Date().toISOString().slice(0, 10);
  console.log('check-due-tasks running for date:', today);

  // Fetch todos due today that are not completed
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/todos?due_date=eq.${today}&completed=eq.false&select=*`,
    {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: 'Bearer ' + SUPABASE_KEY,
      },
    }
  );

  if (!res.ok) {
    const txt = await res.text();
    console.error('Supabase query failed:', txt);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: txt }) };
  }

  const todos = await res.json();
  console.log('Due today:', todos.length);
  if (!todos.length) return { statusCode: 200, headers: CORS, body: JSON.stringify({ sent: 0, message: 'No tasks due today.' }) };

  // Fire one push per task via send-push
  const siteUrl = process.env.URL || 'https://propdesk.netlify.app';
  let sent = 0;
  for (const todo of todos) {
    const label  = [todo.title, todo.property, todo.assigned_to].filter(Boolean).join(' · ');
    const pushRes = await fetch(`${siteUrl}/.netlify/functions/send-push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title:   '📅 Task Due Today',
        message: label,
        tag:     'todo-due-' + todo.id,
        url:     '/',
      }),
    });
    if (pushRes.ok) sent++;
    else console.warn('send-push failed for todo', todo.id, await pushRes.text());
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ sent, tasksFound: todos.length }),
  };
};
