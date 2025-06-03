exports.handler = async function(event, context) {
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        body: JSON.stringify({ error: 'Method Not Allowed' }),
      };
    }
  
    let payload;
    try {
      payload = JSON.parse(event.body);
    } catch (e) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Invalid JSON' }),
      };
    }
  
    const text = payload.text || 'No message provided';
  
    const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
    const USER_SLACK_ID   = process.env.USER_SLACK_ID;
  
    if (!SLACK_BOT_TOKEN || !USER_SLACK_ID) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'Missing Slack credentials in environment' }),
      };
    }
  
    try {
      const slackResp = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
        },
        body: JSON.stringify({
          channel: USER_SLACK_ID,
          text: text,
        }),
      });
  
      const slackData = await slackResp.json();
      if (!slackData.ok) {
        return {
          statusCode: 500,
          body: JSON.stringify({ error: slackData.error || 'Slack API returned an error' }),
        };
      }
  
      return {
        statusCode: 200,
        body: JSON.stringify({ ok: true, ts: slackData.ts }),
      };
    } catch (err) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: err.message }),
      };
    }
  };