/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run "npm run dev" in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run "npm run deploy" to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

const ROUTE_KEY_PREFIX = "route:";
const E164_MIN_DIGITS = 8;
const E164_MAX_DIGITS = 15;

function okResponse() {
  return new Response("OK", { status: 200 });
}

function normalizePhoneNumber(phoneNumber) {
  if (typeof phoneNumber !== "string") return null;
  const trimmed = phoneNumber.trim();
  if (!trimmed.startsWith("+")) return null;
  const digitsOnly = trimmed.replace(/\D/g, "");
  if (
    digitsOnly.length < E164_MIN_DIGITS ||
    digitsOnly.length > E164_MAX_DIGITS
  ) {
    return null;
  }
  return `+${digitsOnly}`;
}

function getToPhone(messagePayload) {
  const to =
    (Array.isArray(messagePayload.to) && messagePayload.to[0]?.phone_number) ||
    messagePayload.to?.phone_number ||
    messagePayload.to;
  return normalizePhoneNumber(to);
}

async function getRoute(env, toPhone) {
  if (!toPhone) return null;
  const raw = await env.NUMBER_TO_EMAIL.get(`${ROUTE_KEY_PREFIX}${toPhone}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error("Invalid route config JSON:", error);
    return null;
  }
}

function buildEmailHtml(fromPhone, friendlyDate, text, mediaHtml) {
  return `<h2>New SMS Received</h2>
<p><strong>From:</strong> ${fromPhone}</p>
<p><strong>Received at:</strong> ${friendlyDate}</p>
<p><strong>Message:</strong> ${text}</p>
${mediaHtml}`;
}

function buildEmailText(fromPhone, friendlyDate, text) {
  return `New SMS Received\nFrom: ${fromPhone}\nReceived at: ${friendlyDate}\nMessage: ${text}`;
}

async function sendMailgunEmail(
  env,
  toEmail,
  fromPhone,
  friendlyDate,
  text,
  mediaHtml,
) {
  if (!toEmail) {
    console.error("Missing recipient email for forward_email route");
    return;
  }
  const html = buildEmailHtml(fromPhone, friendlyDate, text, mediaHtml);
  const plainText = buildEmailText(fromPhone, friendlyDate, text);

  const mailgunData = {
    from: `SMS Alerts <${env.FROM_EMAIL}>`,
    to: toEmail,
    subject: `New SMS from ${fromPhone}`,
    html,
    text: plainText,
  };

  const formData = new URLSearchParams(mailgunData);
  const mailgunResponse = await fetch(
    `https://api.mailgun.net/v3/${env.MAILGUN_DOMAIN}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa("api:" + env.MAILGUN_API_KEY)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formData,
    },
  );

  if (!mailgunResponse.ok) {
    console.error("Mailgun error:", await mailgunResponse.text());
  }
}

async function sendTelnyxReply(env, toPhone, fromPhone, replyText) {
  if (!env.TELNYX_API_KEY) {
    console.error("Missing TELNYX_API_KEY for auto_reply route");
    return;
  }
  const telnyxResponse = await fetch("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.TELNYX_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: toPhone,
      to: fromPhone,
      text: replyText,
    }),
  });

  if (!telnyxResponse.ok) {
    console.error("Telnyx reply error:", await telnyxResponse.text());
  }
}

async function processMedia(messagePayload) {
  let mediaHtml = "";
  const media = messagePayload.media || [];
  for (const item of media) {
    if (item?.content_type?.startsWith("image/") && item.url) {
      try {
        const response = await fetch(item.url);
        if (response.ok) {
          const arrayBuffer = await response.arrayBuffer();
          const base64Image = btoa(
            new Uint8Array(arrayBuffer).reduce(
              (data, byte) => data + String.fromCharCode(byte),
              "",
            ),
          );
          const dataUri = `data:${item.content_type};base64,${base64Image}`;
          mediaHtml += `<p><strong>Image:</strong><br><img src="${dataUri}" alt="MMS Image" style="max-width: 300px;"></p>`;
        }
      } catch (error) {
        console.error("Failed to fetch media:", error);
        mediaHtml += `<p><strong>Image:</strong> Failed to load ${item.url}</p>`;
      }
    }
  }
  return mediaHtml;
}

function getFromPhone(messagePayload) {
  const fromPhone = messagePayload?.from?.phone_number;
  return typeof fromPhone === "string" && fromPhone.length > 0
    ? fromPhone
    : "(Unknown)";
}

function getFromPhoneForReply(messagePayload) {
  return normalizePhoneNumber(messagePayload?.from?.phone_number);
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      const payload = await request.json();
      const data = payload.data;

      // Optional: Verify Telnyx webhook signature (requires env.TELNYX_PUBLIC_KEY)
      // Implement using Web Crypto API (Ed25519 verification)
      // For now, skipped for simplicity. Add if needed for security.

      // Only process inbound messages
      if (
        data.event_type !== "message.received" ||
        data.payload.direction !== "inbound"
      ) {
        return okResponse();
      }

      const messagePayload = data.payload;
      const fromPhone = getFromPhone(messagePayload);
      const fromPhoneForReply = getFromPhoneForReply(messagePayload);
      const toPhone = getToPhone(messagePayload);
      const text = messagePayload.text || "(No text)";

      if (!toPhone) {
        console.error("Missing or invalid destination phone number in payload");
        return okResponse();
      }

      const route = await getRoute(env, toPhone);
      if (!route) {
        console.error(`No route configured for destination number: ${toPhone}`);
        return okResponse();
      }

      const mode = route.mode;
      if (mode === "auto_reply") {
        if (!route.reply_text) {
          console.error("Missing reply_text for auto_reply route");
          return okResponse();
        }
        if (!fromPhoneForReply) {
          console.error("Cannot auto-reply due to invalid phone format");
          return okResponse();
        }
        await sendTelnyxReply(env, toPhone, fromPhoneForReply, route.reply_text);
      } else if (mode === "forward_email") {
        if (!route.email) {
          console.error(`Missing email in forward_email route for: ${toPhone}`);
          return okResponse();
        }
        const date = new Date(data.occurred_at);
        const friendlyDate = date.toLocaleString("en-US", {
          timeZone: "America/Chicago",
          timeZoneName: "short",
        });
        const mediaHtml = await processMedia(messagePayload);
        await sendMailgunEmail(
          env,
          route.email,
          fromPhone,
          friendlyDate,
          text,
          mediaHtml,
        );
      } else {
        console.error(`Unsupported route mode: ${mode}`);
      }

      return okResponse();
    } catch (error) {
      console.error("Worker error:", error);
      return new Response("Internal Server Error", { status: 500 });
    }
  },
};
