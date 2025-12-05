/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run "npm run dev" in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run "npm run deploy" to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */


export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      const payload = await request.json();
      const data = payload.data;

      // Optional: Verify Telnyx webhook signature (requires env.TELNYX_PUBLIC_KEY)
      // Implement using Web Crypto API (Ed25519 verification)
      // For now, skipped for simplicity. Add if needed for security.

      // Only process inbound messages
      if (data.event_type !== 'message.received' || data.payload.direction !== 'inbound') {
        return new Response('OK', { status: 200 });
      }

      const messagePayload = data.payload;
      const fromPhone = messagePayload.from.phone_number;
      const text = messagePayload.text || '(No text)';
      const timestamp = data.occurred_at;

      const date = new Date(timestamp);
      const friendlyDate = date.toLocaleString('en-US', { timeZone: 'America/Chicago', timeZoneName: 'short'});

      // Handle media (images only for simplicity)
      let mediaHtml = '';
      const media = messagePayload.media || [];
      for (const item of media) {
        if (item.content_type.startsWith('image/')) {
          try {
            const response = await fetch(item.url);
            if (response.ok) {
              const arrayBuffer = await response.arrayBuffer();
              const base64Image = btoa(
                new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
              );
              const dataUri = `data:${item.content_type};base64,${base64Image}`;
              mediaHtml += `<p><strong>Image:</strong><br><img src="${dataUri}" alt="MMS Image" style="max-width: 300px;"></p>`;
            }
          } catch (error) {
            console.error('Failed to fetch media:', error);
            mediaHtml += `<p><strong>Image:</strong> Failed to load ${item.url}</p>`;
          }
        }
      }

      // Build email body
      const emailBody = `
        <h2>New SMS Received</h2>
        <p><strong>From:</strong> ${fromPhone}</p>
        <p><strong>Received at:</strong> ${friendlyDate}</p>
        <p><strong>Message:</strong> ${text}</p>
        ${mediaHtml}
      `;

      // Prepare Mailgun payload (form-urlencoded for compatibility)
      const mailgunData = {
        from: `SMS Alerts <noreply@${env.MAILGUN_DOMAIN}>`,  // Replace with your verified sender
        to: `${env.TO_EMAIL}`,  // Replace with recipient
        subject: `New SMS from ${fromPhone}`,
        html: emailBody,
        text: emailBody.replace(/<[^>]*>/g, ''),  // Plain text fallback
      };

      // URL-encode for form data
      const formData = new URLSearchParams(mailgunData);

      // Send to Mailgun
      const mailgunResponse = await fetch(`https://api.mailgun.net/v3/${env.MAILGUN_DOMAIN}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${btoa('api:' + env.MAILGUN_API_KEY)}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData,
      });

      if (!mailgunResponse.ok) {
        console.error('Mailgun error:', await mailgunResponse.text());
        // Still return 200 to Telnyx to avoid retries, but log for debugging
      }

      return new Response('OK', { status: 200 });
    } catch (error) {
      console.error('Worker error:', error);
      return new Response('Internal Server Error', { status: 500 });
    }
  },
};
